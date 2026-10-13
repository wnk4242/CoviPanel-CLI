import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords, claimKey } from '../Application/records.js';
import { readUnfinished, reviewUnfinished } from '../Application/unfinished-review.js';
import { resetUnfinished, confirmManualReset } from '../Application/reset-unfinished.js';
import { exportProjectHistory } from '../Application/history-export.js';
import { listProjects, projectLocation } from '../Application/projects.js';
import { backupProject, restoreProjectBackup } from '../Application/project-backups.js';
import { readProjectHistory } from '../Application/project-history.js';
import { loadProfile } from './fixtures.js';

async function fixture(ids = ['1']) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-unfinished-'));
  const databaseFile = path.join(folder, 'screening.sqlite');
  const config = await loadProfile('demo', '1');
  const store = new QueueStore(databaseFile);
  const job = store.create(config, ids, 'auto-vote');
  store.update(job.id, '1', 'needs_review', {
    stage: 'voting',
    error: 'No vote control found.',
    study: { title: 'Synthetic stopped study' },
    recommendationRecord: { runId: 'r1', status: 'recommended', decision: 'Exclude' },
    voteRecord: { attemptId: 'v1', status: 'blocked_before_click' },
  });
  store.close();
  withRecords(databaseFile, (s) => {
    s.saveRecommendation({
      record: {
        runId: 'r1',
        dataset: config.dataset,
        configHash: config.configHash,
        reviewUrl: config.reviewUrl,
        studyId: '1',
        status: 'recommended',
        decision: 'Exclude',
        rationale: 'Full original rationale.',
        createdAt: '2026-09-20T10:00:00Z',
      },
      parsed: { ResponseText: 'Full saved response.' },
    });
    s.saveVote({
      attemptId: 'v1',
      reviewUrl: config.reviewUrl,
      studyId: '1',
      status: 'blocked_before_click',
      decision: 'Exclude',
      createdAt: '2026-09-20T10:00:00Z',
    });
  });
  return {
    folder,
    databaseFile,
    config,
    job,
    project: { name: 'Fixture project', reviewUrl: config.reviewUrl, folder },
  };
}
function scripted(values) {
  return async () => {
    assert(values.length, 'Unexpected prompt');
    return values.shift();
  };
}

test('unfinished reader exposes old settings, saved response and canonical vote without changing records', async () => {
  const f = await fixture(['1', '2']);
  const store = new QueueStore(f.databaseFile);
  const completed = store.create(f.config, ['3'], 'recommend-only');
  store.update(completed.id, '3', 'recommended', {});
  const hidden = store.create(f.config, ['4'], 'auto-vote');
  const other = store.create(
    { ...f.config, reviewUrl: f.config.reviewUrl.replace('/160676/', '/999/') },
    ['5'],
    'auto-vote',
  );
  store.close();
  withRecords(f.databaseFile, (s) => {
    s.projectEvent('hidden', f.config.reviewUrl, 'batch_cleared', { jobId: hidden.id });
    s.saveVote({
      attemptId: 'v1',
      reviewUrl: f.config.reviewUrl,
      studyId: '1',
      status: 'uncertain',
      clickedAt: '2026-09-20T10:01:00Z',
    });
    s.db.prepare('INSERT INTO vote_claims VALUES (?,?)').run(claimKey(f.config, '1'), 'v1');
  });
  const before = await readFile(f.databaseFile);
  const entries = readUnfinished(f.databaseFile, f.config.reviewUrl);
  assert.deepEqual(
    entries.map((e) => e.item.study_id),
    ['1', '2'],
  );
  assert.equal(entries[0].parsed.ResponseText, 'Full saved response.');
  assert.equal(entries[0].vote.status, 'uncertain');
  assert.equal(entries[0].claimed, true);
  assert(!entries.some((e) => e.job.id === other.id));
  assert.deepEqual(await readFile(f.databaseFile), before);
});

test('menu shows older-settings problem and full details, never resumes or requests AI on open', async () => {
  const f = await fixture();
  const screens = [],
    views = [];
  await reviewUnfinished(f.project, scripted(['1', '1', '0']), {
    ...f,
    load: async () => ({ ...f.config, configHash: 'new-settings' }),
    show: (_t, lines) => screens.push(lines.join('\n')),
    view: async (lines) => views.push(lines.join('\n')),
    run: () => assert.fail('Viewing must not run a worker'),
  });
  assert(screens.some((s) => s.includes('Older settings:')));
  assert.match(views[0], /Full saved response/);
  assert.match(views[0], /No vote control found/);
  assert.match(views[0], /Older or unavailable/);
  assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 1);
});

