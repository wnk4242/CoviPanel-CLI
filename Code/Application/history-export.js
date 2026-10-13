import path from 'node:path';
import { access, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spreadsheetLibrary } from './dependencies.js';
import { reviewFolder } from './config.js';
import { hash } from './profiles.js';
import { withRecords } from './records.js';
import { readProjectHistory, writeProjectLog } from './project-history.js';

export async function exportProjectHistory(databasePath, reviewUrl, { folder } = {}) {
  withRecords(databasePath, () => {});
  let history = readProjectHistory(databasePath, reviewUrl);
  folder ||= reviewFolder(reviewUrl);
  const output = path.join(folder, 'Decision History.xlsx'),
    text = path.join(folder, 'Screening Log.txt');
  const fingerprint = hash({
    formatVersion: 6,
    rows: history.rows,
    savedOnlyRows: history.savedOnlyRows,
    log: history.log,
  });
  const previous = withRecords(databasePath, (store) =>
    store.db
      .prepare('SELECT snapshot_hash FROM project_exports WHERE review_url=?')
      .get(history.key),
  );
  if (previous?.snapshot_hash === fingerprint) {
    try {
      await access(output);
      if ((await readFile(text, 'utf8')) === history.log)
        return { output, text, history, changed: false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeProjectLog(history, folder);
  const temp = path.join(folder, `.Decision History.${randomUUID()}.xlsx`);
  try {
    await writeHistoryWorkbook(temp, history.rows, history.savedOnlyRows);
    await rename(temp, output);
    withRecords(databasePath, (store) =>
      store.db
        .prepare(
          'INSERT INTO project_exports VALUES (?,?) ON CONFLICT(review_url) DO UPDATE SET snapshot_hash=excluded.snapshot_hash',
        )
        .run(history.key, fingerprint),
    );
    return { output, text, history, changed: true };
  } catch (error) {
    const message = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
      ? 'Could not update Decision History.xlsx. Close it in Excel and choose Export project history. Saved decisions do not need another AI request.'
      : `History export failed: ${error.message}`;
    withRecords(databasePath, (store) =>
      store.projectEvent(randomUUID(), history.key, 'export_error', { error: message }),
    );
    history = readProjectHistory(databasePath, reviewUrl);
    await writeProjectLog(history, folder);
    throw new Error(message, { cause: error });
  } finally {
    await rm(temp, { force: true });
  }
}

export async function writeHistoryWorkbook(file, rows, savedOnlyRows = [rows[0]]) {
  const { Workbook } = await spreadsheetLibrary();
  const workbook = new Workbook();
  workbook.creator = 'CoviPanel';
  addHistorySheet(workbook, 'Decision history', rows);
  addHistorySheet(workbook, 'Saved-only', savedOnlyRows);
  await workbook.xlsx.writeFile(file);
}

function addHistorySheet(workbook, name, rows) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  const columnCount = rows[0]?.length;
  if (![4, 5].includes(columnCount))
    throw new Error('History must have four default columns or five custom columns.');
  sheet.columns = [{ width: 17 }, { width: 58 }, { width: 15 }, { width: 95 }, { width: 95 }].slice(
    0,
    columnCount,
  );
  const wrappedLines = (value, width) =>
    value
      .split(/\r?\n/)
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
  rows.forEach((values, index) => {
    if (
      values.length !== columnCount ||
      values.some((value) => typeof value !== 'string' || value.length > 32767)
    )
      throw new Error(
        'History cells must be text within the Excel limit of 32,767 characters. Full records remain in SQLite and the text log.',
      );
    // Assign strings, never {formula: ...}, even when source text starts with =.
    const row = sheet.addRow(values);
    row.height =
      index === 0
        ? 30
        : Math.min(
            409,
            Math.max(
              48,
              Math.max(
                wrappedLines(values[1], 53),
                wrappedLines(values[3], 88),
                wrappedLines(values[4] || '', 88),
              ) *
                16 +
                18,
            ),
          );
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = {
        name: 'Arial',
        size: 11,
        color: { argb: index === 0 ? 'FFFFFFFF' : 'FF202B38' },
        bold: index === 0,
      };
      cell.alignment = {
        vertical: index === 0 ? 'middle' : 'top',
        horizontal: index === 0 ? 'center' : 'left',
        wrapText: true,
      };
      if (index === 0 || index % 2 === 1)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: index === 0 ? 'FF263E56' : 'FFF0F4F8' },
        };
    });
  });
}
