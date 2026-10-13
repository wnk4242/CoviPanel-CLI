// Local-only native terminal smoke check. No real project, browser or API.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { loadProfile } from '../Tests/fixtures.js';
import { studyHash } from '../Application/profiles.js';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { reviewPendingBatch } from '../Application/batch-approval.js';
import { createTerminal } from '../Application/terminal-input.js';

assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'A real terminal is required.');
const cancellation = process.argv.includes('--cancel');
const saveOnly = process.argv.includes('--save-only');
const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-native-confirm-'));
const file = path.join(folder, 'screening.sqlite');
const config = await loadProfile('demo', '1');
const store = new QueueStore(file);
try {
  const job = store.create(config, ['1'], 'review-all');
  const study = { studyId: '1', title: 'Local terminal fixture', abstract: 'Synthetic abstract.' };
  const record = {
    runId: 'native-fixture',
    reviewUrl: config.reviewUrl,
    configHash: config.configHash,
    dataset: config.dataset,
    studyId: '1',
    studyHash: studyHash(study),
    title: study.title,
    decision: 'Maybe',
    status: 'recommended',
    rationale: 'Original local fixture explanation.',
    createdAt: new Date().toISOString(),
  };
  withRecords(file, (records) =>
    records.saveRecommendation({
      record,
      study,
      parsed: { Decision: 'Maybe', Rationale: record.rationale },
    }),
  );
  store.update(job.id, '1', 'recommended', { recommendationRecord: record });
  await setTimeout(50);
  const approved = await reviewPendingBatch('Local terminal fixture', file, [job.id], {
    folder,
    lock: async () => async () => {},
    load: async () => config,
  });
  if (saveOnly) {
    assert.equal(approved.savedOnly, true);
    const item = store.item(job.id, '1');
    assert.equal(item.state, 'saved');
    assert.ok(item.data.savedWithoutSubmission);
    assert.equal(item.data.batchApproval, undefined);
    assert.equal(
      withRecords(file, (s) => s.recommendation(record.runId)).record.rationale,
      record.rationale,
    );
  } else if (cancellation) {
    assert.equal(approved.cancelled, true);
    assert.deepEqual(store.items(job.id), []);
    assert.deepEqual(
      withRecords(file, (s) => s.recommendationIds(config, '1')),
      [],
    );
    assert.throws(() => withRecords(file, (s) => s.recommendation(record.runId)), /not found/);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) n FROM project_events WHERE kind='batch_cancelled'").get()
        .n,
      1,
    );
  } else {
    const item = store.item(job.id, '1');
    assert.equal(approved.confirmed, true);
    assert.equal(item.data.batchReview.decision, 'Exclude');
    assert.equal(item.data.batchReview.rationale, 'Edited local explanation.');
    assert.ok(item.data.batchApproval);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM votes').get().n, 0);
  await setTimeout(50);
  const terminal = createTerminal();
  assert.equal(await terminal.question('Project menu: choose 1 then one Enter: '), '1');
  terminal.close();
  console.log(
    saveOnly
      ? 'PASS: native save-only confirmation, retained original response, zero votes, and first menu selection with one Enter.'
      : cancellation
        ? 'PASS: native batch cancellation, deleted responses, zero votes, and first menu selection with one Enter.'
        : 'PASS: native decision/rationale/submission confirmations, persisted edits, zero votes, and first menu selection with one Enter.',
  );
} finally {
  store.close();
}
