import { openDatabase } from './database.js';
import { assertQueueTransition } from './states.js';
import { mkdirSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { compactVote, claimKey } from './records.js';
import { assertVotingProfile } from './decisions.js';
import { savedDecisionIds } from './saved-decisions.js';

function compactItemData(data) {
  const { rawResponse, configuration, recommendationDir, voteDir, ...clean } = data;
  if (clean.voteRecord) clean.voteRecord = compactVote(clean.voteRecord);
  if (clean.recommendationRecord?.runId)
    clean.recommendationRef = `recommendation:${clean.recommendationRecord.runId}`;
  if (clean.voteRecord?.attemptId) clean.voteRef = `vote:${clean.voteRecord.attemptId}`;
  return clean;
}
function queueEvent(data) {
  const d = compactItemData(data);
  return {
    stage: d.stage,
    error: d.error,
    reviewReason: d.reviewReason,
    previousRecommendationId: d.previousRecommendationId,
    recommendationRef: d.recommendationRef,
    decision: d.recommendationRecord?.decision,
    recommendationStatus: d.recommendationRecord?.status,
    voteRef: d.voteRef,
    voteStatus: d.voteRecord?.status,
    recordedVote: d.voteRecord?.recordedVote,
    from: d.from,
    to: d.to,
    reusedRecommendation: d.reusedRecommendation,
    duplicatePrevented: d.duplicatePrevented,
    batchReview: d.batchReview,
    batchApproval: d.batchApproval,
    savedWithoutSubmission: d.savedWithoutSubmission,
  };
}

export function parseIds(text) {
  const result = new Set();
  const tokens = String(text)
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (!tokens.length) throw new Error('The study queue is empty.');
  for (const token of tokens) {
    const match = token.match(/^#?([1-9]\d*)(?:-#?([1-9]\d*))?$/);
    if (!match) throw new Error(`Invalid study ID or range: ${token}`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end < start ||
      end - start > 10000
    )
      throw new Error('Invalid or oversized study range.');
    for (let id = start; id <= end; id++) {
      result.add(String(id));
      if (result.size > 10000) throw new Error('Maximum queue size is 10,000 distinct studies.');
    }
  }
  return [...result];
}

export async function acquireWorkerLock(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'worker.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        if (JSON.parse(await readFile(file, 'utf8')).token === token) await unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(file, 'utf8'));
      if (owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Queue lock needs manual review.', { cause: error });
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') {
          await unlink(file);
          continue;
        }
      }
      throw new Error(
        'Another queue worker is running. Stop it before starting or resuming another job.',
        { cause: error },
      );
    }
  }
  throw new Error('Could not acquire queue worker lock.');
}

