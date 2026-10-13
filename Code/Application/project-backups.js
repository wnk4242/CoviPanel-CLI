import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  readFile,
  mkdir,
  writeFile,
  unlink,
  link,
  lstat,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { databasePath, projectsDir, profilesIndex, screeningAddress } from './config.js';
import { openDatabase, SCHEMA_VERSION } from './database.js';
import { acquireWorkerLock } from './queue-store.js';
import { projectLocation, readProject } from './projects.js';
import { reviewKey } from './project-history.js';
import { hash } from './profiles.js';

// Exported caches and process locks are derived/temporary. All durable project
// records, including failed attempts, raw API payloads and claims, are retained.
const tables = {
  jobs: ['id'],
  job_settings: ['job_id'],
  items: ['job_id', 'study_id'],
  events: null,
  recommendations: ['run_id'],
  recommendation_payloads: ['run_id'],
  parse_attempts: null,
  votes: ['attempt_id'],
  vote_claims: ['claim_key'],
  project_events: ['event_id'],
};
const sameReview = (a, b) => reviewKey(a) === reviewKey(b);
const claimPrefix = (url) => {
  const key = reviewKey(url);
  return `${new URL(key).hostname}-${key.split('/').at(-1)}-`;
};

function projectRows(db, url) {
  const all = (name) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
  const jobs = all('jobs').filter((row) => sameReview(row.review_url, url));
  const jobIds = new Set(jobs.map((row) => row.id));
  const recommendations = all('recommendations').filter((row) => sameReview(row.review_url, url));
  const runIds = new Set(recommendations.map((row) => row.run_id));
  const vote_claims = all('vote_claims').filter((row) =>
    row.claim_key.startsWith(claimPrefix(url)),
  );
  const claimed = new Set(vote_claims.map((row) => row.attempt_id));
  return {
    jobs,
    job_settings: all('job_settings').filter((row) => jobIds.has(row.job_id)),
    items: all('items').filter((row) => jobIds.has(row.job_id)),
    events: all('events').filter((row) => jobIds.has(row.job_id)),
    recommendations,
    recommendation_payloads: all('recommendation_payloads').filter((row) => runIds.has(row.run_id)),
    parse_attempts: all('parse_attempts').filter((row) => runIds.has(row.run_id)),
    votes: all('votes').filter(
      (row) => claimed.has(row.attempt_id) || sameReview(JSON.parse(row.record).reviewUrl, url),
    ),
    vote_claims,
    project_events: all('project_events').filter((row) => sameReview(row.review_url, url)),
  };
}

// Called only after the menu's explicit confirmation. Stage the folder on the
// same volume so ordinary failures can restore it while SQLite rolls back.
export async function deleteProject(
  url,
  { databaseFile = databasePath, root = projectsDir, indexFile = profilesIndex } = {},
) {
  url = screeningAddress(url);
  const release = await acquireWorkerLock(path.dirname(databaseFile));
  let db, staged, originalFolder, indexBefore;
  let transaction = false,
    moved = false,
    indexChanged = false;
  const indexTemp = `${indexFile}.${randomUUID()}.tmp`;
  try {
    const realRoot = await realpath(root);
    originalFolder = path.resolve(projectLocation(url, root));
    const entry = await lstat(originalFolder);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('The project folder must be a regular directory.');
    const folder = await realpath(originalFolder);
    if (
      path.dirname(folder) !== realRoot ||
      path.basename(folder) !== path.basename(originalFolder)
    )
      throw new Error('The project folder is outside Covidence Projects.');
    originalFolder = folder;
    staged = path.join(realRoot, `.deleting-${path.basename(folder)}-${randomUUID()}`);
    let indexAfter;
    try {
      indexBefore = await readFile(indexFile, 'utf8');
      const index = JSON.parse(indexBefore);
      for (const key of ['demo', 'standard']) {
        if (
          typeof index[key] === 'string' &&
          path.resolve(root, index[key]) ===
            path.join(path.resolve(projectLocation(url, root)), 'Project settings.json')
        )
          delete index[key];
      }
      if (!index[index.active])
        index.active = ['demo', 'standard'].find((key) => index[key]) || 'demo';
      if (JSON.stringify(index) !== JSON.stringify(JSON.parse(indexBefore)))
        indexAfter = JSON.stringify(index, null, 2) + '\n';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existsSync(databaseFile)) {
      db = openDatabase(databaseFile);
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
    }
    await rename(folder, staged);
    moved = true;
    if (db) {
      const rows = projectRows(db, url);
      for (const vote of rows.votes)
        db.prepare('DELETE FROM verification_locks WHERE attempt_id=?').run(vote.attempt_id);
      for (const claim of rows.vote_claims)
        db.prepare('DELETE FROM verification_locks WHERE attempt_id=?').run(claim.attempt_id);
      // Children precede parents; the shared backup selector also handles old URL forms.
      for (const [name, selected] of Object.entries(rows).reverse()) {
        const keys = tables[name] || ['id'];
        const remove = db.prepare(
          `DELETE FROM ${name} WHERE ${keys.map((key) => `${key}=?`).join(' AND ')}`,
        );
        for (const row of selected) remove.run(...keys.map((key) => row[key]));
      }
      for (const row of db.prepare('SELECT review_url FROM project_exports').all())
        if (sameReview(row.review_url, url))
          db.prepare('DELETE FROM project_exports WHERE review_url=?').run(row.review_url);
    }
    if (indexAfter) {
      await writeFile(indexTemp, indexAfter, { flag: 'wx' });
      await rename(indexTemp, indexFile);
      indexChanged = true;
    }
    if (transaction) {
      db.exec('COMMIT');
      transaction = false;
    }
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if (moved) await rename(staged, originalFolder);
    if (indexChanged) {
      await writeFile(indexTemp, indexBefore);
      await rename(indexTemp, indexFile);
    }
    throw error;
  } finally {
    try {
      db?.close();
      await unlink(indexTemp).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      await release();
    }
  }
  try {
    // Only this operation's validated, directly contained staging folder is removed.
    if (
      (await lstat(staged)).isSymbolicLink() ||
      path.dirname(await realpath(staged)) !== path.dirname(originalFolder)
    )
      throw new Error('The deletion staging folder changed.');
    await rm(staged, { recursive: true, force: true, maxRetries: 2 });
    return { folder: originalFolder };
  } catch {
    return { folder: originalFolder, cleanupPending: staged };
  }
}