test('menu has one Reset action, dispatches only reset and respects confirmation/browser cancellation', async () => {
  const f = await fixture();
  const screens = [],
    calls = [];
  let browsers = 0;
  await reviewUnfinished(
    f.project,
    scripted(['1', '2', 'no', '1', '2', 'RESET 1', '1', '2', 'RESET 1', '', '0']),
    {
      ...f,
      load: async () => f.config,
      show: (_t, lines) => screens.push(lines.join('\n')),
      view: () => assert.fail(),
      chooseBrowserMode: async () => (++browsers === 1 ? null : 'headless'),
      run: async (_s, args) => {
        calls.push(args);
        return 0;
      },
    },
  );
  assert(screens.some((s) => s.includes('2. Reset (check Covidence first)')));
  assert(screens.every((s) => !/Prepare stopped|Skip this|Reprocess saved/.test(s)));
  assert.deepEqual(calls, [['reset', '--job', f.job.id, '--study', '1', '--browser', 'headless']]);
});

test('unfinished list paginates without truncating the choices', async () => {
  const f = await fixture(['1', '2', '3', '4', '5', '6']);
  let viewed;
  await reviewUnfinished(f.project, scripted(['n', '6', '1', 'p', '0']), {
    ...f,
    load: async () => f.config,
    show: () => {},
    view: async (lines) => (viewed = lines),
    run: () => assert.fail(),
  });
  assert.match(viewed[0], /Study #6/);
});

function evidence(f, outcome, extras = {}) {
  return {
    outcome,
    reviewUrl: f.config.reviewUrl,
    studyId: '1',
    title: 'Synthetic stopped study',
    reviewerIdentity: { name: 'Fixture reviewer' },
    checkedAt: new Date().toISOString(),
    ...extras,
  };
}
async function reset(f, verify, options = {}) {
  const store = new QueueStore(f.databaseFile);
  try {
    return await resetUnfinished({
      store,
      job: f.job,
      studyId: '1',
      config: f.config,
      folder: f.folder,
      verify,
      ...options,
    });
  } finally {
    store.close();
  }
}

test('verified absence removes records, cache and flags, refreshes history and preserves recovery evidence and today count', async () => {
  const f = await fixture(['1', '2']);
  const root = path.join(f.folder, 'Projects');
  const project = projectLocation(f.config.reviewUrl, root);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'Project settings.json'), JSON.stringify(f.config));
  const now = new Date();
  withRecords(f.databaseFile, (s) => {
    const saved = s.recommendation('r1');
    s.saveRecommendation({
      ...saved,
      record: { ...saved.record, deviceId: 'this-laptop', createdAt: now.toISOString() },
    });
    s.savePayload('r1', { request: { test: true }, response: { text: 'Full original response' } });
    s.parseAttempt('r1', 'test', 'ok');
    s.db.prepare('INSERT INTO vote_claims VALUES (?,?)').run(claimKey(f.config, '1'), 'v1');
  });
  const options = { root, databaseFile: f.databaseFile, now, deviceId: 'this-laptop' };
  assert.equal((await listProjects(options))[0].localScreened.today, 1);
  const result = await reset(f, async () => evidence(f, 'not_voted'));
  assert.equal(result.outcome, 'not_voted');
  assert.deepEqual(
    readUnfinished(f.databaseFile, f.config.reviewUrl).map((e) => e.item.study_id),
    ['2'],
  );
  withRecords(f.databaseFile, (s) => {
    assert.equal(s.recommendationIds(f.config, '1').length, 0);
    assert.equal(s.recommendationAttempts(f.config, '1').length, 0);
    assert.equal(s.existingVote(f.config, '1'), null);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM recommendation_payloads').get().n, 0);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM parse_attempts').get().n, 0);
    assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
  await exportProjectHistory(f.databaseFile, f.config.reviewUrl, { folder: f.folder });
  const history = readProjectHistory(f.databaseFile, f.config.reviewUrl);
  assert.deepEqual(
    history.studies.map((s) => s.id),
    ['2'],
  );
  assert(!history.log.includes('Full original rationale'));
  assert.match(history.log, /reset after Covidence confirmed no vote/);
  const files = await readdir(path.join(f.folder, 'Backups'));
  const backup = JSON.parse(await readFile(path.join(f.folder, 'Backups', files[0]), 'utf8'));
  assert.equal(backup.tables.recommendations.length, 1);
  assert.equal(backup.tables.recommendation_payloads.length, 1);
  const after = (await listProjects(options))[0];
  assert.equal(after.historyTotal, history.rows.length - 1);
  assert.equal(after.attention, 0);
  assert.equal(after.localScreened.today, 1, 'Reset must not erase actual work done today');
});

