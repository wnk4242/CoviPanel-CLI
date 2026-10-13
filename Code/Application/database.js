import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

// Version zero is the original v1.0 schema, which had no migration number.
// Keep existing columns intact: old jobs, attempts and claims remain readable.
const migrations = [
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, profile TEXT NOT NULL, dataset TEXT NOT NULL, review_url TEXT NOT NULL, config_hash TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS items (job_id TEXT NOT NULL REFERENCES jobs(id), study_id TEXT NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,study_id));
   CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, study_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS job_settings (job_id TEXT PRIMARY KEY REFERENCES jobs(id), config TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS recommendations (run_id TEXT PRIMARY KEY, dataset TEXT NOT NULL, review_url TEXT NOT NULL, study_id TEXT NOT NULL, config_hash TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL, study TEXT, parsed TEXT);
   CREATE INDEX IF NOT EXISTS recommendation_lookup ON recommendations(review_url,study_id,config_hash,status);
   CREATE TABLE IF NOT EXISTS votes (attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS vote_claims (claim_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS project_events (event_id TEXT PRIMARY KEY, review_url TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS project_exports (review_url TEXT PRIMARY KEY, snapshot_hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS verification_locks (attempt_id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, hostname TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS recommendation_payloads (run_id TEXT PRIMARY KEY REFERENCES recommendations(run_id), request TEXT NOT NULL, response TEXT, request_version TEXT NOT NULL, response_hash TEXT);
   CREATE TABLE IF NOT EXISTS parse_attempts (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES recommendations(run_id), parser_version TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS items_state ON items(job_id,state);
   CREATE INDEX IF NOT EXISTS events_job ON events(job_id,created_at,id);
   CREATE INDEX IF NOT EXISTS jobs_review ON jobs(review_url);
   CREATE INDEX IF NOT EXISTS project_events_review ON project_events(review_url);`,
];

/** @param {string} file */
export function openDatabase(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION)
      throw new Error(
        'This database was created by a newer CoviPanel version. Use that version to open it.',
      );
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    if (version < SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Another connection may have migrated while this one waited for the lock.
        const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        for (let next = current; next < SCHEMA_VERSION; next++) {
          db.exec(migrations[next]);
          db.exec(`PRAGMA user_version=${next + 1}`);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
