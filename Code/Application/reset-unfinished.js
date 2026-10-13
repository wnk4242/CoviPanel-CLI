import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hash } from './profiles.js';
import { claimKey } from './records.js';
import { reviewKey } from './project-history.js';
import { finishedItem, isKnownBeforeClick } from './states.js';
import { decisionMap } from './decisions.js';
import { verifyResetVote } from './reset-verification.js';
import { compareHistory } from './vote.js';
import { showScreen } from './terminal-screen.js';

export async function confirmManualReset(studyId, question, show = showScreen) {
  show(
    'CoviPanel | Reset unfinished study',
    [
      `Study #${studyId}`,
      'The automatic check could not confirm your vote.',
      '1. I checked Covidence: no vote submitted — reset this study',
      '0. Keep the record and return',
    ],
    '',
  );
  return (await question('Choose an option (Enter cancels): ')).trim() === '1';
}

// The worker owns the queue lock throughout the online check and local commit.
function studyRows(db, reviewUrl, studyId) {
  const same = (url) => reviewKey(url) === reviewKey(reviewUrl);
  const jobs = db
    .prepare('SELECT * FROM jobs')
    .all()
    .filter((j) => same(j.review_url));
  const jobIds = new Set(jobs.map((j) => j.id));
  const recommendations = db
    .prepare('SELECT * FROM recommendations WHERE study_id=?')
    .all(studyId)
    .filter((r) => same(r.review_url));
  const runs = new Set(recommendations.map((r) => r.run_id));
  return {
    items: db
      .prepare('SELECT * FROM items WHERE study_id=?')
      .all(studyId)
      .filter((r) => jobIds.has(r.job_id)),
    events: db
      .prepare('SELECT * FROM events WHERE study_id=?')
      .all(studyId)
      .filter((r) => jobIds.has(r.job_id)),
    recommendations,
    recommendation_payloads: db
      .prepare(
        'SELECT p.* FROM recommendation_payloads p JOIN recommendations r ON r.run_id=p.run_id WHERE r.study_id=?',
      )
      .all(studyId)
      .filter((r) => runs.has(r.run_id)),
    parse_attempts: db
      .prepare(
        'SELECT p.* FROM parse_attempts p JOIN recommendations r ON r.run_id=p.run_id WHERE r.study_id=?',
      )
      .all(studyId)
      .filter((r) => runs.has(r.run_id)),
    votes: db
      .prepare('SELECT * FROM votes')
      .all()
      .filter((r) => {
        const v = JSON.parse(r.record);
        return v.studyId === studyId && same(v.reviewUrl);
      }),
    vote_claims: db
      .prepare('SELECT * FROM vote_claims WHERE claim_key=?')
      .all(claimKey({ reviewUrl }, studyId)),
  };
}

