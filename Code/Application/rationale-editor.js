import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { hash } from './profiles.js';
import { withRecords } from './records.js';
import { readProjectHistory } from './project-history.js';
import { exportProjectHistory } from './history-export.js';
import { readCompletedBatch, reviewBatch } from './batch-review.js';
import { createTerminal } from './terminal-input.js';
import { rationaleParts } from './review-decisions.js';

export function editableRationale(
  file,
  target,
  history = readProjectHistory(file, target.reviewUrl),
) {
  const study = history.studies.find((s) => s.id === target.studyId);
  if (!target.runId || study?.recommendation?.record.runId !== target.runId)
    throw new Error('This batch response is not the source of the current spreadsheet row.');
  const text = study.exportRationale;
  return {
    key: history.key,
    study,
    text,
    row: history.rows.find((row) => row[0] === target.studyId),
    ...rationaleParts(text),
    sourceHash: hash({ title: study.title, rationale: study.rationale }),
  };
}

export async function saveRationale(file, target, wording, { folder, expectedText } = {}) {
  const explanation = wording.trim();
  if (!explanation) throw new Error('The rationale cannot be blank.');
  // Persist an editorial event, never mutate a reusable AI response or vote record.
  withRecords(file, (store) =>
    store.transaction(() => {
      const current = editableRationale(file, target);
      if (expectedText !== undefined && current.text !== expectedText)
        throw new Error(
          'The rationale changed while you were editing. Reopen the editor and try again.',
        );
      const rationale = current.prefix + explanation + current.suffix;
      if (rationale.length > 32760)
        throw new Error('The rationale is too long for Excel (32,767 characters per cell).');
      if (rationale === current.text) return;
      // A strictly newer timestamp also orders rapid successive edits deterministically.
      const latest = store.db
        .prepare('SELECT MAX(created_at) AS time FROM project_events WHERE review_url=?')
        .get(current.key)?.time;
      const createdAt = new Date(Math.max(Date.now(), (Date.parse(latest) || 0) + 1)).toISOString();
      store.projectEvent(
        randomUUID(),
        current.key,
        'history_rationales_edited',
        {
          message: `Rationale edited in the completed-study viewer for study #${target.studyId}.`,
          edits: [
            {
              runId: target.runId,
              studyId: target.studyId,
              decision: current.study.decision,
              sourceHash: current.sourceHash,
              previousRationale: current.text,
              rationale,
            },
          ],
        },
        createdAt,
      );
    }),
  );
  try {
    return await exportProjectHistory(file, target.reviewUrl, { folder });
  } catch (error) {
    throw new Error(
      `Your rationale is saved locally, but Excel has not been updated. ${error.message}`,
      { cause: error },
    );
  }
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
          ...(current.row[4] ? ['', `Reasons: ${current.row[4]}`] : []),
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
