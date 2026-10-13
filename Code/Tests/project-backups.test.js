import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore, acquireWorkerLock } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { createAudit } from '../Application/audit.js';
import {
  backupProject,
  restoreProjectBackup,
  validateProjectBackup,
  deleteProject,
} from '../Application/project-backups.js';
import { projectLocation, listProjects } from '../Application/projects.js';
import { hash } from '../Application/profiles.js';
import { loadProfile } from './fixtures.js';

async function fixture(otherAddress) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-project-backup-'));
  const root = path.join(dir, 'Projects'),
    databaseFile = path.join(dir, 'screening.sqlite');
  const a = await loadProfile('demo', '1');
  const otherUrl =
    otherAddress ||
    'https://demo.covidence.org/reviews/999/review_studies/screen?filter=vote_required_from';
  const otherIsApp = new URL(otherUrl).hostname === 'app.covidence.org';
  const b = {
    ...a,
    profile: otherIsApp ? 'standard' : 'demo',
    dataset: otherIsApp ? 'standard-review' : 'demo-vitamin-c-common-cold',
    reviewId: new URL(otherUrl).pathname.match(/\/reviews\/(\d+)/)[1],
    reviewUrl: otherUrl,
    configHash: 'other-project',
    projectName: 'Other project',
  };
  const store = new QueueStore(databaseFile);
  const seeded = [];
  for (const config of [a, b]) {
    const folder = projectLocation(config.reviewUrl, root);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(config));
    const job = store.create(config, ['1'], 'auto-vote');
    const runId = randomUUID();
    withRecords(databaseFile, (records) => {
      records.saveRecommendation({
        record: {
          runId,
          dataset: config.dataset,
          reviewUrl: config.reviewUrl,
          studyId: '1',
          configHash: config.configHash,
          status: 'error',
        },
        study: {
          studyId: '1',
          title: config.projectName || 'First project',
          abstract: 'Local fixture',
        },
      });
      records.savePayload(runId, {
        request: { instructions: 'Saved instructions' },
        response: { status: 'completed', output: [] },
        requestVersion: '1.1.2',
      });
      records.parseAttempt(runId, '1.1.2', 'error', 'Synthetic parsing error');
      records.projectEvent(randomUUID(), config.reviewUrl, 'discovery', {
        studies: [{ studyId: '1' }],
      });
    });
    const audit = await createAudit(databaseFile, {
      reviewUrl: config.reviewUrl,
      reviewId: config.reviewId,
      studyId: '1',
    });
    await audit.save({ status: 'click_intent' });
    store.update(job.id, '1', 'needs_review', { voteRecord: audit.record, stage: 'voting' });
    seeded.push({ job, runId, audit });
  }
  store.close();
  return { dir, root, databaseFile, a, b, seeded };
}
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
}

test('project backup captures only the selected review, raw API responses and uncertain vote protection', async () => {
  const f = await fixture(),
    before = rows(f.databaseFile);
  const result = await backupProject(f.a.reviewUrl, f);
  assert.ok(
    result.file.startsWith(path.join(projectLocation(f.a.reviewUrl, f.root), 'Backups') + path.sep),
  );
  const archive = JSON.parse(await readFile(result.file, 'utf8'));
  validateProjectBackup(archive);
  assert.equal(archive.tables.jobs.length, 1);
  assert.equal(archive.tables.jobs[0].id, f.seeded[0].job.id);
  assert.equal(archive.tables.recommendation_payloads.length, 1);
  assert.equal(archive.tables.parse_attempts.length, 1);
  assert.equal(archive.tables.vote_claims.length, 1);
  assert.equal(JSON.parse(archive.tables.votes[0].record).status, 'click_intent');
  assert.ok(!(await readFile(result.file, 'utf8')).includes(f.b.reviewUrl));
  assert.deepEqual(rows(f.databaseFile), before);
  await assert.rejects(
    backupProject(f.a.reviewUrl, { ...f, destination: result.file }),
    (error) => error.code === 'EEXIST',
  );
});