export class QueueStore {
  constructor(file) {
    this.db = openDatabase(file);
  }
  create(config, ids, mode, references = {}) {
    if (!['recommend-only', 'confirm-each-vote', 'auto-vote', 'review-all'].includes(mode))
      throw new Error('Invalid queue mode.');
    if (mode !== 'recommend-only') assertVotingProfile(config);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved = savedDecisionIds(this.db, config.reviewUrl);
      if (ids.some((studyId) => saved.has(studyId)))
        throw new Error(
          'This selection contains decisions saved without submission. They are excluded from new batches.',
        );
      this.db
        .prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)')
        .run(id, config.profile, config.dataset, config.reviewUrl, config.configHash, mode, now);
      this.db.prepare('INSERT INTO job_settings VALUES (?,?)').run(id, JSON.stringify(config));
      const insert = this.db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?)');
      ids.forEach((studyId, index) =>
        insert.run(
          id,
          studyId,
          index,
          'pending',
          JSON.stringify({ referenceDecision: references[studyId] ?? null }),
          now,
        ),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.job(id);
  }
  job(id) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job) throw new Error('Queue job not found.');
    return job;
  }
  settings(id) {
    const row = this.db.prepare('SELECT config FROM job_settings WHERE job_id=?').get(id);
    return row ? JSON.parse(row.config) : null;
  }
  clearedBatchIds() {
    const cleared = new Set();
    const changes = this.db
      .prepare(
        "SELECT kind,data FROM project_events WHERE kind IN ('batch_cleared','batch_restored') ORDER BY rowid",
      )
      .all();
    for (const change of changes) {
      const { jobId } = JSON.parse(change.data);
      if (change.kind === 'batch_cleared') cleared.add(jobId);
      else cleared.delete(jobId);
    }
    return cleared;
  }
  preserveSettings(config) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO job_settings SELECT id,? FROM jobs WHERE config_hash=? AND profile=?',
      )
      .run(JSON.stringify(config), config.configHash, config.profile);
  }

  enableBatchReview(id) {
    const job = this.job(id);
    if (job.mode === 'review-all') return job;
    assertVotingProfile(this.settings(id) || {});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE jobs SET mode=? WHERE id=?').run('review-all', id);
      for (const item of this.items(id))
        this.db
          .prepare('INSERT INTO events(job_id,study_id,state,data,created_at) VALUES (?,?,?,?,?)')
          .run(
            id,
            item.study_id,
            'mode_changed',
            JSON.stringify({ from: job.mode, to: 'review-all' }),
            new Date().toISOString(),
          );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.job(id);
  }
  items(id) {
    this.job(id);
    return this.db
      .prepare('SELECT * FROM items WHERE job_id=? ORDER BY ordinal')
      .all(id)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }
  item(id, studyId) {
    const row = this.db
      .prepare('SELECT * FROM items WHERE job_id=? AND study_id=?')
      .get(id, studyId);
    if (!row) throw new Error('Queue item not found.');
    return { ...row, data: JSON.parse(row.data) };
  }
  counts(id) {
    this.job(id);
    return Object.fromEntries(
      this.db
        .prepare('SELECT state,COUNT(*) AS count FROM items WHERE job_id=? GROUP BY state')
        .all(id)
        .map((row) => [row.state, row.count]),
    );
  }
  updateInTransaction(jobId, studyId, state, data) {
    const current = this.db
      .prepare('SELECT state FROM items WHERE job_id=? AND study_id=?')
      .get(jobId, studyId);
    if (!current) throw new Error('Queue item not found.');
    assertQueueTransition(current.state, state);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE items SET state=?,data=?,updated_at=? WHERE job_id=? AND study_id=?')
      .run(state, JSON.stringify(compactItemData(data)), now, jobId, studyId);
    this.db
      .prepare('INSERT INTO events(job_id,study_id,state,data,created_at) VALUES (?,?,?,?,?)')
      .run(jobId, studyId, state, JSON.stringify(queueEvent(data)), now);
  }
  update(jobId, studyId, state, data) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.updateInTransaction(jobId, studyId, state, data);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recover(id) {
    const job = this.job(id);
    for (const item of this.items(id).filter((row) => row.state === 'processing')) {
      const data = item.data;
      if (data.stage === 'voting' || data.voteRecord) {
        const key = claimKey({ reviewUrl: job.review_url }, item.study_id);
        const claim = this.db
          .prepare('SELECT attempt_id FROM vote_claims WHERE claim_key=?')
          .get(key);
        const attemptId = claim?.attempt_id || data.voteRecord?.attemptId;
        if (attemptId) {
          const row = this.db.prepare('SELECT record FROM votes WHERE attempt_id=?').get(attemptId);
          data.voteRecord = row
            ? JSON.parse(row.record)
            : { attemptId, status: 'uncertain', error: 'Canonical vote record is missing.' };
          data.voteRef = `vote:${attemptId}`;
        }
      }
      if (data.recommendationRecord?.runId) {
        const row = this.db
          .prepare('SELECT record FROM recommendations WHERE run_id=?')
          .get(data.recommendationRecord.runId);
        if (row) data.recommendationRecord = JSON.parse(row.record);
      }
      const voteStatus = data.voteRecord?.status;
      let state = 'needs_review';
      if (voteStatus === 'confirmed') {
        state = 'completed';
        data.error = null;
      } else if (data.voteRecord || data.stage === 'voting')
        data.error =
          'Interrupted vote: inspect the saved record and verify any potentially submitted vote before continuing.';
      else if (data.recommendationRecord?.status === 'recommended') state = 'recommended';
      else if (data.stage === 'extracting' || data.recommendationRecord?.status === 'extracting')
        state = 'pending';
      else
        data.error =
          'Interrupted API request or response processing: inspect saved evidence before explicitly retrying.';
      this.update(id, item.study_id, state, data);
    }
  }
  close() {
    this.db.close();
  }
}