export function validateProjectBackup(archive) {
  const { checksum, ...payload } = archive;
  if (
    payload.format !== 'CoviPanel project backup' ||
    payload.version !== 1 ||
    payload.schemaVersion !== SCHEMA_VERSION ||
    hash(payload) !== checksum
  )
    throw new Error('Project backup format, version or checksum is invalid.');
  const url = screeningAddress(payload.reviewUrl);
  if (screeningAddress(payload.settings?.reviewUrl) !== url)
    throw new Error('Backup settings belong to a different project.');
  const rows = payload.tables;
  if (
    !rows ||
    Object.keys(rows).length !== Object.keys(tables).length ||
    Object.keys(tables).some((name) => !Array.isArray(rows[name]))
  )
    throw new Error('Project backup tables are incomplete.');
  const own = (address) => {
    if (!sameReview(address, url)) throw new Error('Project backup contains another review.');
  };
  for (const name of ['jobs', 'recommendations', 'project_events'])
    for (const row of rows[name]) own(row.review_url);
  const jobs = new Set(rows.jobs.map((row) => row.id));
  const runs = new Set(rows.recommendations.map((row) => row.run_id));
  for (const name of ['job_settings', 'items', 'events'])
    for (const row of rows[name])
      if (!jobs.has(row.job_id)) throw new Error('Backup contains an unrelated screening record.');
  for (const row of rows.job_settings) own(JSON.parse(row.config).reviewUrl);
  for (const row of rows.recommendations) own(JSON.parse(row.record).reviewUrl);
  for (const name of ['recommendation_payloads', 'parse_attempts'])
    for (const row of rows[name])
      if (!runs.has(row.run_id)) throw new Error('Backup contains an unrelated API response.');
  for (const row of rows.votes) own(JSON.parse(row.record).reviewUrl);
  for (const row of rows.vote_claims)
    if (!row.claim_key.startsWith(claimPrefix(url)))
      throw new Error('Backup contains another project’s vote claim.');
  return payload;
}

export async function backupProject(
  url,
  { databaseFile = databasePath, root = projectsDir, destination } = {},
) {
  const release = await acquireWorkerLock(path.dirname(databaseFile));
  let db;
  try {
    const project = await readProject(url, { root });
    // An empty project is still a useful settings backup.
    db = openDatabase(databaseFile);
    db.exec('BEGIN');
    const payload = {
      format: 'CoviPanel project backup',
      version: 1,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      reviewUrl: project.reviewUrl,
      settings: project.settings,
      tables: projectRows(db, project.reviewUrl),
    };
    db.exec('COMMIT');
    const archive = { ...payload, checksum: hash(payload) };
    validateProjectBackup(archive);
    const file =
      destination ||
      path.join(
        project.folder,
        'Backups',
        `project-${payload.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.covipanel.json`,
      );
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(archive, null, 2) + '\n', { flag: 'wx' });
      validateProjectBackup(JSON.parse(await readFile(temporary, 'utf8')));
      await link(temporary, file); // Publish only a complete, verified backup; never overwrite.
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return { file, jobs: payload.tables.jobs.length, claims: payload.tables.vote_claims.length };
  } finally {
    db?.close();
    await release();
  }
}

