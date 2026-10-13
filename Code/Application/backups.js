import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, open, rename, rm, stat, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './database.js';

export function validateDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get().user_version > SCHEMA_VERSION)
      throw new Error('The backup requires a newer CoviPanel version.');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('Database integrity check failed.');
    for (const name of [
      'jobs',
      'items',
      'events',
      'job_settings',
      'recommendations',
      'votes',
      'vote_claims',
    ]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
        throw new Error(`This is not a complete CoviPanel database: missing ${name}.`);
    }
    return {
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      jobs: db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
      claims: db.prepare('SELECT COUNT(*) AS n FROM vote_claims').get().n,
    };
  } finally {
    db.close();
  }
}

// VACUUM INTO creates a consistent SQLite snapshot, including committed WAL
// contents. Copying only the live .sqlite file could lose those transactions.
export async function backupDatabase(source, destination) {
  validateDatabase(source);
  if (path.resolve(source) === path.resolve(destination))
    throw new Error('Backup destination must differ from the active database.');
  await mkdir(path.dirname(destination), { recursive: true });
  const reserved = await open(destination, 'wx');
  await reserved.close();
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    db.prepare('VACUUM INTO ?').run(path.resolve(destination));
    db.close();
    db = null;
    return {
      file: destination,
      ...validateDatabase(destination),
      bytes: (await stat(destination)).size,
    };
  } catch (error) {
    db?.close();
    await rm(destination, { force: true });
    throw error;
  }
}

// Caller holds the worker lock. Replacement is opt-in and always preserves a
// validated copy of the current database before the atomic swap.
export async function restoreDatabase(source, destination, { replace = false } = {}) {
  validateDatabase(source);
  if (path.resolve(source) === path.resolve(destination))
    throw new Error('Restore source must differ from the active database.');
  let exists = false;
  try {
    await access(destination);
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists && !replace)
    throw new Error('Restore destination already exists; replacement must be explicitly approved.');
  const temporary = `${destination}.restore-${randomUUID()}.sqlite`;
  const previous = exists ? `${destination}.before-restore-${randomUUID()}.sqlite` : null;
  try {
    await backupDatabase(source, temporary);
    if (exists) {
      await backupDatabase(destination, previous);
      const db = new DatabaseSync(destination);
      try {
        if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy)
          throw new Error('The database is still in use. Close the other CoviPanel instance.');
      } finally {
        db.close();
      }
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        await access(destination + suffix);
        throw new Error(
          'Database journal files remain. Close the other CoviPanel instance before restoring.',
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (exists) await rename(temporary, destination);
    else await link(temporary, destination); // Atomic no-overwrite publication of a new recovery file.
    return { file: destination, previous, ...validateDatabase(destination) };
  } finally {
    await rm(temporary, { force: true });
  }
}