export async function resetUnfinished({
  store,
  job,
  studyId,
  page,
  config,
  folder,
  verify = verifyResetVote,
  confirmManual = async () => false,
  shouldStop = () => false,
}) {
  if (shouldStop()) throw new Error('Reset cancelled. Records kept.');
  const item = store.item(job.id, studyId);
  if (finishedItem(item, job.mode) || store.clearedBatchIds().has(job.id))
    throw new Error('This entry is no longer unfinished. Reopen the list.');
  if (reviewKey(config.reviewUrl) !== reviewKey(job.review_url))
    throw new Error('Reset review mismatch.');
  const before = studyRows(store.db, job.review_url, studyId);
  const votes = before.votes.map((r) => JSON.parse(r.record));
  const ids = new Set(votes.map((v) => v.attemptId));
  const refs = before.items.map((r) => JSON.parse(r.data));
  if (
    before.vote_claims.some((r) => !ids.has(r.attempt_id)) ||
    refs.some((d) => {
      const id = d.voteRecord?.attemptId || d.voteRef?.replace(/^vote:/, '');
      return (d.voteRecord && !id) || (id && !ids.has(id));
    })
  )
    throw new Error('A saved vote audit is missing. Records kept for investigation.');
  if (
    votes.some((v) =>
      store.db.prepare('SELECT 1 FROM verification_locks WHERE attempt_id=?').get(v.attemptId),
    )
  )
    throw new Error('Another vote verification is running. Try again when it finishes.');
  const recommendation = before.recommendations.map((r) => JSON.parse(r.record)).at(-1);
  let result;
  try {
    result = await verify(
      page,
      { ...config, studyId },
      {
        title: recommendation?.title || item.data.study?.title || votes.at(-1)?.title,
        votes,
      },
    );
  } catch (error) {
    result = { outcome: 'uncertain', reason: error.message };
  }
  if (shouldStop()) throw new Error('Reset cancelled. Records kept.');
  const completed = before.items.some((r) => finishedItem(r, store.job(r.job_id).mode));
  const imported = store.db
    .prepare(
      "SELECT data FROM project_events WHERE kind='history_workbook_imported' AND review_url=?",
    )
    .all(reviewKey(job.review_url))
    .some((r) => JSON.parse(r.data).rows?.some((row) => row[0] === studyId));
  let manual = false;
  if (!['voted', 'not_voted'].includes(result.outcome)) {
    const onlineVote = [result, ...(result.observations || [])].some(
      (e) =>
        e.recordedVote ||
        e.historyRows?.some(
          (row) => compareHistory([], [row], e.reviewerIdentity?.name).recordedVote,
        ),
    );
    if (!completed && !imported && !onlineVote && votes.every(isKnownBeforeClick)) {
      manual = (await confirmManual({ studyId, reason: result.reason })) === true;
      if (shouldStop()) throw new Error('Reset cancelled. Records kept.');
      if (manual)
        result = {
          outcome: 'not_voted',
          source: 'user_confirmation',
          statement: 'User checked Covidence: no vote submitted.',
          reviewUrl: job.review_url,
          studyId,
          confirmedAt: new Date().toISOString(),
          automaticCheck: result,
        };
    }
  }
  if (!['voted', 'not_voted'].includes(result.outcome))
    return {
      outcome: 'kept',
      message: `${result.reason || 'Covidence could not be checked.'} All records kept; flag unchanged.`,
    };
  if (
    !manual &&
    (result.studyId !== studyId ||
      reviewKey(result.reviewUrl) !== reviewKey(job.review_url) ||
      !result.reviewerIdentity?.name ||
      !Number.isFinite(Date.parse(result.checkedAt)) ||
      Math.abs(Date.now() - Date.parse(result.checkedAt)) > 60000)
  )
    throw new Error(
      'Verification evidence is missing, stale or for a different study. Records kept.',
    );
  if (result.outcome === 'voted' && !['Yes', 'No', 'Maybe'].includes(result.recordedVote))
    throw new Error('Unrecognized recorded vote. Records kept.');

  if (result.outcome === 'not_voted') {
    if (votes.some((v) => v.status === 'confirmed' || v.recordedVote) || completed)
      return {
        outcome: 'kept',
        message:
          'Covidence shows no vote, but saved completed work disagrees. Records and flag kept for review.',
      };
    if (imported)
      return {
        outcome: 'kept',
        message:
          'This study also has imported spreadsheet history. Records kept for review rather than deleting that separate history.',
      };
  }
  const eventId = randomUUID();
  let backupFile;
  if (result.outcome === 'not_voted') {
    backupFile = path.join(folder, 'Backups', `reset-${studyId}-${eventId}.json`);
    await mkdir(path.dirname(backupFile), { recursive: true });
    const payload = { reviewUrl: job.review_url, studyId, verification: result, tables: before };
    await writeFile(
      backupFile,
      JSON.stringify({ ...payload, checksum: hash(payload) }, null, 2) + '\n',
      { flag: 'wx' },
    );
  }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (shouldStop()) throw new Error('Reset cancelled. Records kept.');
    if (
      votes.some((v) =>
        store.db.prepare('SELECT 1 FROM verification_locks WHERE attempt_id=?').get(v.attemptId),
      )
    )
      throw new Error('Vote verification started elsewhere. Records kept; try again afterward.');
    if (hash(studyRows(store.db, job.review_url, studyId)) !== hash(before))
      throw new Error(
        'Study records changed during the online check. Nothing reset; reopen the list.',
      );
    const now = new Date().toISOString();
    if (result.outcome === 'voted') {
      const prior =
        votes.find((v) => v.attemptId === before.vote_claims[0]?.attempt_id) || votes.at(-1);
      const expected =
        prior?.expectedButton || decisionMap[prior?.decision || recommendation?.decision];
      const mismatch = expected && expected !== result.recordedVote;
      // A pre-click failure cannot become proof that this program submitted a vote.
      // Keep that audit intact and record the online observation separately.
      const submitted = prior && !isKnownBeforeClick(prior) ? prior : null;
      const vote = {
        ...submitted,
        attemptId: submitted?.attemptId || randomUUID(),
        reviewUrl: job.review_url,
        studyId,
        title: result.title,
        decision:
          prior?.decision ||
          Object.keys(decisionMap).find((k) => decisionMap[k] === result.recordedVote),
        expectedButton: expected || result.recordedVote,
        recommendationRunId:
          prior?.recommendationRunId || (!mismatch ? recommendation?.runId : null),
        decisionSource: submitted?.decisionSource || 'covidence-history-check',
        status: mismatch ? 'mismatch' : 'confirmed',
        voteComparison: mismatch ? 'mismatch' : 'match',
        recordedVote: result.recordedVote,
        verificationOnly: true,
        reviewerIdentity: result.reviewerIdentity,
        beforeHistory: submitted?.beforeHistory || { rows: [] },
        verificationUrls: submitted?.verificationUrls || [result.url],
        resetVerification: result,
        // Do not assign a new screening/device/date to a read-only history check.
        updatedAt: now,
        error: null,
        reason: mismatch
          ? 'Covidence vote differs from the saved recommendation; record retained for review.'
          : null,
      };
      store.db
        .prepare(
          'INSERT INTO votes VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET record=excluded.record',
        )
        .run(vote.attemptId, JSON.stringify(vote));
      store.db
        .prepare(
          'INSERT INTO vote_claims VALUES (?,?) ON CONFLICT(claim_key) DO UPDATE SET attempt_id=excluded.attempt_id',
        )
        .run(claimKey(config, studyId), vote.attemptId);
      for (const row of before.items) {
        if (finishedItem(row, store.job(row.job_id).mode)) continue;
        store.updateInTransaction(row.job_id, studyId, mismatch ? 'needs_review' : 'completed', {
          ...JSON.parse(row.data),
          voteRecord: vote,
          error: vote.reason,
          reviewReason:
            'Reset checked Covidence History; existing vote retained. No vote submitted.',
        });
      }
    } else {
      for (const row of before.items) {
        store.db
          .prepare('DELETE FROM events WHERE job_id=? AND study_id=?')
          .run(row.job_id, studyId);
        store.db
          .prepare('DELETE FROM items WHERE job_id=? AND study_id=?')
          .run(row.job_id, studyId);
      }
      for (const r of before.recommendations) {
        store.db.prepare('DELETE FROM parse_attempts WHERE run_id=?').run(r.run_id);
        store.db.prepare('DELETE FROM recommendation_payloads WHERE run_id=?').run(r.run_id);
        store.db.prepare('DELETE FROM recommendations WHERE run_id=?').run(r.run_id);
      }
      store.db.prepare('DELETE FROM vote_claims WHERE claim_key=?').run(claimKey(config, studyId));
      for (const v of before.votes)
        store.db.prepare('DELETE FROM votes WHERE attempt_id=?').run(v.attempt_id);
    }
    store.db.prepare('INSERT INTO project_events VALUES (?,?,?,?,?)').run(
      eventId,
      job.review_url,
      now,
      result.outcome === 'not_voted' ? 'study_reset' : 'reset_vote_retained',
      JSON.stringify({
        studyId,
        verification: result,
        backupFile,
        // Tombstones make an additive restore reject stale attempts instead of reviving them.
        ...(result.outcome === 'not_voted'
          ? {
              itemKeys: before.items.map((r) => [r.job_id, r.study_id]),
              runIds: before.recommendations.map((r) => r.run_id),
              voteIds: before.votes.map((r) => r.attempt_id),
              // Reset changes active history, not the fact that screening work happened today.
              screenings: before.recommendations
                .filter((r) => r.status === 'recommended')
                .map((r) => {
                  const record = JSON.parse(r.record);
                  return {
                    ref: `recommendation:${r.run_id}`,
                    deviceId: record.deviceId,
                    screenedAt: record.reprocessedAt || record.updatedAt || record.createdAt,
                  };
                }),
            }
          : {}),
        message:
          result.outcome === 'not_voted'
            ? manual
              ? `Study #${studyId}: User checked Covidence: no vote submitted. Manual reset removed the recommendation and unfinished records; recovery backup: ${backupFile}`
              : `Study #${studyId} reset after Covidence confirmed no vote. Active recommendation and unfinished records removed; recovery backup: ${backupFile}`
            : `Study #${studyId}: Covidence vote ${result.recordedVote} retained. No vote submitted by Reset.`,
      }),
    );
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return {
    outcome: result.outcome,
    message:
      result.outcome === 'not_voted'
        ? manual
          ? 'Manual reset complete. Backup saved, unfinished record removed and warning cleared.'
          : 'Confirmed no Covidence vote: unfinished records removed and flag cleared. A recovery backup was saved.'
        : 'Covidence vote verified: records kept. A matching vote clears the flag; a differing vote remains for review.',
  };
}
