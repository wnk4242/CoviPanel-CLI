import { claimKey } from './records.js';
import { isKnownBeforeClick, requiresReview } from './states.js';

// Caller holds the worker lock. Claims, audit updates and the queue reset commit
// together, on the same SQLite connection. Never trust the queue's cached vote
// status over a newer canonical audit record.
export function recoverBeforeClick(store, job, config, studyId, reason) {
  if (!reason?.trim()) throw new Error('Describe why the stopped study is being resumed.');
  if (job.config_hash !== config.configHash || job.review_url !== config.reviewUrl)
    throw new Error('Recovery settings do not match the saved batch.');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const item = store.item(job.id, studyId);
    if (!requiresReview(item.state)) throw new Error('Only a stopped study can be repaired.');
    const key = claimKey(config, studyId);
    const claim = store.db.prepare('SELECT attempt_id FROM vote_claims WHERE claim_key=?').get(key);
    const ids = new Set([claim?.attempt_id, item.data.voteRecord?.attemptId].filter(Boolean));
    const votes = [];
    for (const id of ids) {
      const row = store.db.prepare('SELECT record FROM votes WHERE attempt_id=?').get(id);
      if (!row)
        throw new Error(
          'A vote record is missing. Inspect the database backup; the claim cannot be released.',
        );
      const record = JSON.parse(row.record);
      if (claimKey(record) !== key || !isKnownBeforeClick(record))
        throw new Error(
          'Submission may have started. Use recheck; this vote cannot be reset or clicked again.',
        );
      votes.push(record);
    }
    if (
      item.data.voteRecord &&
      !item.data.voteRecord.attemptId &&
      item.data.voteRecord.status !== 'cancelled'
    )
      throw new Error('The stopped vote has no audit identity; manual investigation is required.');
    if (
      !votes.length &&
      item.data.stage !== 'voting' &&
      item.data.stage !== 'extracting' &&
      !item.data.voteRecord
    ) {
      throw new Error(
        'This is an AI request failure. Reprocess its saved response or explicitly approve retry-api.',
      );
    }
    for (const record of votes) {
      const updated = {
        ...record,
        status: 'cancelled',
        recoveryReason: reason,
        recoveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.db
        .prepare('UPDATE votes SET record=? WHERE attempt_id=?')
        .run(JSON.stringify(updated), record.attemptId);
    }
    if (claim)
      store.db
        .prepare('DELETE FROM vote_claims WHERE claim_key=? AND attempt_id=?')
        .run(key, claim.attempt_id);
    const data = {
      ...item.data,
      voteRecord: null,
      voteRef: null,
      error: null,
      duplicatePrevented: false,
      reviewReason: reason,
      recoveredVoteIds: [...ids],
    };
    const state = data.recommendationRecord?.status === 'recommended' ? 'recommended' : 'pending';
    data.stage = state === 'recommended' ? 'recommended' : 'extracting';
    store.updateInTransaction(job.id, studyId, state, data);
    store.db.exec('COMMIT');
    return store.item(job.id, studyId);
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
