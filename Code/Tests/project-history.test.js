import { loadProfile } from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildProjectHistory,
  readProjectHistory,
  reviewKey,
} from '../Application/project-history.js';
import { exportProjectHistory } from '../Application/history-export.js';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { queueOperations } from '../Application/queue-operations.js';
import { hash, studyHash } from '../Application/profiles.js';
import { runQueue } from '../Application/queue-runner.js';

const url = 'https://demo.covidence.org/reviews/160676/review_studies/screen';
const makeSnapshot = () => {
  const jobs = [
    { id: 'one', review_url: url, created_at: '2026-09-12T10:00:00Z', mode: 'auto-vote' },
    { id: 'two', review_url: url, created_at: '2026-09-12T11:00:00Z', mode: 'recommend-only' },
  ];
  const rec = (runId, decision, time, extra = {}) => ({
    record: {
      runId,
      studyId: '1',
      reviewUrl: url,
      status: 'recommended',
      decision,
      rationale: `Reason for ${decision}`,
      createdAt: time,
      requestHash: 'request',
      usage: { input_tokens: 20, output_tokens: 5 },
      ...extra,
    },
    study: { title: 'Same title' },
  });
  return {
    key: reviewKey(url),
    jobs,
    items: [
      {
        job_id: 'one',
        study_id: '1',
        state: 'completed',
        data: {},
        updated_at: jobs[0].created_at,
      },
      {
        job_id: 'two',
        study_id: '1',
        state: 'recommended',
        data: {},
        updated_at: jobs[1].created_at,
      },
      {
        job_id: 'two',
        study_id: '2',
        state: 'pending',
        data: { study: { title: 'Same title' } },
        updated_at: jobs[1].created_at,
      },
    ],
    recommendations: [
      rec('r1', 'Include', jobs[0].created_at),
      rec('r2', 'Exclude', jobs[1].created_at),
      rec('r3', null, jobs[1].created_at, {
        status: 'error',
        usage: null,
        error: 'Response invalid',
        rationale: null,
      }),
    ],
    votes: [
      {
        attemptId: 'v1',
        studyId: '1',
        reviewUrl: url,
        status: 'confirmed',
        recommendationRunId: 'r1',
        decision: 'Include',
        expectedButton: 'Yes',
        actualButton: 'Yes',
        recordedVote: 'Yes',
        createdAt: jobs[0].created_at,
        addedRows: ['Yes vote\nby You'],
      },
    ],
    claims: [{ claim_key: 'demo.covidence.org-160676-1', attempt_id: 'v1' }],
    events: [
      {
        job_id: 'two',
        study_id: '1',
        state: 'error',
        created_at: jobs[1].created_at,
        data: { error: 'Old quotation error' },
      },
      {
        job_id: 'two',
        study_id: '1',
        state: 'pending',
        created_at: jobs[1].created_at,
        data: { reviewReason: 'Reviewed and resumed' },
      },
    ],
    activity: [
      {
        created_at: jobs[1].created_at,
        kind: 'discovery',
        data: {
          total: 3,
          requested: 1,
          studies: [{ studyId: '2' }],
          blocked: [{ studyId: '1', reason: 'Existing local vote claim' }],
        },
      },
    ],
  };
};

test('workbook imports survive history export without becoming AI attempts or verified votes', () => {
  const snapshot = makeSnapshot();
  snapshot.key = 'https://app.covidence.org/reviews/900001';
  const row = ['77', 'Imported study', 'Exclude', 'Original wording.'];
  const event = {
    review_url: snapshot.key,
    kind: 'history_workbook_imported',
    created_at: '2026-09-24T10:00:00Z',
    data: { sourceFile: 'Mac.xlsx', sourceHash: 'source-digest', rows: [row] },
  };
  const before = buildProjectHistory(snapshot);
  snapshot.activity.push(event, event);
  const result = buildProjectHistory(snapshot);
  assert.deepEqual(result.rows.at(-1), row);
  assert.equal(result.rows.filter((r) => r[0] === '77').length, 1);
  assert.deepEqual(result.usage, before.usage);
  const imported = result.studies.find((s) => s.id === '77');
  assert.equal(imported.vote, undefined);
  assert.equal(imported.recommendation, undefined);
  assert.equal(imported.claim, undefined);
  assert.match(imported.status, /submission not verified locally/);
  assert.match(result.log, /IMPORTED SPREADSHEET HISTORY/);
  assert.match(result.log, /Source SHA-256: source-digest/);
  const other = buildProjectHistory({ ...snapshot, key: reviewKey(url) });
  assert.equal(
    other.studies.some((s) => s.id === '77'),
    false,
  );
});

