import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { writeHistoryWorkbook } from '../Application/history-export.js';
import { spreadsheetLibrary } from '../Application/dependencies.js';

test('XLSX roundtrip preserves Unicode, line breaks and formula-like source strings as text', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'covipanel-xlsx-')), 'history.xlsx');
  const rows = [
    ['Study number', 'Title', 'Decision', 'Rationale', 'Reasons'],
    ['1', '=1+1', 'Maybe', '中文 rationale\nSecond line', '=1+1'],
    [
      '2',
      '+SUM(A1:A2)',
      'Exclude',
      '@source and -1 are text',
      '[Method]: ' + 'long evidence '.repeat(200),
    ],
  ];
  await writeHistoryWorkbook(file, rows, [rows[0], rows[1]]);
  const { Workbook } = await spreadsheetLibrary(),
    workbook = new Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('Decision history');
  assert.deepEqual(
    sheet.getRows(1, 3).map((row) => row.values.slice(1)),
    rows,
  );
  assert.equal(sheet.getCell('B2').formula, undefined);
  assert.equal(sheet.getCell('E2').formula, undefined);
  assert.equal(sheet.getColumn(5).width, 95);
  assert.ok(
    sheet.getRow(3).height > sheet.getRow(2).height,
    'Reasons contribute to wrapped row height',
  );
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.getColumn(4).width, 95);
  const saved = workbook.getWorksheet('Saved-only');
  assert.deepEqual(
    saved.getRows(1, 2).map((row) => row.values.slice(1)),
    [rows[0], rows[1]],
  );
  assert.equal(saved.getCell('B2').formula, undefined);
  assert.equal(saved.views[0].ySplit, 1);
  assert.equal(saved.getColumn(5).width, 95);
  assert.deepEqual(saved.getCell('A1').style, sheet.getCell('A1').style);
  await assert.rejects(
    writeHistoryWorkbook(file, [['1', 'title', 'Maybe', '', 'x'.repeat(32768)]]),
    /32,767/,
  );
  const defaultRows = rows.map((row) => row.slice(0, 4));
  await writeHistoryWorkbook(file, defaultRows);
  const ordinary = new Workbook();
  await ordinary.xlsx.readFile(file);
  assert.equal(ordinary.worksheets[0].columnCount, 4);
  assert.equal(ordinary.getWorksheet('Saved-only').rowCount, 1);
  assert.deepEqual(ordinary.getWorksheet('Saved-only').getRow(1).values.slice(1), defaultRows[0]);
  assert.deepEqual(
    ordinary.worksheets[0].getRows(1, 3).map((row) => row.values.slice(1)),
    defaultRows,
  );
  await assert.rejects(writeHistoryWorkbook(file, [defaultRows[0], rows[1]]), /History cells/);
});