test('a project can be restored independently alongside another project with colliding local audit numbers', async () => {
  const f = await fixture();
  const first = await backupProject(f.a.reviewUrl, f),
    other = await backupProject(f.b.reviewUrl, f);
  const target = {
    databaseFile: path.join(f.dir, 'recovery', 'screening.sqlite'),
    root: path.join(f.dir, 'Restored projects'),
  };
  await restoreProjectBackup(other.file, target);
  const before = rows(target.databaseFile);
  await restoreProjectBackup(first.file, target);
  const store = new QueueStore(target.databaseFile);
  try {
    assert.deepEqual(store.settings(f.seeded[0].job.id), f.a);
    assert.equal(store.item(f.seeded[0].job.id, '1').state, 'needs_review');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM parse_attempts').get().n, 2);
    assert.deepEqual(
      store.db.prepare('SELECT * FROM jobs WHERE id=?').get(f.seeded[1].job.id),
      before.jobs[0],
    );
  } finally {
    store.close();
  }
  assert.equal(
    withRecords(target.databaseFile, (s) => s.existingVote(f.a, '1')).record.status,
    'click_intent',
  );
  assert.equal(
    withRecords(target.databaseFile, (s) => s.payload(f.seeded[0].runId)).request.instructions,
    'Saved instructions',
  );
  assert.equal((await listProjects(target)).length, 2);
  const restored = rows(target.databaseFile);
  await restoreProjectBackup(first.file, target);
  assert.deepEqual(rows(target.databaseFile), restored);
});

test('restore refuses conflicting newer records atomically without affecting another project', async () => {
  const f = await fixture(),
    result = await backupProject(f.a.reviewUrl, f);
  await f.seeded[0].audit.save({ status: 'confirmed' });
  const before = rows(f.databaseFile);
  await assert.rejects(restoreProjectBackup(result.file, f), /Existing votes record differs/);
  assert.deepEqual(rows(f.databaseFile), before);
  const settingsFile = path.join(projectLocation(f.a.reviewUrl, f.root), 'Project settings.json');
  await writeFile(settingsFile, JSON.stringify({ ...f.a, projectName: 'Updated name' }));
  await assert.rejects(restoreProjectBackup(result.file, f), /settings differ/);
  await assert.rejects(
    restoreProjectBackup(result.file, { ...f, keepExistingSettings: true }),
    /Existing votes record differs/,
  );
  assert.deepEqual(rows(f.databaseFile), before);
});

test('keeping current settings still rejects settings for a different review', async () => {
  const f = await fixture(),
    result = await backupProject(f.a.reviewUrl, f);
  const settingsFile = path.join(projectLocation(f.a.reviewUrl, f.root), 'Project settings.json');
  await writeFile(settingsFile, JSON.stringify(f.b));
  const before = rows(f.databaseFile);
  await assert.rejects(
    restoreProjectBackup(result.file, { ...f, keepExistingSettings: true }),
    /settings belong to a different project/,
  );
  assert.deepEqual(rows(f.databaseFile), before);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), f.b);
});

test('damaged or mixed-project backups are rejected before changing the destination', async () => {
  const f = await fixture(),
    result = await backupProject(f.a.reviewUrl, f);
  const archive = JSON.parse(await readFile(result.file, 'utf8'));
  archive.settings.projectName = 'Changed';
  assert.throws(() => validateProjectBackup(archive), /checksum/);
  archive.tables.project_events[0].review_url = f.b.reviewUrl;
  const { checksum, ...payload } = archive;
  archive.checksum = hash(payload);
  assert.throws(() => validateProjectBackup(archive), /another review/);
  const bad = path.join(f.dir, 'bad.json');
  await writeFile(bad, JSON.stringify(archive));
  const destination = path.join(f.dir, 'untouched.sqlite');
  await assert.rejects(
    restoreProjectBackup(bad, { databaseFile: destination, root: path.join(f.dir, 'untouched') }),
  );
  await assert.rejects(access(destination), (error) => error.code === 'ENOENT');
});