test('verified existing vote keeps recommendation and old audit, protects against repeat vote and clears matching flag', async () => {
  const f = await fixture();
  const original = withRecords(f.databaseFile, (s) => s.vote('v1'));
  const result = await reset(f, async () => evidence(f, 'voted', { recordedVote: 'No' }));
  assert.equal(result.outcome, 'voted');
  assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 0);
  withRecords(f.databaseFile, (s) => {
    assert.deepEqual(s.vote('v1'), original, 'Pre-click audit must not be rewritten as submitted');
    assert.equal(s.recommendation('r1').record.rationale, 'Full original rationale.');
    const vote = s.existingVote(f.config, '1').record;
    assert.equal(vote.recordedVote, 'No');
    assert.equal(vote.status, 'confirmed');
    assert.equal(vote.deviceId, undefined);
    assert.equal(vote.createdAt, undefined, 'Observation must not count as screening today');
  });
});

test('different actual vote is retained for review instead of deleting or claiming the saved Exclude was submitted', async () => {
  const f = await fixture();
  await reset(f, async () => evidence(f, 'voted', { recordedVote: 'Yes' }));
  const entry = readUnfinished(f.databaseFile, f.config.reviewUrl)[0];
  assert.equal(entry.vote.recordedVote, 'Yes');
  assert.equal(entry.vote.status, 'mismatch');
  assert.equal(entry.record.decision, 'Exclude');
});

test('inconclusive, contradictory, missing-audit, stale and cross-review checks never delete', async () => {
  for (const kind of ['uncertain', 'confirmed', 'stale', 'wrong-review', 'missing', 'changed']) {
    const f = await fixture();
    if (kind === 'confirmed')
      withRecords(f.databaseFile, (s) =>
        s.saveVote({ ...s.vote('v1').record, status: 'confirmed', recordedVote: 'No' }),
      );
    if (kind === 'missing')
      withRecords(f.databaseFile, (s) => s.db.prepare('DELETE FROM votes').run());
    const before = readProjectHistory(f.databaseFile, f.config.reviewUrl).rows;
    const action = () =>
      reset(f, async () => {
        if (kind === 'changed')
          withRecords(f.databaseFile, (s) =>
            s.saveRecommendation({
              ...s.recommendation('r1'),
              record: { ...s.recommendation('r1').record, rationale: 'New information' },
            }),
          );
        return evidence(f, kind === 'uncertain' ? 'uncertain' : 'not_voted', {
          ...(kind === 'stale' ? { checkedAt: '2000-01-01T00:00:00Z' } : {}),
          ...(kind === 'wrong-review'
            ? { reviewUrl: 'https://demo.covidence.org/reviews/999' }
            : {}),
        });
      });
    if (['stale', 'wrong-review', 'missing', 'changed'].includes(kind))
      await assert.rejects(action);
    else assert.equal((await action()).outcome, 'kept');
    assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 1);
    if (kind !== 'changed')
      assert.deepEqual(readProjectHistory(f.databaseFile, f.config.reviewUrl).rows, before);
  }
});

test('additive project restore cannot revive reset records in either merge direction; clean reset backup remains restorable', async () => {
  const f = await fixture();
  const root = path.join(f.folder, 'Projects');
  const folder = projectLocation(f.config.reviewUrl, root);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(f.config));
  const opts = { databaseFile: f.databaseFile, root };
  const old = await backupProject(f.config.reviewUrl, opts);
  await reset(f, async () => evidence(f, 'not_voted'));
  const fresh = await backupProject(f.config.reviewUrl, opts);
  await assert.rejects(restoreProjectBackup(old.file, opts), /verified study reset/);
  const target = await mkdtemp(path.join(os.tmpdir(), 'covipanel-reset-restore-'));
  const other = {
    databaseFile: path.join(target, 'screening.sqlite'),
    root: path.join(target, 'Projects'),
  };
  await restoreProjectBackup(old.file, other);
  await assert.rejects(restoreProjectBackup(fresh.file, other), /verified study reset/);
  const clean = await mkdtemp(path.join(os.tmpdir(), 'covipanel-reset-clean-'));
  const cleanFile = path.join(clean, 'screening.sqlite');
  await restoreProjectBackup(fresh.file, {
    databaseFile: cleanFile,
    root: path.join(clean, 'Projects'),
  });
  assert.equal(readUnfinished(cleanFile, f.config.reviewUrl).length, 0);
});

