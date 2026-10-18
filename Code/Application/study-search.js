import { existsSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { readProjectHistory } from './project-history.js';
import { editableHistory, saveHistoryEdit } from './history-editor.js';
import { reviewBatch } from './batch-review.js';
import { createTerminal } from './terminal-input.js';
import { showScreen } from './terminal-screen.js';
import { decisionMap } from './decisions.js';
import { recommendationText } from './review-decisions.js';

export function parseStudyNumber(value) {
  const match = /^#?([1-9]\d*)$/.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Enter one Covidence study number, such as #123 or 123.');
  return match[1];
}

export function studyHistoryLines(history, studyId) {
  const study = history.studies.find((s) => s.id === studyId);
  if (!study) return null;
  const row = history.rows.find((r) => r[0] === studyId);
  const citation =
    study.recommendation?.study || [...study.items].reverse().find((i) => i.data.study)?.data.study;
  const vote = study.vote;
  return [
    `Study #${study.id}: ${study.title || 'Title not saved'}`,
    `Local decision: ${decisionMap[row[2]] || row[2] || 'Not decided'}`,
    `Status: ${study.status}`,
    ...(study.items.some((i) => i.data.savedWithoutSubmission?.id) ? ['Saved with S: yes'] : []),
    `Recorded Covidence vote: ${vote?.recordedVote || study.manualVote?.recordedVote || 'Not verified locally'}`,
    'Edits update local history only; online votes and pending batches are unchanged.',
    '',
    'Current rationale:',
    ...row[3].split(/\r?\n/),
    ...(citation?.abstract ? ['', 'Saved abstract:', citation.abstract] : []),
    ...(study.recommendation
      ? ['', 'Original AI response:', recommendationText(study.recommendation)]
      : []),
  ];
}

export async function searchProjectHistory(
  project,
  file,
  {
    input = process.stdin,
    output = process.stdout,
    show = showScreen,
    lock = async () => async () => {},
  } = {},
) {
  // Each line prompt releases native input before handing over to the raw-key viewer.
  const question = async (prompt) => {
    const terminal = createTerminal({ input, output });
    try {
      return await terminal.question(prompt);
    } finally {
      input.pause();
      await setImmediate();
      terminal.close();
    }
  };
  const message = async (text) => {
    output.write(`\r\n${text}\r\n`);
    await question('Press Enter to continue. ');
  };
  while (true) {
    show(
      `CoviPanel | ${project.name} | Search study history`,
      [
        'Enter a Covidence study number, such as #123 or 123.',
        'Enter without a number returns to this project.',
      ],
      '',
    );
    const answer = await question('Covidence study number: ');
    if (!answer.trim()) return;
    let studyId;
    try {
      studyId = parseStudyNumber(answer);
    } catch (error) {
      await message(error.message);
      continue;
    }
    const target = { reviewUrl: project.reviewUrl, studyId };
    while (true) {
      const history = existsSync(file) ? readProjectHistory(file, project.reviewUrl) : null;
      const lines = history && studyHistoryLines(history, studyId);
      if (!lines) {
        await message(`Study #${studyId} was not found in this project's history.`);
        break;
      }
      const study = history.studies.find((s) => s.id === studyId);
      const editable = Object.hasOwn(decisionMap, study.exportDecision);
      const current = editable ? editableHistory(file, target, history) : null;
      const result = await reviewBatch(project.name, [lines], {
        input,
        output,
        statusLabel: 'Study history',
        editable,
        decisionEditable: editable,
      });
      if (!result || result === true) break;
      try {
        let changes;
        if (result.decision) {
          if (result.decision === current.decision) continue;
          output.write(
            `\r\nLocal decision: ${decisionMap[current.decision]} -> ${decisionMap[result.decision]}\r\n`,
          );
          changes = { decision: result.decision };
        } else {
          output.write(`\r\nCurrent explanation:\r\n${current.explanation}\r\n`);
          const wording = await question('New rationale (Enter cancels): ');
          if (!wording.trim()) continue;
          output.write(`\r\nNew rationale:\r\n${wording.trim()}\r\n`);
          changes = { wording };
        }
        const confirmed = await question(
          `Save this ${result.decision ? 'decision' : 'rationale'} for study #${studyId}? [y/N]: `,
        );
        if (!['y', 'yes'].includes(confirmed.trim().toLowerCase())) continue;
        const release = await lock();
        try {
          await saveHistoryEdit(file, target, changes, {
            folder: project.folder,
            expectedToken: current.token,
          });
        } finally {
          await release();
        }
        // Return directly to the refreshed study. Export failures remain visible below.
      } catch (error) {
        await message(error.message);
      }
    }
  }
}
