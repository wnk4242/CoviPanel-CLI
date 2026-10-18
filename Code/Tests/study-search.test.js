import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rmdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { historySearchFixture } from './Fixtures/history-search.js';
import { editableHistory, saveHistoryEdit } from '../Application/history-editor.js';
import {
  parseStudyNumber,
  studyHistoryLines,
  searchProjectHistory,
} from '../Application/study-search.js';
import { readProjectHistory, reviewKey } from '../Application/project-history.js';
import { saveRationale } from '../Application/rationale-editor.js';
import { withRecords } from '../Application/records.js';
import { QueueStore } from '../Application/queue-store.js';
import { spreadsheetLibrary } from '../Application/dependencies.js';
import { exportProjectHistory } from '../Application/history-export.js';
import { cancelBatch, readApprovalBatch } from '../Application/batch-approval.js';
import { savedDecisionIds } from '../Application/saved-decisions.js';
import { backupProject, restoreProjectBackup } from '../Application/project-backups.js';
import { projectLocation } from '../Application/projects.js';
import { hash } from '../Application/profiles.js';

test('study-number search is exact, rejects keywords/ranges, and stays inside the selected review', async () => {
  for (const value of ['#123', '123', ' #123 ']) assert.equal(parseStudyNumber(value), '123');
  for (const value of [
    'word',
    '12 3',
    '#0',
    '1-3',
    '123,456',
    '1e3',
    '-1',
    '#0123',
    '9007199254740992',
  ])
    assert.throws(() => parseStudyNumber(value), /one Covidence/);
  const f = await historySearchFixture();
  const history = readProjectHistory(f.file, f.config.reviewUrl);
  assert.match(studyHistoryLines(history, '123').join('\n'), /Synthetic abstract/);
  assert.equal(studyHistoryLines(history, '12'), null);
  assert.equal(
    studyHistoryLines(
      readProjectHistory(f.file, 'https://app.covidence.org/reviews/160736'),
      '123',
    ),
    null,
  );
  assert.throws(
    () => editableHistory(f.file, { ...f.target, studyId: '456' }),
    /no saved decision/,
  );
});

test('local edits preserve sources, queues and verified votes; both sheets retain final edits', async () => {
  for (const realReview of [false, true]) {
    const f = await historySearchFixture(realReview);
    const store = new QueueStore(f.file);
    store.update(f.job.id, '123', 'saved', {
      recommendationRef: 'recommendation:search-fixture',
      savedWithoutSubmission: { id: 'saved' },
    });
    const vote = {
      attemptId: 'verified-vote',
      reviewUrl: f.config.reviewUrl,
      studyId: '123',
      decision: 'Include',
      recordedVote: 'Yes',
      status: 'confirmed',
      recommendationRunId: f.record.runId,
      createdAt: f.record.createdAt,
    };
    withRecords(f.file, (s) => s.saveVote(vote));
    const before = store.db.prepare('SELECT * FROM items').all();
    const current = editableHistory(f.file, f.target);
    await saveHistoryEdit(
      f.file,
      f.target,
      { decision: 'Exclude' },
      { folder: f.folder, expectedToken: current.token },
    );
    await saveRationale(f.file, f.target, 'Wrong age group.', { folder: f.folder });
    await saveHistoryEdit(f.file, f.target, { decision: 'Maybe' }, { folder: f.folder });
    const result = readProjectHistory(f.file, f.config.reviewUrl);
    assert.equal(result.rows[1][2], 'Maybe');
    assert.equal(
      result.rows[1][3],
      f.record.rationale
        .replace('Decision: Include', 'Decision: Maybe')
        .replace('Original explanation.', 'Wrong age group.'),
    );
    assert.equal(result.rows[1].length, 4);
    assert.deepEqual(result.savedOnlyRows[1], result.rows[1]);
    assert.deepEqual(store.db.prepare('SELECT * FROM items').all(), before);
    assert.ok(savedDecisionIds(store.db, f.config.reviewUrl).has('123'));
    assert.deepEqual(withRecords(f.file, (s) => s.recommendation(f.record.runId)).record, f.record);
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT record FROM votes').get().record), vote);
    const lines = studyHistoryLines(result, '123').join('\n');
    assert.match(lines, /Local decision: Maybe/);
    assert.match(lines, /Recorded Covidence vote: Yes/);
    assert.match(lines, /Original explanation/);
    const { Workbook } = await spreadsheetLibrary();
    const workbook = new Workbook();
    await workbook.xlsx.readFile(path.join(f.folder, 'Decision History.xlsx'));
    for (const sheet of workbook.worksheets) {
      assert.equal(sheet.getCell('C2').value, 'Maybe');
      assert.equal(sheet.getCell('D2').value, result.rows[1][3]);
    }
    assert.equal(
      (await exportProjectHistory(f.file, f.config.reviewUrl, { folder: f.folder })).changed,
      false,
    );
    await assert.rejects(
      saveHistoryEdit(
        f.file,
        f.target,
        { decision: 'Include' },
        { folder: f.folder, expectedToken: current.token },
      ),
      /changed while/,
    );
    await assert.rejects(
      saveHistoryEdit(f.file, f.target, { wording: '' }, { folder: f.folder }),
      /blank/,
    );
    await assert.rejects(
      saveHistoryEdit(f.file, f.target, { wording: 'x'.repeat(32768) }, { folder: f.folder }),
      /too long/,
    );
    store.close();
  }
});