test('cancelling during online verification retains every study record', async () => {
  const f = await fixture();
  const store = new QueueStore(f.databaseFile);
  let stopped = false;
  try {
    await assert.rejects(
      resetUnfinished({
        store,
        job: f.job,
        studyId: '1',
        config: f.config,
        folder: f.folder,
        shouldStop: () => stopped,
        verify: async () => {
          stopped = true;
          return evidence(f, 'not_voted');
        },
      }),
      /Reset cancelled/,
    );
  } finally {
    store.close();
  }
  assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 1);
  assert.equal(
    withRecords(f.databaseFile, (s) => s.recommendation('r1').record.decision),
    'Exclude',
  );
});

test('reset isolates the exact review and retains separate imported or completed history', async () => {
  const f = await fixture();
  const other = {
    ...f.config,
    reviewUrl: f.config.reviewUrl.replace('/160676/', '/999/'),
    configHash: 'other',
  };
  const store = new QueueStore(f.databaseFile);
  const otherJob = store.create(other, ['1'], 'auto-vote');
  store.close();
  withRecords(f.databaseFile, (s) =>
    s.saveRecommendation({
      record: {
        ...s.recommendation('r1').record,
        runId: 'other',
        reviewUrl: other.reviewUrl,
        configHash: other.configHash,
      },
    }),
  );
  await reset(f, async () => evidence(f, 'not_voted'));
  assert.equal(readUnfinished(f.databaseFile, other.reviewUrl)[0].job.id, otherJob.id);
  assert.equal(
    withRecords(f.databaseFile, (s) => s.recommendation('other').record.decision),
    'Exclude',
  );
  for (const kind of ['imported', 'completed']) {
    const g = await fixture();
    if (kind === 'imported')
      withRecords(g.databaseFile, (s) =>
        s.projectEvent(
          'import',
          g.config.reviewUrl.replace(/\/review_studies\/screen.*$/, ''),
          'history_workbook_imported',
          { rows: [['1', 'Title', 'Exclude', 'Text']] },
        ),
      );
    else {
      const queue = new QueueStore(g.databaseFile);
      const job = queue.create(g.config, ['1'], 'recommend-only');
      queue.update(job.id, '1', 'recommended', {});
      queue.close();
    }
    assert.equal((await reset(g, async () => evidence(g, 'not_voted'))).outcome, 'kept');
    assert.equal(
      withRecords(g.databaseFile, (s) => s.recommendation('r1').record.decision),
      'Exclude',
    );
  }
});

test('manual fallback uses the agreed short option and requires an explicit selection', async () => {
  const screens = [];
  const show = (title, lines) => screens.push({ title, lines });
  for (const answer of ['', '0', 'yes', '2'])
    assert.equal(await confirmManualReset('12188', scripted([answer]), show), false);
  assert.equal(await confirmManualReset('12188', scripted(['1']), show), true);
  assert(
    screens.every(
      (s) =>
        s.lines.includes('Study #12188') &&
        s.lines.includes('1. I checked Covidence: no vote submitted — reset this study'),
    ),
  );
});