test('empty projects can be backed up and project maintenance respects an active worker', async () => {
  const f = await fixture(),
    config = {
      ...f.a,
      reviewId: '1234',
      reviewUrl:
        'https://demo.covidence.org/reviews/1234/review_studies/screen?filter=vote_required_from',
    };
  const folder = projectLocation(config.reviewUrl, f.root);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(config));
  const result = await backupProject(config.reviewUrl, f);
  assert.equal(result.jobs, 0);
  const release = await acquireWorkerLock(path.dirname(f.databaseFile));
  try {
    await assert.rejects(backupProject(config.reviewUrl, f), /Another queue worker/);
    await assert.rejects(restoreProjectBackup(result.file, f), /Another queue worker/);
  } finally {
    await release();
  }
});

test('deleting a project removes only its local records and folder, and an external backup can restore it', async () => {
  const f = await fixture();
  const indexFile = path.join(f.dir, 'projects.json');
  const folder = projectLocation(f.a.reviewUrl, f.root);
  await writeFile(
    indexFile,
    JSON.stringify({
      active: 'demo',
      demo: path.relative(f.root, path.join(folder, 'Project settings.json')),
    }),
  );
  await writeFile(path.join(folder, 'Decision History.xlsx'), 'Synthetic export');
  const db = new DatabaseSync(f.databaseFile);
  for (const [i, config] of [f.a, f.b].entries()) {
    db.prepare('INSERT INTO project_exports VALUES (?,?)').run(config.reviewUrl, 'snapshot');
    db.prepare('INSERT INTO verification_locks VALUES (?,?,?,?)').run(
      f.seeded[i].audit.record.attemptId,
      'token',
      123,
      'fixture',
    );
  }
  db.close();
  const backup = await backupProject(f.a.reviewUrl, {
    ...f,
    destination: path.join(f.dir, 'external-backup.json'),
  });
  const archive = JSON.parse(await readFile(backup.file, 'utf8'));
  const before = rows(f.databaseFile);
  const otherFile = path.join(projectLocation(f.b.reviewUrl, f.root), 'Project settings.json');
  const otherSettings = await readFile(otherFile, 'utf8');
  const result = await deleteProject(f.a.reviewUrl, { ...f, indexFile });
  assert.equal(result.cleanupPending, undefined);
  await assert.rejects(access(folder), (error) => error.code === 'ENOENT');
  assert.equal(await readFile(otherFile, 'utf8'), otherSettings);
  const expected = Object.fromEntries(
    Object.entries(before).map(([name, entries]) => {
      const deleted = new Set((archive.tables[name] || []).map((row) => JSON.stringify(row)));
      return [
        name,
        entries.filter(
          (row) =>
            !deleted.has(JSON.stringify(row)) &&
            !(name === 'project_exports' && row.review_url === f.a.reviewUrl) &&
            !(
              name === 'verification_locks' && row.attempt_id === f.seeded[0].audit.record.attemptId
            ),
        ),
      ];
    }),
  );
  assert.deepEqual(rows(f.databaseFile), expected);
  assert.equal(JSON.parse(await readFile(indexFile, 'utf8')).demo, undefined);
  assert.deepEqual(
    (await listProjects(f)).map((p) => p.reviewUrl),
    [f.b.reviewUrl],
  );
  await restoreProjectBackup(backup.file, f);
  assert.equal((await listProjects(f)).length, 2);
  assert.equal(
    withRecords(f.databaseFile, (records) => records.existingVote(f.a, '1')).record.status,
    'click_intent',
  );
});

