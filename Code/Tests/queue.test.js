import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { QueueStore, parseIds, acquireWorkerLock } from '../Application/queue-store.js';
import { runQueue } from '../Application/queue-runner.js';
import { studyHash } from '../Application/profiles.js';

const config = {
  profile: 'demo',
  dataset: 'demo-vitamin-c-common-cold',
  reviewUrl: 'https://demo.covidence.org/reviews/160676/review_studies/screen',
  configHash: 'criteria-v1',
};
const study = (id) => ({
  ready: true,
  studyId: id,
  title: `Study ${id}`,
  abstract: 'Experimental abstract',
  author: '',
  year: '',
});
const recommendation = (id) => ({
  dir: `/fixture/${id}`,
  parsed: { Rationale: 'Test' },
  rawResponse: { output: 'complete AI response' },
  record: {
    status: 'recommended',
    runId: `run-${id}`,
    decision: 'Include',
    expectedButton: 'Yes',
    studyHash: studyHash(study(id)),
    model: 'fixture',
  },
});

async function setup(ids = ['1', '2'], mode = 'recommend-only') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-queue-'));
  const file = path.join(dir, 'queue.sqlite');
  const store = new QueueStore(file);
  const job = store.create(config, ids, mode);
  const calls = { extract: [], api: [], vote: [] };
  const operations = {
    existingVote: async () => null,
    extract: async (id) => {
      calls.extract.push(id);
      return study(id);
    },
    cached: async () => null,
    recommend: async (id, s, reference, checkpoint) => {
      calls.api.push(id);
      await checkpoint({ dir: `/fixture/${id}`, record: { status: 'request_started' } });
      await checkpoint(recommendation(id));
      return recommendation(id);
    },
    vote: async (id, r, checkpoint) => {
      calls.vote.push(id);
      const result = {
        record: { status: 'confirmed', recordedVote: 'Yes', voteComparison: 'match' },
      };
      await checkpoint(result);
      return result;
    },
  };
  return { dir, file, store, job, operations, calls };
}

test('queues parse IDs, ranges and pasted lines with deduplication and bounds', () => {
  assert.deepEqual(parseIds('#105, 90-92\n#105;93'), ['105', '90', '91', '92', '93']);
  for (const text of ['', '0', '-1', '8-3', '1-20000', '1.5', 'abc', '9007199254740992'])
    assert.throws(() => parseIds(text));
});

test('automatic jobs submit once, skip retained claims and stop on uncertain results', async () => {
  const s = await setup(['1', '2', '3'], 'auto-vote');
  s.operations.existingVote = async (id) =>
    id === '1' ? { record: { status: 'confirmed' } } : null;
  s.operations.vote = async (id) => {
    s.calls.vote.push(id);
    return { record: { status: 'uncertain', reason: 'Reviewer mismatch in History.' } };
  };
  await runQueue({ ...s, config, log: () => {} });
  assert.deepEqual(s.calls.vote, ['2']);
  assert.equal(s.store.item(s.job.id, '2').data.error, 'Reviewer mismatch in History.');
  assert.deepEqual(
    s.store.items(s.job.id).map((i) => i.state),
    ['completed', 'needs_review', 'pending'],
  );
  s.store.close();
});
test('converting a legacy voting job to batch review preserves checkpoints and waits for C', async () => {
  const s = await setup(['1', '2'], 'confirm-each-vote');
  s.store.update(s.job.id, '1', 'completed', { voteRecord: { status: 'confirmed' } });
  const j = s.store.enableBatchReview(s.job.id);
  assert.equal(j.mode, 'review-all');
  assert.deepEqual(s.store.settings(j.id), config);
  assert.equal(s.store.enableBatchReview(s.job.id).mode, 'review-all');
  assert.equal(s.store.items(j.id)[0].state, 'completed');
  assert.equal(
    s.store.db.prepare("SELECT COUNT(*) n FROM events WHERE state='mode_changed'").get().n,
    2,
  );
  await runQueue({ ...s, job: j, config, log: () => {} });
  assert.deepEqual(s.calls.vote, []);
  assert.equal(s.store.item(j.id, '2').state, 'recommended');
  const recommendJob = s.store.create(config, ['3'], 'recommend-only');
  assert.equal(s.store.enableBatchReview(recommendJob.id).mode, 'review-all');
  assert.throws(() => s.store.create({ ...config, profile: 'standard' }, ['4'], 'auto-vote'));
  s.store.close();
});

test('SQLite queue persists recommendations and resume skips completed work', async () => {
  const s = await setup();
  await runQueue({ ...s, config, log: () => {} });
  assert.deepEqual(s.calls.api, ['1', '2']);
  assert.deepEqual(s.calls.vote, []);
  assert.equal(s.store.items(s.job.id)[0].data.rawResponse, undefined);
  assert.equal(s.store.items(s.job.id)[1].data.configuration, undefined);
  assert.deepEqual(s.store.settings(s.job.id), config);
  s.store.close();
  s.store = new QueueStore(s.file);
  await runQueue({ ...s, config, log: () => {} });
  assert.deepEqual(s.calls.api, ['1', '2']);
  assert.deepEqual(s.calls.extract, ['1', '2']);
  s.store.close();
});

