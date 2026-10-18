import { setImmediate } from 'node:timers/promises';
import { readProjectHistory } from './project-history.js';
import { readCompletedBatch, reviewBatch } from './batch-review.js';
import { createTerminal } from './terminal-input.js';
import { editableHistory, saveHistoryEdit } from './history-editor.js';

export function editableRationale(
  file,
  target,
  history = readProjectHistory(file, target.reviewUrl),
) {
  const study = history.studies.find((s) => s.id === target.studyId);
  if (!target.runId || study?.recommendation?.record.runId !== target.runId)
    throw new Error('This batch response is not the source of the current spreadsheet row.');
  return editableHistory(file, target, history);
}

export async function saveRationale(file, target, wording, { folder, expectedText } = {}) {
  const current = editableRationale(file, target);
  if (expectedText !== undefined && current.text !== expectedText)
    throw new Error(
      'The rationale changed while you were editing. Reopen the editor and try again.',
    );
  return saveHistoryEdit(file, target, { wording }, { folder, expectedToken: current.token });
}

export async function reviewCompletedBatches(
  name,
  file,
  jobIds,
  {
    input = process.stdin,
    output = process.stdout,
    folder,
    lock = async () => async () => {},
  } = {},
) {
  let index = 0;
  while (true) {
    const entries = jobIds.flatMap((id) => readCompletedBatch(file, id, { details: true }));
    const histories = new Map();
    const studies = entries.map((entry) => {
      try {
        if (!histories.has(entry.reviewUrl))
          histories.set(entry.reviewUrl, readProjectHistory(file, entry.reviewUrl));
        const current = editableRationale(file, entry, histories.get(entry.reviewUrl));
        return [
          ...entry.lines.slice(0, 5),
          'Current spreadsheet rationale:',
          ...current.row[3].split(/\r?\n/),
        ];
      } catch {
        return entry.lines;
      }
    });
    const result = await reviewBatch(name, studies, {
      input,
      output,
      editable: true,
      startIndex: index,
    });
    if (!result || result === true) return result;
    index = result.editIndex;
    const terminal = createTerminal({ input, output });
    try {
      const target = entries[index];
      const current = editableRationale(file, target);
      output.write(
        `\r\nEdit rationale for study #${target.studyId}.\r\nType or paste the replacement explanation, then press Enter.\r\nLeave blank to cancel. Decision and other fields stay unchanged.\r\n`,
      );
      const wording = await terminal.question('New rationale: ');
      if (!wording.trim()) continue;
      output.write(`\r\nNew rationale:\r\n${wording.trim()}\r\n`);
      const answer = await terminal.question(
        `Save this rationale for study #${target.studyId}? [y/N]: `,
      );
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) continue;
      const release = await lock();
      try {
        await saveRationale(file, target, wording, { folder, expectedText: current.text });
      } finally {
        await release();
      }
      output.write('\r\nRationale saved. Decision History.xlsx updated.\r\n');
      await terminal.question('Press Enter to return to this study. ');
    } catch (error) {
      output.write(`\r\n${error.message}\r\n`);
      await terminal.question('Press Enter to return to this study. ');
    } finally {
      // Stop native reads before readline.close() restores Windows console mode.
      input.pause();
      await setImmediate();
      terminal.close();
    }
  }
}
