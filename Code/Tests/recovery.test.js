import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { QueueStore } from '../Application/queue-store.js';
import { createAudit } from '../Application/audit.js';
import { withRecords } from '../Application/records.js';
import { recoverBeforeClick } from '../Application/recovery.js';
import { assertQueueTransition } from '../Application/states.js';
import { loadProfile } from './fixtures.js';
import { runQueue } from '../Application/queue-runner.js';
import { studyHash } from '../Application/profiles.js';

async function fixture() {
  const database = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-recovery-')),
    'screening.sqlite',
  );
  const config = await loadProfile('demo', '1');
  const store = new QueueStore(database),
    job = store.create(config, ['1'], 'auto-vote');
  store.update(job.id, '1', 'processing', {
    stage: 'voting',
    recommendationRecord: { status: 'recommended', runId: 'retained-recommendation' },
  });
  const audit = await createAudit(database, {
    ...config,
    studyId: '1',
    decision: 'Include',
    expectedButton: 'Yes',
  });
  return { database, config, store, job, audit };
}

for (const status of ['prepared', 'awaiting_confirmation', 'cancelled', 'blocked_before_click']) {
  test(`pre-click ${status} can resume while retaining its audit and recommendation`, async () => {
    const f = await fixture();
    try {
      await f.audit.save({ status });
      if (['cancelled', 'blocked_before_click'].includes(status))
        await f.audit.releaseWithoutClick();
      f.store.update(f.job.id, '1', 'processing', {
        stage: 'voting',
        voteRecord: f.audit.record,
        recommendationRecord: { status: 'recommended', runId: 'retained-recommendation' },
      });
      f.store.recover(f.job.id);
      const item = recoverBeforeClick(
        f.store,
        f.job,
        f.config,
        '1',
        'Reviewed the stopped preparation',
      );
      assert.equal(item.state, 'recommended');
      assert.equal(item.data.recommendationRecord.runId, 'retained-recommendation');
      assert.equal(item.data.voteRecord, null);
      assert.equal(
        withRecords(f.database, (s) => s.existingVote(f.config, '1')),
        null,
      );
      const saved = withRecords(f.database, (s) => s.vote(f.audit.record.attemptId));
      assert.equal(saved.record.status, 'cancelled');
      assert.match(saved.record.recoveryReason, /Reviewed/);
      assert.ok(
        f.store.db
          .prepare("SELECT data FROM events WHERE state='recommended'")
          .all()
          .some((row) => row.data.includes('Reviewed')),
      );
    } finally {
      f.store.close();
    }
  });
}

for (const status of ['click_intent', 'click_returned', 'uncertain', 'confirmed', 'mismatch']) {
  test(`${status} canonical record prevents reset even when the queue says prepared`, async () => {
    const f = await fixture();
    try {
      f.store.update(f.job.id, '1', 'needs_review', {
        stage: 'voting',
        voteRecord: f.audit.record,
      });
      await f.audit.save({ status });
      assert.throws(
        () => recoverBeforeClick(f.store, f.job, f.config, '1', 'Attempt recovery'),
        /Submission may have started/,
      );
      assert.equal(
        withRecords(f.database, (s) => s.existingVote(f.config, '1')).record.status,
        status,
      );
      assert.equal(f.store.item(f.job.id, '1').state, 'needs_review');
    } finally {
      f.store.close();
    }
  });
}

test('a crash after claim creation but before queue checkpoint is recoverable', async () => {
  const f = await fixture();
  try {
    f.store.db.prepare('DELETE FROM vote_claims').run();
    const source = new URL('../Application/audit.js', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import {createAudit} from ${JSON.stringify(source)};await createAudit(${JSON.stringify(f.database)},${JSON.stringify({ ...f.config, studyId: '1' })},()=>process.exit(23));`,
    ]);
    assert.equal(child.status, 23);
    f.store.recover(f.job.id);
    const item = recoverBeforeClick(
      f.store,
      f.job,
      f.config,
      '1',
      'Recover interrupted preparation',
    );
    assert.equal(item.state, 'recommended');
    assert.equal(item.data.recoveredVoteIds.length, 1);
  } finally {
    f.store.close();
  }
});

test('a failed queue reset rolls back claim release and audit updates together', async () => {
  const f = await fixture();
  try {
    f.store.recover(f.job.id);
    f.store.db.exec(
      "CREATE TRIGGER reject_recovery BEFORE UPDATE ON items WHEN NEW.state='recommended' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;",
    );
    assert.throws(
      () => recoverBeforeClick(f.store, f.job, f.config, '1', 'Reviewed'),
      /simulated disk failure/,
    );
    assert.equal(
      withRecords(f.database, (s) => s.existingVote(f.config, '1')).record.status,
      'prepared',
    );
    assert.equal(f.store.item(f.job.id, '1').state, 'needs_review');
  } finally {
    f.store.close();
  }
});

test('state validation prevents accidental replay of completed work', () => {
  assert.throws(() => assertQueueTransition('completed', 'pending'), /Unsupported/);
  assert.throws(() => assertQueueTransition('pending', 'misspelled'), /Unsupported/);
  assert.doesNotThrow(() => assertQueueTransition('needs_review', 'recommended'));
});

test('confirmation committed before a queue checkpoint is recovered from the canonical audit', async () => {
  const f = await fixture();
  try {
    await f.audit.save({ status: 'confirmed', recordedVote: 'Yes' });
    f.store.recover(f.job.id);
    assert.equal(f.store.item(f.job.id, '1').state, 'completed');
    assert.equal(f.store.item(f.job.id, '1').data.voteRecord.attemptId, f.audit.record.attemptId);
    assert.ok(withRecords(f.database, (s) => s.existingVote(f.config, '1')));
  } finally {
    f.store.close();
  }
});

test('repaired preparation reuses its recommendation and continues with exactly one vote', async () => {
  const f = await fixture();
  let votes = 0;
  const study = {
    ready: true,
    studyId: '1',
    title: 'Synthetic source',
    abstract: 'Synthetic abstract.',
  };
  try {
    f.store.recover(f.job.id);
    recoverBeforeClick(f.store, f.job, f.config, '1', 'Reviewed interrupted preparation');
    await runQueue({
      store: f.store,
      job: f.job,
      config: f.config,
      log: () => {},
      operations: {
        existingVote: async () => withRecords(f.database, (s) => s.existingVote(f.config, '1')),
        extract: async () => study,
        cached: async () => ({
          record: {
            runId: 'retained-recommendation',
            status: 'recommended',
            studyHash: studyHash(study),
            decision: 'Maybe',
          },
        }),
        recommend: async () => assert.fail('Recovery must reuse the saved recommendation'),
        vote: async () => {
          votes++;
          return { record: { status: 'confirmed' } };
        },
      },
    });
    assert.equal(votes, 1);
    assert.equal(f.store.item(f.job.id, '1').state, 'completed');
  } finally {
    f.store.close();
  }
});
