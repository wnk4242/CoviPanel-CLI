import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { loadProfile } from './fixtures.js';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { readProjectHistory } from '../Application/project-history.js';
import { exportProjectHistory } from '../Application/history-export.js';
import {
  editableRationale,
  saveRationale,
  reviewCompletedBatches,
} from '../Application/rationale-editor.js';
import { spreadsheetLibrary } from '../Application/dependencies.js';

const original =
  'Decision: Include\nPopulation: children\nIntervention: symptoms\nCondition: treatment\nStudyDesign: experiment\nRationale: Original explanation.';
async function fixture(custom = false, rationale = original) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-rationale-'));
  const file = path.join(folder, 'screening.sqlite');
  const config = await loadProfile('demo', '1');
  if (custom) config.reviewUrl = 'https://app.covidence.org/reviews/900001';
  const store = new QueueStore(file);
  const job = store.create(config, ['1', '2'], 'recommend-only');
  const record = {
    runId: 'first',
    dataset: config.dataset,
    reviewUrl: config.reviewUrl,
    studyId: '1',
    configHash: config.configHash,
    status: 'recommended',
    title: 'Fixture study',
    decision: 'Include',
    rationale,
    createdAt: new Date().toISOString(),
  };
  withRecords(file, (records) =>
    records.saveRecommendation({
      record,
      parsed: { Decision: 'Include', ResponseText: rationale },
    }),
  );
  store.update(job.id, '1', 'recommended', { recommendationRef: 'recommendation:first' });
  store.update(job.id, '2', 'skipped', {});
  store.close();
  return {
    folder,
    file,
    job,
    record,
    target: { reviewUrl: config.reviewUrl, studyId: '1', runId: 'first' },
  };
}

test('editing overwrites the XLSX row, preserves other fields and original attempts, and survives export', async () => {
  for (const custom of [false, true]) {
    const f = await fixture(custom);
    const before = await exportProjectHistory(f.file, f.target.reviewUrl, { folder: f.folder });
    const current = editableRationale(f.file, f.target);
    await saveRationale(f.file, f.target, 'The study examines treatment outcomes.', {
      folder: f.folder,
      expectedText: current.text,
    });
    const history = readProjectHistory(f.file, f.target.reviewUrl);
    const expected = original.replace(
      'Original explanation.',
      'The study examines treatment outcomes.',
    );
    assert.equal(history.rows[1][3], expected);
    assert.deepEqual(history.rows[1].slice(0, 3), before.history.rows[1].slice(0, 3));
    assert.equal(history.rows[1][4], before.history.rows[1][4]);
    assert.deepEqual(history.rows[2], before.history.rows[2]);
    assert.equal(history.rows.length, before.history.rows.length);
    assert.match(history.log, /Original explanation/);
    assert.deepEqual(
      withRecords(f.file, (s) => s.recommendation('first').record),
      f.record,
    );
    const { Workbook } = await spreadsheetLibrary();
    const workbook = new Workbook();
    await workbook.xlsx.readFile(before.output);
    assert.equal(workbook.worksheets[0].getCell('D2').value, expected);
    assert.equal(
      (await exportProjectHistory(f.file, f.target.reviewUrl, { folder: f.folder })).changed,
      false,
    );
    await saveRationale(f.file, f.target, 'Second edit.', { folder: f.folder });
    assert.equal(editableRationale(f.file, f.target).explanation, 'Second edit.');
    await assert.rejects(
      saveRationale(f.file, f.target, 'Stale edit.', {
        folder: f.folder,
        expectedText: current.text,
      }),
      /changed while/,
    );
    await assert.rejects(saveRationale(f.file, f.target, '  ', { folder: f.folder }), /blank/);
    await assert.rejects(
      saveRationale(f.file, f.target, 'x'.repeat(32768), { folder: f.folder }),
      /too long/,
    );
    await assert.rejects(
      saveRationale(f.file, { ...f.target, runId: 'different' }, 'Wrong run', { folder: f.folder }),
      /not the source/,
    );
    await assert.rejects(
      saveRationale(
        f.file,
        { ...f.target, reviewUrl: 'https://app.covidence.org/reviews/999' },
        'Wrong review',
        { folder: f.folder },
      ),
      /not the source/,
    );
  }
});

test('plain responses stay plain and fields after a labeled rationale are retained', async () => {
  for (const rationale of [
    'Original explanation.',
    'Rationale: Original explanation.\nEvidence: Original quotation',
  ]) {
    const f = await fixture(false, rationale);
    await saveRationale(f.file, f.target, '=New explanation.', { folder: f.folder });
    assert.equal(
      readProjectHistory(f.file, f.target.reviewUrl).rows[1][3],
      rationale.replace('Original explanation.', '=New explanation.'),
    );
  }
});

test('failed Excel replacement retains the edit for a later export', async () => {
  const f = await fixture();
  const output = path.join(f.folder, 'Decision History.xlsx');
  await mkdir(output);
  await assert.rejects(
    saveRationale(f.file, f.target, 'Saved despite export failure.', { folder: f.folder }),
    /saved locally, but Excel has not been updated/,
  );
  assert.equal(editableRationale(f.file, f.target).explanation, 'Saved despite export failure.');
  await rmdir(output);
  await exportProjectHistory(f.file, f.target.reviewUrl, { folder: f.folder });
});

test('viewer edits the selected study, cancels blank input and returns with clean keyboard listeners', async () => {
  const f = await fixture();
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  output.columns = 100;
  output.rows = 30;
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  const waitFor = async (value) => {
    const deadline = Date.now() + 5000;
    while (!text.includes(value) && Date.now() < deadline) await setTimeout(5);
    assert.ok(text.includes(value), value);
    text = '';
  };
  const review = reviewCompletedBatches('Fixture', f.file, [f.job.id], {
    input,
    output,
    folder: f.folder,
  });
  assert.match(text, /Current spreadsheet rationale:/);
  assert.doesNotMatch(text, /Original saved response:/);
  await waitFor('E: edit rationale');
  input.write('e');
  await waitFor('New rationale:');
  input.write('\r');
  await waitFor('E: edit rationale');
  assert.equal(editableRationale(f.file, f.target).text, original);
  input.write('e');
  await waitFor('New rationale:');
  input.write('Edited in CMD.\r');
  await waitFor('Save this rationale for study #1? [y/N]: ');
  assert.equal(editableRationale(f.file, f.target).text, original);
  input.write('n\r');
  await waitFor('E: edit rationale');
  assert.equal(editableRationale(f.file, f.target).text, original);
  input.write('e');
  await waitFor('New rationale:');
  input.write('Edited in CMD.\r');
  await waitFor('Save this rationale for study #1? [y/N]: ');
  input.write('y\r');
  await waitFor('Decision History.xlsx updated.');
  input.write('\r');
  await waitFor('E: edit rationale');
  assert.equal(editableRationale(f.file, f.target).explanation, 'Edited in CMD.');
  input.write('\x1b[C');
  await waitFor('Study 2/2');
  input.write('e');
  await waitFor('not the source');
  input.write('\r');
  await waitFor('Study 2/2');
  input.write('\x1b');
  assert.equal(await review, true);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('keypress'), 0);
});