test('manual confirmation after an inconclusive check backs up and removes records with truthful provenance', async () => {
  const f = await fixture(['1', '2']);
  let calls = 0;
  const result = await reset(
    f,
    async () => ({ outcome: 'uncertain', reason: 'History could not be loaded.' }),
    {
      confirmManual: async ({ studyId, reason }) => {
        calls++;
        assert.equal(studyId, '1');
        assert.match(reason, /could not be loaded/);
        return confirmManualReset(studyId, scripted(['1']), () => {});
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'not_voted');
  assert.match(result.message, /Manual reset complete/);
  assert.deepEqual(
    readUnfinished(f.databaseFile, f.config.reviewUrl).map((e) => e.item.study_id),
    ['2'],
  );
  withRecords(f.databaseFile, (s) => {
    assert.equal(s.recommendationIds(f.config, '1').length, 0);
    const event = JSON.parse(
      s.db.prepare("SELECT data FROM project_events WHERE kind='study_reset'").get().data,
    );
    assert.equal(event.verification.source, 'user_confirmation');
    assert.equal(event.verification.reviewerIdentity, undefined);
    assert.equal(event.verification.checkedAt, undefined);
    assert.match(event.verification.automaticCheck.reason, /could not be loaded/);
    assert.deepEqual(event.runIds, ['r1']);
    assert.deepEqual(event.voteIds, ['v1']);
  });
  const files = await readdir(path.join(f.folder, 'Backups'));
  const backup = JSON.parse(await readFile(path.join(f.folder, 'Backups', files[0]), 'utf8'));
  assert.equal(backup.tables.recommendations.length, 1);
  assert.equal(backup.verification.source, 'user_confirmation');
  await exportProjectHistory(f.databaseFile, f.config.reviewUrl, { folder: f.folder });
  const history = readProjectHistory(f.databaseFile, f.config.reviewUrl);
  assert.deepEqual(
    history.studies.map((s) => s.id),
    ['2'],
  );
  assert.match(history.log, /User checked Covidence: no vote submitted/);
  assert(!history.log.includes('reset after Covidence confirmed no vote'));
});

test('cancelled manual fallback leaves recommendation, vote and queue unchanged', async () => {
  const f = await fixture();
  const before = readProjectHistory(f.databaseFile, f.config.reviewUrl);
  const result = await reset(f, async () => ({ outcome: 'uncertain', reason: 'Offline.' }), {
    confirmManual: ({ studyId }) => confirmManualReset(studyId, scripted(['']), () => {}),
  });
  assert.equal(result.outcome, 'kept');
  assert.deepEqual(readProjectHistory(f.databaseFile, f.config.reviewUrl), before);
  assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 1);
  await assert.rejects(readdir(path.join(f.folder, 'Backups')), { code: 'ENOENT' });
});

test('browser startup failure can reach manual fallback without another browser or AI request', async () => {
  const f = await fixture();
  let calls = 0;
  const result = await reset(
    f,
    async () => {
      calls++;
      throw Error('Browser could not open');
    },
    { confirmManual: async () => true },
  );
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'not_voted');
  assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 0);
});

test('manual fallback cannot bypass local possible votes, positive online votes or other completed/imported history', async () => {
  for (const kind of ['uncertain', 'confirmed', 'recorded', 'completed', 'imported', 'online']) {
    const f = await fixture();
    if (['uncertain', 'confirmed', 'recorded'].includes(kind))
      withRecords(f.databaseFile, (s) =>
        s.saveVote({
          ...s.vote('v1').record,
          status: kind === 'recorded' ? 'blocked_before_click' : kind,
          ...(kind === 'recorded' ? { recordedVote: 'No' } : {}),
        }),
      );
    if (kind === 'completed') {
      const store = new QueueStore(f.databaseFile);
      const job = store.create(f.config, ['1'], 'auto-vote');
      store.update(job.id, '1', 'completed', {});
      store.close();
    }
    if (kind === 'imported')
      withRecords(f.databaseFile, (s) =>
        s.projectEvent(
          'import',
          f.config.reviewUrl.replace(/\/review_studies\/screen.*$/, ''),
          'history_workbook_imported',
          { rows: [['1', 'Title', 'Exclude', 'Text']] },
        ),
      );
    const result = await reset(
      f,
      async () => ({
        outcome: 'uncertain',
        reason: 'Cannot confirm.',
        ...(kind === 'online' ? { historyRows: ['You voted No'] } : {}),
      }),
      { confirmManual: () => assert.fail('Conflicting evidence must not offer manual deletion') },
    );
    assert.equal(result.outcome, 'kept', kind);
    assert.equal(
      withRecords(f.databaseFile, (s) => s.recommendation('r1').record.decision),
      'Exclude',
    );
  }
});

test('automatic outcomes never prompt for manual reset and changes during confirmation prevent removal', async () => {
  for (const outcome of ['voted', 'not_voted']) {
    const f = await fixture();
    await reset(
      f,
      async () => evidence(f, outcome, { recordedVote: outcome === 'voted' ? 'No' : null }),
      {
        confirmManual: () => assert.fail('Automatic verification succeeded'),
      },
    );
  }
  const f = await fixture();
  await assert.rejects(
    reset(f, async () => ({ outcome: 'uncertain' }), {
      confirmManual: async () => {
        withRecords(f.databaseFile, (s) =>
          s.saveVote({ ...s.vote('v1').record, status: 'uncertain' }),
        );
        return true;
      },
    }),
    /records changed/,
  );
  assert.equal(readUnfinished(f.databaseFile, f.config.reviewUrl).length, 1);
  assert.equal(
    withRecords(f.databaseFile, (s) => s.vote('v1').record.status),
    'uncertain',
  );
});