test('resuming each mode skips finished entries and votes on cached recommendations only in voting modes', async () => {
  for (const mode of ['recommend-only', 'confirm-each-vote', 'auto-vote']) {
    const s = await setup(['1', '2', '3', '4'], mode);
    try {
      s.store.update(s.job.id, '1', 'completed', {});
      s.store.update(s.job.id, '2', 'skipped', {});
      s.store.update(s.job.id, '3', 'recommended', {
        recommendationRecord: recommendation('3').record,
      });
      s.operations.cached = async (id) => (id === '3' ? recommendation(id) : null);
      await runQueue({ ...s, config, log: () => {} });
      assert.deepEqual(s.calls.extract, mode === 'recommend-only' ? ['4'] : ['3', '4']);
      assert.deepEqual(s.calls.api, ['4']);
      assert.deepEqual(s.calls.vote, mode === 'recommend-only' ? [] : ['3', '4']);
      assert.deepEqual(
        s.store.items(s.job.id).map((item) => item.state),
        mode === 'recommend-only'
          ? ['completed', 'skipped', 'recommended', 'recommended']
          : ['completed', 'skipped', 'completed', 'completed'],
      );
    } finally {
      s.store.close();
    }
  }
});

test('queue operations are sequential and cancellation stops before another study', async () => {
  const s = await setup(['1', '2'], 'confirm-each-vote');
  s.operations.vote = async () => ({ record: { status: 'cancelled' } });
  await runQueue({ ...s, config, log: () => {} });
  assert.deepEqual(s.calls.api, ['1']);
  assert.deepEqual(
    s.store.items(s.job.id).map((x) => x.state),
    ['needs_review', 'pending'],
  );
  s.store.close();
});

test('valid cached results avoid API calls and known submitted votes are never repeated', async () => {
  const s = await setup(['1', '2'], 'confirm-each-vote');
  s.operations.existingVote = async (id) =>
    id === '1' ? { record: { status: 'confirmed', recordedVote: 'No' } } : null;
  s.operations.cached = async (id) => recommendation(id);
  await runQueue({ ...s, config, log: () => {} });
  assert.deepEqual(s.calls.extract, ['2']);
  assert.deepEqual(s.calls.api, []);
  assert.deepEqual(s.calls.vote, ['2']);
  assert.deepEqual(
    s.store.items(s.job.id).map((x) => x.state),
    ['completed', 'completed'],
  );
  s.store.close();
});

test('missing study, browser failure and API failure stop without moving to the next study', async () => {
  for (const failAt of ['extract', 'recommend']) {
    const s = await setup();
    s.operations[failAt] = async () => {
      throw new Error(failAt === 'extract' ? 'Browser closed or study missing' : 'API unavailable');
    };
    await runQueue({ ...s, config, log: () => {} });
    assert.deepEqual(
      s.store.items(s.job.id).map((x) => x.state),
      ['error', 'pending'],
    );
    assert.deepEqual(s.calls.vote, []);
    s.store.close();
  }
});

test('interrupted API checkpoint survives abrupt process exit and is not resubmitted', async () => {
  const s = await setup();
  s.store.close();
  const source = new URL('../Application/queue-store.js', import.meta.url).href;
  const script = `import {QueueStore} from ${JSON.stringify(source)}; const store=new QueueStore(${JSON.stringify(s.file)}); store.update(${JSON.stringify(s.job.id)},'1','processing',{stage:'api',recommendationRecord:{status:'request_started'}}); process.exit(23);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(child.status, 23);
  s.store = new QueueStore(s.file);
  await runQueue({ ...s, config, log: () => {} });
  assert.equal(s.store.items(s.job.id)[0].state, 'needs_review');
  assert.deepEqual(s.calls.api, []);
  s.store.close();
});

test('interrupted vote cannot be retried and interrupted pre-API extraction is safe to restart', async () => {
  const s = await setup(['1'], 'confirm-each-vote');
  s.store.update(s.job.id, '1', 'processing', {
    stage: 'voting',
    voteRecord: { status: 'click_intent' },
  });
  await runQueue({ ...s, config, log: () => {} });
  assert.deepEqual(s.calls.vote, []);
  assert.equal(s.store.items(s.job.id)[0].state, 'needs_review');
  s.store.close();
  const safe = await setup(['1']);
  safe.store.update(safe.job.id, '1', 'processing', { stage: 'extracting' });
  await runQueue({ ...safe, config, log: () => {} });
  assert.deepEqual(safe.calls.api, ['1']);
  safe.store.close();
});

test('configuration drift and stale recommendations prevent new API requests or votes', async () => {
  const s = await setup(['1']);
  await assert.rejects(
    runQueue({ ...s, config: { ...config, configHash: 'changed' } }),
    /configuration changed/,
  );
  s.store.update(s.job.id, '1', 'recommended', {
    recommendationRecord: recommendation('1').record,
  });
  // A confirm job would revalidate the citation before using that recommendation.
  const j = s.store.create(config, ['1'], 'confirm-each-vote');
  s.store.update(j.id, '1', 'recommended', { recommendationRecord: recommendation('1').record });
  await runQueue({ ...s, job: j, config, log: () => {} });
  assert.deepEqual(s.calls.api, []);
  assert.deepEqual(s.calls.vote, []);
  assert.equal(s.store.items(j.id)[0].state, 'error');
  s.store.close();
});

test('cooperative stop preserves pending studies and the saved recommendation', async () => {
  const s = await setup();
  let stop = false;
  const original = s.operations.recommend;
  s.operations.recommend = async (...args) => {
    const result = await original(...args);
    stop = true;
    return result;
  };
  await runQueue({ ...s, config, shouldStop: () => stop, log: () => {} });
  const items = s.store.items(s.job.id);
  assert.deepEqual(
    items.map((x) => x.state),
    ['recommended', 'pending'],
  );
  assert.equal(items[0].data.recommendationRecord.decision, 'Include');
  assert.equal(items[0].data.voteRecord, undefined);
  s.store.close();
});

test('worker lock rejects a simultaneous worker and can be released cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-lock-'));
  const release = await acquireWorkerLock(dir);
  await assert.rejects(acquireWorkerLock(dir), /Another queue worker/);
  await release();
  const second = await acquireWorkerLock(dir);
  await second();
});
