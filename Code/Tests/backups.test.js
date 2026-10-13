import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { createAudit } from '../Application/audit.js';
import { openDatabase, SCHEMA_VERSION } from '../Application/database.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../Application/backups.js';
import { loadProfile } from './fixtures.js';

test('backup captures committed WAL work and restore retains jobs, settings and vote claims', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-backup-')),
    source = path.join(dir, 'active.sqlite'),
    backup = path.join(dir, 'backup.sqlite'),
    restored = path.join(dir, 'restored.sqlite');
  const config = await loadProfile('demo', '1'),
    store = new QueueStore(source);
  const job = store.create(config, ['1'], 'auto-vote');
  const audit = await createAudit(source, { ...config, studyId: '1' });
  await audit.save({ status: 'click_intent' });
  try {
    store.update(job.id, '1', 'needs_review', { stage: 'voting', voteRecord: audit.record });
    assert.ok((await readFile(source + '-wal')).length > 0);
    const summary = await backupDatabase(source, backup);
    assert.equal(summary.claims, 1);
    assert.equal(summary.jobs, 1);
    await restoreDatabase(backup, restored);
    const copy = new QueueStore(restored);
    try {
      assert.deepEqual(copy.settings(job.id), config);
      assert.equal(copy.item(job.id, '1').state, 'needs_review');
    } finally {
      copy.close();
    }
    assert.equal(
      withRecords(restored, (s) => s.existingVote(config, '1')).record.status,
      'click_intent',
    );
    await assert.rejects(backupDatabase(source, backup), (error) => error.code === 'EEXIST');
  } finally {
    store.close();
  }
});

test('restore validates input, refuses implicit replacement and preserves the previous database', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-restore-')),
    source = path.join(dir, 'source.sqlite'),
    destination = path.join(dir, 'destination.sqlite'),
    bad = path.join(dir, 'bad.sqlite');
  const config = await loadProfile('demo', '1');
  for (const [file, id] of [
    [source, '1'],
    [destination, '2'],
  ]) {
    const store = new QueueStore(file);
    store.create(config, [id], 'recommend-only');
    store.close();
  }
  await writeFile(bad, 'Not a database');
  const before = await readFile(destination);
  await assert.rejects(restoreDatabase(bad, destination, { replace: true }));
  assert.deepEqual(await readFile(destination), before);
  await assert.rejects(restoreDatabase(source, destination), /explicitly approved/);
  const result = await restoreDatabase(source, destination, { replace: true });
  assert.ok(result.previous);
  assert.equal(validateDatabase(result.previous).jobs, 1);
  const db = new DatabaseSync(result.previous, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT study_id FROM items').get().study_id, '2');
  } finally {
    db.close();
  }
});

test('migration preserves v1.0 rows and claims, is idempotent and rejects future schemas', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-migration-')),
    file = path.join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE votes(attempt_id TEXT PRIMARY KEY,record TEXT NOT NULL); CREATE TABLE vote_claims(claim_key TEXT PRIMARY KEY,attempt_id TEXT NOT NULL); INSERT INTO votes VALUES ('legacy','{\"status\":\"uncertain\"}'); INSERT INTO vote_claims VALUES ('claim','legacy');",
  );
  legacy.close();
  for (let n = 0; n < 2; n++) {
    const db = openDatabase(file);
    try {
      assert.equal(db.prepare('SELECT record FROM votes').get().record, '{"status":"uncertain"}');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vote_claims').get().n, 1);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=999');
  db.close();
  assert.throws(() => openDatabase(file), /newer/);
});