test('local records take precedence over imported rows and conflicting imports fail explicitly', () => {
  const snapshot = makeSnapshot();
  const before = buildProjectHistory(snapshot);
  const event = {
    review_url: snapshot.key,
    kind: 'history_workbook_imported',
    created_at: '2026-09-24T10:00:00Z',
    data: {
      sourceFile: 'Mac.xlsx',
      rows: [['1', 'Imported title', 'Exclude', 'Source rationale']],
    },
  };
  snapshot.activity.push(event);
  assert.deepEqual(buildProjectHistory(snapshot).rows, before.rows);
  snapshot.activity.push({
    ...event,
    data: { rows: [['1', 'Other title', 'Maybe', 'Different']] },
  });
  assert.throws(() => buildProjectHistory(snapshot), /Conflicting imported history/);
  snapshot.activity = [{ ...event, data: { rows: [['77', 'Invalid', 'Unknown', 'Reason']] } }];
  assert.throws(() => buildProjectHistory(snapshot), /Invalid imported history row/);
});

test('edited history wording survives rebuilds without changing source responses or later screenings', () => {
  const snapshot = makeSnapshot();
  const original = buildProjectHistory(snapshot);
  const edit = {
    runId: 'r1',
    studyId: '1',
    decision: 'Include',
    sourceHash: hash({ title: original.rows[1][1], rationale: original.studies[0].rationale }),
    rationale: 'A concise explanation.',
  };
  const event = {
    event_id: 'wording-edit',
    review_url: snapshot.key,
    created_at: '2026-09-20T12:00:00Z',
    kind: 'history_rationales_edited',
    data: { edits: [edit], message: 'Rationale wording edited.' },
  };
  const edited = { ...snapshot, activity: [...snapshot.activity, event] };
  const result = buildProjectHistory(edited);
  assert.equal(result.rows[1][3], edit.rationale);
  assert.deepEqual(
    result.rows.map((r) => r.slice(0, 3)),
    original.rows.map((r) => r.slice(0, 3)),
  );
  assert.equal(result.studies[0].rationale, original.studies[0].rationale);
  assert.deepEqual(result.studies[0].recommendation, original.studies[0].recommendation);
  assert.match(result.log, /Reason for Include/);
  assert.deepEqual(buildProjectHistory(edited).rows, result.rows);
  for (const mismatch of [
    { runId: 'new-screening' },
    { studyId: '2' },
    { decision: 'Maybe' },
    { sourceHash: 'changed source' },
    { rationale: '' },
    { rationale: 'x'.repeat(32768) },
  ]) {
    const stale = { ...event, data: { edits: [{ ...edit, ...mismatch }] } };
    assert.deepEqual(buildProjectHistory({ ...snapshot, activity: [stale] }).rows, original.rows);
  }
  const otherReview = { ...event, review_url: 'https://demo.covidence.org/reviews/999' };
  assert.deepEqual(
    buildProjectHistory({ ...snapshot, activity: [otherReview] }).rows,
    original.rows,
  );
  const later = {
    ...event,
    event_id: 'later-edit',
    created_at: '2026-09-21T12:00:00Z',
    data: { edits: [{ ...edit, rationale: 'Later wording.' }] },
  };
  assert.equal(
    buildProjectHistory({ ...snapshot, activity: [later, event] }).rows[1][3],
    'Later wording.',
  );
});