test('a failed deletion restores the folder and rolls back every database change', async () => {
  const f = await fixture();
  const folder = projectLocation(f.a.reviewUrl, f.root);
  const indexFile = path.join(f.dir, 'projects.json');
  const index = JSON.stringify({
    active: 'demo',
    demo: path.relative(f.root, path.join(folder, 'Project settings.json')),
  });
  await writeFile(indexFile, index);
  const settings = await readFile(path.join(folder, 'Project settings.json'), 'utf8');
  const before = rows(f.databaseFile);
  const db = new DatabaseSync(f.databaseFile);
  db.exec(
    "CREATE TRIGGER reject_deletion BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'Synthetic delete failure'); END",
  );
  db.close();
  await assert.rejects(
    deleteProject(f.a.reviewUrl, { ...f, indexFile }),
    /Synthetic delete failure/,
  );
  assert.deepEqual(rows(f.databaseFile), before);
  assert.equal(await readFile(path.join(folder, 'Project settings.json'), 'utf8'), settings);
  assert.equal(await readFile(indexFile, 'utf8'), index);
  assert.ok((await readdir(f.root)).every((name) => !name.startsWith('.deleting-')));
  const release = await acquireWorkerLock(f.dir);
  await release();
});

test('deletion keeps a matching review number on another host and a longer review number separate', async () => {
  const config = await loadProfile('demo', '1');
  for (const address of [
    `https://app.covidence.org/reviews/${config.reviewId}/review_studies/screen?filter=vote_required_from`,
    `https://demo.covidence.org/reviews/${config.reviewId}0/review_studies/screen?filter=vote_required_from`,
  ]) {
    const f = await fixture(address);
    await deleteProject(f.a.reviewUrl, { ...f, indexFile: path.join(f.dir, 'projects.json') });
    assert.deepEqual(
      (await listProjects(f)).map((p) => p.reviewUrl),
      [f.b.reviewUrl],
    );
    const remaining = rows(f.databaseFile);
    assert.equal(remaining.jobs.length, 1);
    assert.equal(remaining.jobs[0].id, f.seeded[1].job.id);
    assert.equal(remaining.votes.length, 1);
    assert.equal(JSON.parse(remaining.votes[0].record).reviewUrl, f.b.reviewUrl);
    assert.equal(
      withRecords(f.databaseFile, (records) => records.existingVote(f.b, '1')).record.status,
      'click_intent',
    );
  }
});

test('deletion supports empty or broken projects without creating a database and respects an active worker', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-empty-deletion-'));
  const options = {
    root: path.join(dir, 'Projects'),
    databaseFile: path.join(dir, 'screening.sqlite'),
    indexFile: path.join(dir, 'projects.json'),
  };
  const url = 'https://demo.covidence.org/reviews/999/review_studies/screen';
  const folder = projectLocation(url, options.root);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Project settings.json'), '{broken');
  const release = await acquireWorkerLock(dir);
  try {
    await assert.rejects(deleteProject(url, options), /Another queue worker/);
    await access(folder);
  } finally {
    await release();
  }
  await deleteProject(url, options);
  await assert.rejects(access(folder), (error) => error.code === 'ENOENT');
  await assert.rejects(access(options.databaseFile), (error) => error.code === 'ENOENT');
  assert.deepEqual(await listProjects(options), []);
});

test('deletion rejects project junctions and does not follow a junction inside a project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-deletion-path-'));
  const options = {
    root: path.join(dir, 'Projects'),
    databaseFile: path.join(dir, 'screening.sqlite'),
    indexFile: path.join(dir, 'projects.json'),
  };
  const url = 'https://demo.covidence.org/reviews/999/review_studies/screen';
  const folder = projectLocation(url, options.root);
  const external = path.join(dir, 'Keep this folder');
  await mkdir(options.root);
  await mkdir(external);
  await writeFile(path.join(external, 'keep.txt'), 'Keep this file');
  await symlink(external, folder, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(deleteProject(url, options), /regular directory/);
  const otherUrl = 'https://demo.covidence.org/reviews/888/review_studies/screen';
  const other = projectLocation(otherUrl, options.root);
  await mkdir(other);
  await symlink(
    external,
    path.join(other, 'Linked folder'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await deleteProject(otherUrl, options);
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'Keep this file');
  await access(folder);
});