// Restore is additive. Identical records are idempotent; a divergent existing
// record aborts the transaction, so an older backup cannot roll back newer votes.
// Integer audit IDs are local database identities and are reassigned on import.
export async function restoreProjectBackup(
  file,
  {
    databaseFile = databasePath,
    root = projectsDir,
    keepExistingSettings = false,
    workerLockHeld = false,
  } = {},
) {
  const archive = validateProjectBackup(JSON.parse(await readFile(file, 'utf8')));
  // Only coordinated sync supplies this flag while holding both drive locks.
  const release = workerLockHeld
    ? async () => {}
    : await acquireWorkerLock(path.dirname(databaseFile));
  const settingsFile = path.join(projectLocation(archive.reviewUrl, root), 'Project settings.json');
  let db,
    createdSettings = false,
    transaction = false;
  try {
    const settingsExist = existsSync(settingsFile);
    if (settingsExist) {
      const currentSettings = JSON.parse(await readFile(settingsFile, 'utf8'));
      if (screeningAddress(currentSettings.reviewUrl) !== screeningAddress(archive.reviewUrl))
        throw new Error('Existing project settings belong to a different project.');
      // Record sync preserves this device's current settings. Imported batches
      // still carry their exact original settings and all record-conflict checks.
      // Ordinary backup restore continues to require matching settings.
      if (!keepExistingSettings && hash(currentSettings) !== hash(archive.settings))
        throw new Error(
          'Existing project settings differ. Restore to a separate recovery location for inspection.',
        );
    }
    db = openDatabase(databaseFile);
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    // Reset and cancellation remove active rows deliberately. Refuse stale additive imports in either
    // direction, rather than resurrecting removed recommendations or losing new votes.
    const resetEvents = [
      ...db
        .prepare("SELECT * FROM project_events WHERE kind IN ('study_reset','batch_cancelled')")
        .all(),
      ...archive.tables.project_events.filter((e) =>
        ['study_reset', 'batch_cancelled'].includes(e.kind),
      ),
    ];
    for (const event of resetEvents) {
      if (!sameReview(event.review_url, archive.reviewUrl)) continue;
      const reset = JSON.parse(event.data);
      const conflict =
        event.kind === 'batch_cancelled'
          ? 'Backup conflicts with a cancelled batch. Restore separately for reconciliation; cancelled responses were not revived.'
          : 'Backup conflicts with a verified study reset. Restore separately for reconciliation; old records were not revived.';
      if (event.kind === 'batch_cancelled') {
        const removed = new Set(reset.runIds);
        const edits = [
          ...db
            .prepare("SELECT * FROM project_events WHERE kind='history_rationales_edited'")
            .all(),
          ...archive.tables.project_events.filter((e) => e.kind === 'history_rationales_edited'),
        ];
        if (edits.some((e) => JSON.parse(e.data).edits?.some((edit) => removed.has(edit.runId))))
          throw new Error(conflict);
      }
      for (const [jobId, studyId] of reset.itemKeys || []) {
        if (
          db.prepare('SELECT 1 FROM items WHERE job_id=? AND study_id=?').get(jobId, studyId) ||
          archive.tables.items.some((r) => r.job_id === jobId && r.study_id === studyId)
        )
          throw new Error(conflict);
      }
      for (const [table, key, ids] of [
        ['recommendations', 'run_id', reset.runIds || []],
        ['votes', 'attempt_id', reset.voteIds || []],
      ])
        for (const id of ids) {
          if (
            db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(id) ||
            archive.tables[table].some((r) => r[key] === id)
          )
            throw new Error(conflict);
        }
    }
    for (const [name, keys] of Object.entries(tables)) {
      const columns = db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((row) => row.name);
      for (const row of archive.tables[name]) {
        if (
          Object.keys(row).length !== columns.length ||
          columns.some((column) => !Object.hasOwn(row, column))
        )
          throw new Error(`Invalid columns in backup table ${name}.`);
        const used = keys ? columns : columns.filter((column) => column !== 'id');
        const lookup = keys || used;
        const existing = db
          .prepare(
            `SELECT * FROM ${name} WHERE ${lookup.map((column) => `${column} IS ?`).join(' AND ')}`,
          )
          .get(...lookup.map((column) => row[column]));
        if (existing) {
          if (used.some((column) => existing[column] !== row[column]))
            throw new Error(
              `Existing ${name} record differs. Restore to a separate recovery location for inspection.`,
            );
          continue;
        }
        db.prepare(
          `INSERT INTO ${name} (${used.join(',')}) VALUES (${used.map(() => '?').join(',')})`,
        ).run(...used.map((column) => row[column]));
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Restored project has incomplete record references.');
    if (!settingsExist) {
      await mkdir(path.dirname(settingsFile), { recursive: true });
      const temporary = `${settingsFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(archive.settings, null, 2) + '\n', {
          flag: 'wx',
        });
        await link(temporary, settingsFile);
        createdSettings = true;
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    db.exec('COMMIT');
    transaction = false;
    return { settingsFile, reviewUrl: archive.reviewUrl, jobs: archive.tables.jobs.length };
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if (createdSettings) await unlink(settingsFile);
    throw error;
  } finally {
    db?.close();
    await release();
  }
}
