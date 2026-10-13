import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { withRecords, claimKey, compactVote } from './records.js';
import { screeningDevice } from './screening-device.js';

export async function createAudit(databasePath, initial, onCheckpoint = async () => {}) {
  const attemptId = randomUUID();
  const key = claimKey(initial);
  let record = {
    ...initial,
    attemptId,
    deviceId: screeningDevice().id,
    status: 'prepared',
    createdAt: new Date().toISOString(),
    recordedVote: null,
    voteComparison: 'unverifiable',
  };
  withRecords(databasePath, (store) =>
    store.transaction(() => {
      if (store.db.prepare('SELECT 1 FROM vote_claims WHERE claim_key=?').get(key))
        throw new Error(
          `Study #${initial.studyId} already has an audit claim. Review its saved vote record; no automatic resubmission.`,
        );
      store.saveVote(record);
      store.db.prepare('INSERT INTO vote_claims VALUES (?,?)').run(key, attemptId);
    }),
  );
  const audit = {
    ref: `vote:${attemptId}`,
    get record() {
      return record;
    },
    async save(patch) {
      record = compactVote({ ...record, ...patch, updatedAt: new Date().toISOString() });
      withRecords(databasePath, (store) => store.saveVote(record));
      await onCheckpoint({ record, ref: audit.ref });
    },
    async releaseWithoutClick() {
      withRecords(databasePath, (store) =>
        store.transaction(() => {
          const saved = store.vote(attemptId).record;
          if (!['cancelled', 'blocked_before_click'].includes(saved.status))
            throw new Error('Only an attempt known not to have clicked may release its claim.');
          const owner = store.db
            .prepare('SELECT attempt_id FROM vote_claims WHERE claim_key=?')
            .get(key);
          if (owner?.attempt_id !== attemptId) throw new Error('Audit claim ownership changed.');
          store.db
            .prepare('DELETE FROM vote_claims WHERE claim_key=? AND attempt_id=?')
            .run(key, attemptId);
        }),
      );
    },
  };
  await onCheckpoint({ record, ref: audit.ref });
  return audit;
}

export async function openAuditForVerification(databasePath, attemptId) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId))
    throw new Error('Supply one valid attempt UUID.');
  const token = randomUUID();
  let record = withRecords(databasePath, (store) =>
    store.transaction(() => {
      const r = store.vote(attemptId).record;
      if (
        !['click_intent', 'click_returned', 'uncertain', 'confirmed', 'mismatch'].includes(r.status)
      )
        throw new Error('This attempt is not eligible for post-submission verification.');
      const lock = store.db
        .prepare('SELECT * FROM verification_locks WHERE attempt_id=?')
        .get(attemptId);
      if (lock) {
        let dead = false;
        if (lock.hostname === os.hostname())
          try {
            process.kill(lock.pid, 0);
          } catch (e) {
            dead = e.code === 'ESRCH';
          }
        if (!dead) throw new Error('Verification is already running for this vote.');
        store.db.prepare('DELETE FROM verification_locks WHERE attempt_id=?').run(attemptId);
      }
      store.db
        .prepare('INSERT INTO verification_locks VALUES (?,?,?,?)')
        .run(attemptId, token, process.pid, os.hostname());
      return r;
    }),
  );
  return {
    ref: `vote:${attemptId}`,
    get record() {
      return record;
    },
    async save(patch) {
      record = compactVote({
        ...record,
        ...patch,
        updatedAt: new Date().toISOString(),
        verificationOnly: true,
      });
      withRecords(databasePath, (store) =>
        store.transaction(() => {
          if (
            store.db
              .prepare('SELECT token FROM verification_locks WHERE attempt_id=?')
              .get(attemptId)?.token !== token
          )
            throw new Error('Verification lock ownership changed.');
          store.saveVote(record);
        }),
      );
      return record;
    },
    async close() {
      withRecords(databasePath, (store) =>
        store.db
          .prepare('DELETE FROM verification_locks WHERE attempt_id=? AND token=?')
          .run(attemptId, token),
      );
    },
  };
}
