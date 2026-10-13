import { openDatabase } from './database.js';
import { hash } from './profiles.js';

export function compactVote(record) {
  const { screenshots, ...clean } = record;
  if (clean.targetEvidence) {
    const { html, ...target } = clean.targetEvidence;
    clean.targetEvidence = target;
  }
  if (clean.beforeHistory) clean.beforeHistory = { rows: clean.beforeHistory.rows };
  if (clean.observations)
    clean.observations = clean.observations.map(({ url, recordedVote, addedRows, reason }) => ({
      url,
      recordedVote,
      addedRows,
      reason,
    }));
  return clean;
}

export function claimKey(config, studyId = config.studyId) {
  const url = new URL(config.reviewUrl),
    reviewId = url.pathname.match(/^\/reviews\/(\d+)(?:\/|$)/)?.[1];
  if (!reviewId || (config.reviewId && config.reviewId !== reviewId))
    throw new Error('Vote claim review identity is invalid.');
  return `${url.hostname}-${reviewId}-${studyId}`;
}

export class RecordStore {
  constructor(file) {
    this.db = openDatabase(file);
  }
  recommendation(id) {
    const row = this.db
      .prepare('SELECT record,study,parsed FROM recommendations WHERE run_id=?')
      .get(id);
    if (!row) throw new Error('Saved recommendation not found.');
    return {
      record: JSON.parse(row.record),
      study: row.study ? JSON.parse(row.study) : null,
      parsed: row.parsed ? JSON.parse(row.parsed) : null,
      ref: `recommendation:${id}`,
    };
  }
  saveRecommendation({ record, study = null, parsed = null }) {
    this.db
      .prepare(
        `INSERT INTO recommendations VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,record=excluded.record,study=excluded.study,parsed=excluded.parsed`,
      )
      .run(
        record.runId,
        record.dataset,
        record.reviewUrl,
        record.studyId,
        record.configHash,
        record.status,
        JSON.stringify(record),
        study ? JSON.stringify(study) : null,
        parsed ? JSON.stringify(parsed) : null,
      );
  }
  savePayload(runId, { request, response, requestVersion = '1' }) {
    const existing = this.payload(runId);
    if (existing && hash(existing.request) !== hash(request))
      throw new Error('A saved request cannot be replaced.');
    if (existing?.response && response && hash(existing.response) !== hash(response))
      throw new Error('A saved API response cannot be replaced.');
    this.db
      .prepare(
        `INSERT INTO recommendation_payloads VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET response=COALESCE(recommendation_payloads.response,excluded.response),response_hash=COALESCE(recommendation_payloads.response_hash,excluded.response_hash)`,
      )
      .run(
        runId,
        JSON.stringify(request),
        response ? JSON.stringify(response) : null,
        requestVersion,
        response ? hash(response) : null,
      );
  }
  payload(runId) {
    const row = this.db.prepare('SELECT * FROM recommendation_payloads WHERE run_id=?').get(runId);
    return row
      ? {
          request: JSON.parse(row.request),
          response: row.response ? JSON.parse(row.response) : null,
          requestVersion: row.request_version,
          responseHash: row.response_hash,
        }
      : null;
  }
  parseAttempt(runId, parserVersion, status, error = null) {
    this.db
      .prepare(
        'INSERT INTO parse_attempts(run_id,parser_version,status,error,created_at) VALUES (?,?,?,?,?)',
      )
      .run(runId, parserVersion, status, error, new Date().toISOString());
  }
  recommendationIds(config, id) {
    return this.db
      .prepare(
        "SELECT run_id FROM recommendations WHERE review_url=? AND study_id=? AND config_hash=? AND status='recommended' ORDER BY rowid DESC",
      )
      .all(config.reviewUrl, id, config.configHash)
      .map((row) => row.run_id);
  }
  recommendationAttempts(config, id) {
    return this.db
      .prepare(
        'SELECT record FROM recommendations WHERE review_url=? AND study_id=? AND config_hash=? ORDER BY rowid DESC',
      )
      .all(config.reviewUrl, id, config.configHash)
      .map((row) => JSON.parse(row.record));
  }
  projectEvent(id, reviewUrl, kind, data, createdAt = new Date().toISOString()) {
    this.db
      .prepare('INSERT OR IGNORE INTO project_events VALUES (?,?,?,?,?)')
      .run(id, reviewUrl, createdAt, kind, JSON.stringify(data));
  }
  vote(id) {
    const row = this.db.prepare('SELECT record FROM votes WHERE attempt_id=?').get(id);
    if (!row) throw new Error('Saved vote record not found.');
    return { record: JSON.parse(row.record), ref: `vote:${id}` };
  }
  saveVote(record) {
    this.db
      .prepare(
        'INSERT INTO votes VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET record=excluded.record',
      )
      .run(record.attemptId, JSON.stringify(compactVote(record)));
  }
  existingVote(config, id) {
    const claim = this.db
      .prepare('SELECT attempt_id FROM vote_claims WHERE claim_key=?')
      .get(claimKey(config, id));
    if (!claim) return null;
    try {
      return this.vote(claim.attempt_id);
    } catch {
      return {
        ref: `vote:${claim.attempt_id}`,
        record: {
          attemptId: claim.attempt_id,
          status: 'uncertain',
          error: 'Retained claim has no readable vote record.',
        },
      };
    }
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}

export function withRecords(file, work) {
  const store = new RecordStore(file);
  try {
    return work(store);
  } finally {
    store.close();
  }
}