test('imported records are editable in demo and standard reviews without adding a verified vote', async () => {
  for (const realReview of [false, true]) {
    const f = await historySearchFixture(realReview);
    const row = ['789', 'Imported study', 'Include', 'Original imported note.'];
    withRecords(f.file, (s) =>
      s.projectEvent('imported', reviewKey(f.config.reviewUrl), 'history_workbook_imported', {
        rows: [row],
      }),
    );
    const target = { ...f.target, studyId: '789' };
    await saveHistoryEdit(
      f.file,
      target,
      { decision: 'Exclude', wording: 'Not enough detail.' },
      { folder: f.folder },
    );
    const result = readProjectHistory(f.file, f.config.reviewUrl);
    assert.deepEqual(
      result.rows.find((r) => r[0] === '789'),
      ['789', 'Imported study', 'Exclude', 'Not enough detail.', ...row.slice(4)],
    );
    assert.match(studyHistoryLines(result, '789').join('\n'), /submission not verified locally/);
    assert.equal(result.studies.find((s) => s.id === '789').recommendations.length, 0);
  }
});

test('failed workbook replacement retains the edit; later source replacement invalidates it', async () => {
  const f = await historySearchFixture();
  const output = path.join(f.folder, 'Decision History.xlsx');
  await mkdir(output);
  await assert.rejects(
    saveHistoryEdit(f.file, f.target, { decision: 'Exclude' }, { folder: f.folder }),
    /saved locally, but Excel/,
  );
  assert.equal(editableHistory(f.file, f.target).decision, 'Exclude');
  await rmdir(output);
  await exportProjectHistory(f.file, f.config.reviewUrl, { folder: f.folder });
  withRecords(f.file, (s) =>
    s.saveRecommendation({
      record: {
        ...f.record,
        runId: 'new-source',
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    }),
  );
  assert.equal(editableHistory(f.file, f.target).decision, 'Include');
});

test('cancelling a prepared batch also removes its search edits and original text', async () => {
  const f = await historySearchFixture();
  const store = new QueueStore(f.file);
  store.update(f.job.id, '456', 'skipped', {});
  const before = readApprovalBatch(f.file, [f.job.id]);
  await saveHistoryEdit(
    f.file,
    f.target,
    { decision: 'Exclude', wording: 'Search edit to cancel.' },
    { folder: f.folder },
  );
  assert.equal(readApprovalBatch(f.file, [f.job.id]).fingerprint, before.fingerprint);
  cancelBatch(f.file, [f.job.id], before.fingerprint);
  const events = store.db.prepare('SELECT * FROM project_events').all();
  assert.doesNotMatch(JSON.stringify(events), /Search edit to cancel|Original explanation/);
  assert.equal(studyHistoryLines(readProjectHistory(f.file, f.config.reviewUrl), '123'), null);
  store.close();
});

test('search UI asks before each edit, cancels blank/no, handles invalid/missing numbers and releases input', async () => {
  const f = await historySearchFixture();
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  output.columns = 110;
  output.rows = 36;
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  const waitFor = async (value) => {
    const deadline = Date.now() + 5000;
    while (!text.includes(value) && Date.now() < deadline) await setTimeout(5);
    assert.ok(text.includes(value), value + '\n' + text);
    text = '';
  };
  const search = searchProjectHistory(f.project, f.file, { input, output, show: () => {} });
  await waitFor('Covidence study number:');
  input.write('word\r');
  await waitFor('Press Enter to continue.');
  input.write('\r');
  await waitFor('Covidence study number:');
  input.write('#12\r');
  await waitFor('Press Enter to continue.');
  input.write('\r');
  await waitFor('Covidence study number:');
  input.write('#123\r');
  await waitFor('Y/N/M: change decision');
  input.write('n');
  await waitFor('Save this decision');
  input.write('\r');
  await waitFor('Y/N/M: change decision');
  assert.equal(editableHistory(f.file, f.target).decision, 'Include');
  input.write('n');
  await waitFor('Save this decision');
  input.write('no\r');
  await waitFor('Y/N/M: change decision');
  input.write('m');
  await waitFor('Save this decision');
  input.write('yes\r');
  await waitFor('Y/N/M: change decision');
  assert.equal(editableHistory(f.file, f.target).decision, 'Maybe');
  input.write('e');
  await waitFor('New rationale (Enter cancels):');
  input.write('\r');
  await waitFor('Y/N/M: change decision');
  input.write('e');
  await waitFor('New rationale (Enter cancels):');
  input.write('Edited note.\r');
  await waitFor('Save this rationale');
  input.write('no\r');
  await waitFor('Y/N/M: change decision');
  assert.equal(editableHistory(f.file, f.target).explanation, 'Original explanation.');
  input.write('e');
  await waitFor('New rationale (Enter cancels):');
  input.write('Edited note.\r');
  await waitFor('Save this rationale');
  input.write('y\r');
  await waitFor('Y/N/M: change decision');
  assert.equal(editableHistory(f.file, f.target).explanation, 'Edited note.');
  input.write('\x1b');
  await waitFor('Covidence study number:');
  input.write('\r');
  await search;
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('project backup restores search edits and rejects an edit-only stale archive after cancellation', async () => {
  const f = await historySearchFixture();
  const root = path.join(f.folder, 'Projects');
  const project = projectLocation(f.config.reviewUrl, root);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'Project settings.json'), JSON.stringify(f.config));
  await saveHistoryEdit(
    f.file,
    f.target,
    { decision: 'Maybe', wording: 'Retained edit.' },
    { folder: f.folder },
  );
  const backup = await backupProject(f.config.reviewUrl, { root, databaseFile: f.file });
  const restored = path.join(f.folder, 'restored.sqlite');
  await restoreProjectBackup(backup.file, {
    root: path.join(f.folder, 'Restored'),
    databaseFile: restored,
  });
  assert.equal(editableHistory(restored, f.target).decision, 'Maybe');
  assert.equal(editableHistory(restored, f.target).explanation, 'Retained edit.');
  const store = new QueueStore(f.file);
  store.update(f.job.id, '456', 'skipped', {});
  cancelBatch(f.file, [f.job.id], readApprovalBatch(f.file, [f.job.id]).fingerprint);
  store.close();
  const { checksum: _checksum, ...archive } = JSON.parse(await readFile(backup.file, 'utf8'));
  for (const table of Object.keys(archive.tables)) {
    archive.tables[table] =
      table === 'project_events'
        ? archive.tables[table].filter((event) => event.kind === 'history_studies_edited')
        : [];
  }
  const stale = path.join(f.folder, 'stale-edits.covipanel.json');
  await writeFile(stale, JSON.stringify({ ...archive, checksum: hash(archive) }));
  await assert.rejects(
    restoreProjectBackup(stale, { root, databaseFile: f.file }),
    /cancelled batch/,
  );
});