test('cumulative history consolidates study IDs while preserving differing decisions, errors, duplicate records and unknown usage', () => {
  const h = buildProjectHistory(makeSnapshot());
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.rows[1], ['1', 'Same title', 'Include', 'Reason for Include']);
  assert.deepEqual(h.rows[2], ['2', 'Same title', '', '']);
  assert.deepEqual(h.usage, { requests: 3, reported: 2, unknown: 1, input: 40, output: 10 });
  for (const text of [
    'Reason for Include',
    'Reason for Exclude',
    'Old quotation error',
    'Reviewed and resumed',
    'Response invalid',
    'Existing local vote claim',
    'Submitted and verified',
    '3 saved AI attempts',
    'Batch 01',
    'Batch 02',
  ])
    assert.ok(h.log.includes(text), text);
});

test('cancelled votes do not hide newer unsubmitted recommendations', () => {
  const snapshot = makeSnapshot();
  snapshot.claims = [];
  snapshot.votes[0].status = 'cancelled';
  const h = buildProjectHistory(snapshot);
  assert.equal(h.rows[1][2], 'Exclude');
  assert.equal(h.studies[0].status, 'Recommendation saved; not submitted');
  assert.match(h.log, /Cancelled before submission/);
});

test('history follows first screening across batches, tied timestamps and retries, with waiting studies last', () => {
  const snapshot = makeSnapshot(),
    time = (n) => `2026-09-12T${String(n).padStart(2, '0')}:00:00Z`;
  snapshot.claims = [];
  snapshot.activity = [];
  snapshot.items = ['95', '67', '89', '2', '1'].map((id, ordinal) => ({
    job_id: 'one',
    study_id: id,
    ordinal,
    state: ordinal < 3 ? 'completed' : 'pending',
    data: {},
    updated_at: time(20),
  }));
  snapshot.items.push({
    job_id: 'two',
    study_id: '13',
    ordinal: 0,
    state: 'completed',
    data: {},
    updated_at: time(16),
  });
  snapshot.events = [
    { id: 2, job_id: 'one', study_id: '67', state: 'processing', created_at: time(12), data: {} },
    { id: 1, job_id: 'one', study_id: '89', state: 'processing', created_at: time(12), data: {} },
    { id: 3, job_id: 'two', study_id: '13', state: 'processing', created_at: time(13), data: {} },
    { id: 4, job_id: 'one', study_id: '95', state: 'processing', created_at: time(14), data: {} },
    { id: 5, job_id: 'one', study_id: '89', state: 'processing', created_at: time(18), data: {} },
    { id: 6, job_id: 'one', study_id: '1', state: 'mode_changed', created_at: time(10), data: {} },
    { id: 7, job_id: 'one', study_id: '2', state: 'pending', created_at: time(10), data: {} },
  ];
  const rec = (id, hour, decision = 'Include') => ({
    record: {
      runId: `${id}-${hour}`,
      studyId: id,
      createdAt: time(hour),
      status: 'recommended',
      decision,
      rationale: `Reason ${id}`,
    },
    study: { title: `Title ${id}` },
  });
  // A later recommendation replaces the displayed decision without moving the study.
  snapshot.recommendations = [
    rec('89', 19, 'Exclude'),
    rec('67', 15),
    rec('105', 11),
    rec('89', 12),
  ];
  snapshot.votes = [
    { attemptId: 'later', studyId: '13', createdAt: time(16), status: 'confirmed' },
    {
      attemptId: 'earlier',
      studyId: '105',
      createdAt: time(11),
      status: 'confirmed',
      recommendationRunId: '105-11',
    },
  ];
  const original = JSON.stringify(snapshot),
    h = buildProjectHistory(snapshot);
  assert.deepEqual(
    h.rows.slice(1).map((row) => row[0]),
    ['105', '89', '67', '13', '95', '2', '1'],
  );
  assert.equal(h.rows[2][2], 'Exclude');
  const status = h.log.split('CURRENT STUDY STATUS')[1].split('BATCHES')[0];
  assert.deepEqual(
    [...status.matchAll(/Study #(\d+):/g)].map((m) => m[1]),
    ['105', '89', '67', '13', '95', '2', '1'],
  );
  const firstBatch = h.log.split('BATCHES')[1].split('Batch 02')[0];
  assert.deepEqual(
    [...firstBatch.matchAll(/Study #(\d+):/g)].map((m) => m[1]),
    ['89', '67', '95', '2', '1'],
  );
  assert.deepEqual(
    [...h.log.matchAll(/AI attempt \d+ — .* — study #(\d+)/g)].map((m) => m[1]),
    ['105', '89', '67', '89'],
  );
  assert.deepEqual(
    [...h.log.matchAll(/Vote attempt \d+ — .* — study #(\d+)/g)].map((m) => m[1]),
    ['105', '13'],
  );
  assert.equal(JSON.stringify(snapshot), original, 'Formatting must not change source records');
});

test('local cumulative exports isolate reviews, retain saved records and update the same two files without any API access', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-history-')),
    database = path.join(folder, 'screening.sqlite'),
    outputs = path.join(folder, 'Outputs');
  const store = new QueueStore(database);
  const config = {
    profile: 'demo',
    dataset: 'demo-vitamin-c-common-cold',
    reviewUrl: url,
    configHash: 'criteria',
  };
  const job = store.create(config, ['1'], 'recommend-only');
  store.update(job.id, '1', 'pending', { study: { title: 'Local citation' } });
  store.create({ ...config, reviewUrl: url.replace('160676', '999') }, ['99'], 'recommend-only');
  const before = store.items(job.id);
  withRecords(database, () => {});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Export must not use the network or AI');
  try {
    const first = await exportProjectHistory(database, url, { folder: outputs });
    assert.equal(first.changed, true);
    assert.equal(first.history.rows.length, 2);
    assert.deepEqual(await readdir(outputs), ['Decision History.xlsx', 'Screening Log.txt']);
    assert.ok(!(await readFile(first.text, 'utf8')).includes('study #99'));
    const second = await exportProjectHistory(database, url, { folder: outputs });
    assert.equal(second.changed, false);
    assert.deepEqual(store.items(job.id), before);
    assert.equal(readProjectHistory(database, url + '?filter=all').studies.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});

test('a new batch cannot silently repeat a previously attempted API request; explicit retry authorizes only one new attempt', async () => {
  const config = await loadProfile('demo', '89');
  const database = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-request-guard-')),
    'screening.sqlite',
  );
  const source = {
    ready: true,
    studyId: '89',
    title: 'Treatment report',
    abstract: 'Vitamin C was studied.',
  };
  const previous = {
    runId: randomUUID(),
    dataset: config.dataset,
    reviewUrl: config.reviewUrl,
    studyId: '89',
    configHash: config.configHash,
    status: 'error',
    requestHash: 'request',
    studyHash: studyHash(source),
    error: 'API connection failed',
  };
  withRecords(database, (s) => s.saveRecommendation({ record: previous, study: source }));
  let calls = 0;
  const operations = queueOperations({
    config,
    databasePath: database,
    client: {
      responses: {
        create: async () => {
          calls++;
          throw new Error('Simulated timeout');
        },
      },
    },
  });
  operations.extract = async () => source;
  const store = new QueueStore(database),
    job = store.create(config, ['89'], 'recommend-only');
  try {
    await runQueue({ store, job, config, operations, log: () => {} });
    const item = store.items(job.id)[0];
    assert.equal(item.state, 'error');
    assert.equal(item.data.previousRecommendationId, previous.runId);
    assert.equal(calls, 0);
    const result = await operations.recommend('89', source, null, async () => {}, previous.runId);
    assert.equal(calls, 1);
    assert.equal(result.record.status, 'error');
    await assert.rejects(
      operations.recommend('89', source, null, async () => {}, previous.runId),
      /No automatic repeat/,
    );
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('saved-only sheet selects explicit S records once, without changing the main history or inferring submission', () => {
  const source = makeSnapshot();
  const before = buildProjectHistory(source);
  assert.deepEqual(before.savedOnlyRows, [before.rows[0]]);
  // Both overlapping batches can carry the marker; a normal pending study must stay out.
  for (const item of source.items.filter((item) => item.study_id === '1'))
    item.data.savedWithoutSubmission = { id: 'saved-batch' };
  source.items[0].data.savedVoteCheck = { outcome: 'voted', recordedVote: 'No' };
  const after = buildProjectHistory(source);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.savedOnlyRows, [after.rows[0], after.rows.find((row) => row[0] === '1')]);
  assert.equal(after.savedOnlyRows.length, 2);
});
