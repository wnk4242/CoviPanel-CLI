import { randomUUID } from 'node:crypto';
import { claimKey } from './records.js';
import { hash } from './profiles.js';
import { assertReview } from './covidence.js';

const sameReview = (a, b) =>
  a && b && claimKey({ reviewUrl: a }, '1') === claimKey({ reviewUrl: b }, '1');
const knownVote = (vote) =>
  ['confirmed', 'mismatch'].includes(vote.status) &&
  ['Yes', 'No', 'Maybe'].includes(vote.recordedVote);

// Saved-only choices apply to this study/review, including batches with older settings.
export function savedDecisionIds(db, reviewUrl) {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT i.study_id,j.review_url FROM items i JOIN jobs j ON j.id=i.job_id
    WHERE json_extract(i.data,'$.savedWithoutSubmission.id') IS NOT NULL`,
      )
      .all()
      .filter((row) => sameReview(row.review_url, reviewUrl))
      .map((row) => row.study_id),
  );
}

function savedRows(db, reviewUrl) {
  return db
    .prepare(
      `SELECT i.*,j.review_url FROM items i JOIN jobs j ON j.id=i.job_id
    WHERE json_extract(i.data,'$.savedWithoutSubmission.id') IS NOT NULL ORDER BY i.updated_at`,
    )
    .all()
    .filter((row) => sameReview(row.review_url, reviewUrl))
    .map((row) => ({ ...row, data: JSON.parse(row.data) }));
}

function voteRows(db, reviewUrl) {
  return db
    .prepare(
      `SELECT attempt_id,
    json_extract(record,'$.reviewUrl') AS reviewUrl,
    json_extract(record,'$.studyId') AS studyId,
    json_extract(record,'$.status') AS status,
    json_extract(record,'$.recordedVote') AS recordedVote,
    json_extract(record,'$.clickedAt') AS clickedAt,
    json_extract(record,'$.deviceId') AS deviceId,
    json_extract(record,'$.recommendationRunId') AS recommendationRunId
    FROM votes`,
    )
    .all()
    .filter((row) => sameReview(row.reviewUrl, reviewUrl));
}

export function submissionCounts(
  db,
  reviewUrl,
  { now = new Date(), deviceId, assigned = new Map() } = {},
) {
  const recommendations = db
    .prepare("SELECT review_url,study_id FROM recommendations WHERE status='recommended'")
    .all()
    .filter((row) => sameReview(row.review_url, reviewUrl));
  const screened = new Set(recommendations.map((row) => row.study_id));
  const votes = voteRows(db, reviewUrl).filter(knownVote);
  const submitted = new Set(votes.map((vote) => vote.studyId));
  for (const row of savedRows(db, reviewUrl))
    if (row.data.savedVoteCheck?.outcome === 'voted') submitted.add(row.study_id);
  // Only an actual AI-backed click on this device can contribute to today.
  // A later read-only check has checkedAt, never a fabricated clickedAt/device.
  const first = new Map();
  for (const vote of votes) {
    if (
      !vote.recommendationRunId ||
      !deviceId ||
      (vote.deviceId || assigned.get('vote:' + vote.attempt_id)) !== deviceId
    )
      continue;
    const time = Date.parse(vote.clickedAt);
    if (Number.isFinite(time) && (!first.has(vote.studyId) || time < first.get(vote.studyId)))
      first.set(vote.studyId, time);
  }
  return {
    submittedToday: [...first.values()].filter(
      (time) => new Date(time).toDateString() === now.toDateString(),
    ).length,
    screenedNotSubmitted: [...screened].filter((id) => !submitted.has(id)).length,
  };
}

// Caller holds the worker/browser lock. History checks never press a vote button.
// The spreadsheet keeps the saved AI/review decision; manual votes are separate evidence.
export async function reconcileSavedDecisions(db, page, reviewUrl, { reviewer, verify } = {}) {
  const rows = savedRows(db, reviewUrl);
  const submitted = new Set(
    voteRows(db, reviewUrl)
      .filter(knownVote)
      .map((v) => v.studyId),
  );
  const pending = new Map(
    rows
      .filter((row) => !submitted.has(row.study_id) && row.data.savedVoteCheck?.outcome !== 'voted')
      .map((row) => [row.study_id, row]),
  );
  if (!pending.size) return { checked: 0, voted: 0, uncertain: 0 };
  verify ||= (await import('./reset-verification.js')).verifyResetVote;
  const counts = { checked: 0, voted: 0, uncertain: 0 };
  for (const target of pending.values()) {
    const source = target.data.recommendationRecord;
    let result;
    try {
      result = await verify(
        page,
        { reviewUrl, studyId: target.study_id, timeoutMs: 8000 },
        { title: source?.title },
      );
      if (!['voted', 'not_voted'].includes(result.outcome))
        throw new Error(result.reason || 'Cannot confirm this vote.');
      if (
        !sameReview(result.reviewUrl, reviewUrl) ||
        result.studyId !== target.study_id ||
        !result.reviewerIdentity?.name ||
        (reviewer && result.reviewerIdentity.name !== reviewer) ||
        !Number.isFinite(Date.parse(result.checkedAt)) ||
        Math.abs(Date.now() - Date.parse(result.checkedAt)) > 60000 ||
        (result.outcome === 'voted' && !['Yes', 'No', 'Maybe'].includes(result.recordedVote))
      )
        throw new Error('Verification evidence is stale or belongs to a different study/account.');
      assertReview(result.url, reviewUrl);
    } catch (error) {
      result = { outcome: 'uncertain', reason: error.message, checkedAt: new Date().toISOString() };
    }
    counts.checked++;
    if (result.outcome === 'voted') counts.voted++;
    if (result.outcome === 'uncertain') counts.uncertain++;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows.filter((row) => row.study_id === target.study_id)) {
        const current = db
          .prepare('SELECT data FROM items WHERE job_id=? AND study_id=?')
          .get(row.job_id, row.study_id);
        const data = current && JSON.parse(current.data);
        if (!data || hash(data.savedWithoutSubmission) !== hash(row.data.savedWithoutSubmission))
          throw new Error('Saved decision changed during verification. Refresh again.');
        db.prepare('UPDATE items SET data=? WHERE job_id=? AND study_id=?').run(
          JSON.stringify({ ...data, savedVoteCheck: result }),
          row.job_id,
          row.study_id,
        );
      }
      // Keep checks separate from votes; observed time is not submission time.
      db.prepare('INSERT INTO project_events VALUES (?,?,?,?,?)').run(
        randomUUID(),
        reviewUrl,
        result.checkedAt,
        'saved_decision_vote_checked',
        JSON.stringify({
          studyId: target.study_id,
          verification: result,
          message: `Study #${target.study_id}: saved-only decision checked in Covidence; ${result.outcome === 'voted' ? 'manual vote ' + result.recordedVote + ' verified' : result.outcome === 'not_voted' ? 'not voted' : 'cannot confirm'}. No vote submitted by this check.`,
        }),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return counts;
}
