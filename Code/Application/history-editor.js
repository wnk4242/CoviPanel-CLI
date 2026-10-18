import { randomUUID } from 'node:crypto';
import { hash } from './profiles.js';
import { withRecords } from './records.js';
import { historySourceHash, readProjectHistory } from './project-history.js';
import { exportProjectHistory } from './history-export.js';
import { rationaleParts, reviewedResponse } from './review-decisions.js';
import { decisionMap } from './decisions.js';

export function editableHistory(
  file,
  target,
  history = readProjectHistory(file, target.reviewUrl),
) {
  const study = history.studies.find((s) => s.id === target.studyId);
  if (!study) throw new Error(`Study #${target.studyId} was not found in this project's history.`);
  if (!Object.hasOwn(decisionMap, study.exportDecision))
    throw new Error('This study has no saved decision to edit.');
  const row = history.rows.find((r) => r[0] === study.id);
  const sourceHash = historySourceHash(study);
  return {
    key: history.key,
    study,
    row,
    sourceHash,
    text: study.exportRationale,
    decision: study.exportDecision,
    token: hash({ sourceHash, row }),
    ...rationaleParts(study.exportRationale),
  };
}

export async function saveHistoryEdit(file, target, changes, { folder, expectedToken } = {}) {
  withRecords(file, (store) =>
    store.transaction(() => {
      const current = editableHistory(file, target);
      if (expectedToken !== undefined && expectedToken !== current.token)
        throw new Error(
          'The study changed while you were editing. Reopen the editor and try again.',
        );
      const decision = changes.decision ?? current.decision;
      if (!Object.hasOwn(decisionMap, decision)) throw new Error('Invalid decision.');
      let rationale = current.text;
      if (changes.wording !== undefined) {
        const explanation = changes.wording.trim();
        if (!explanation) throw new Error('The rationale cannot be blank.');
        rationale = current.prefix + explanation + current.suffix;
      }
      rationale = reviewedResponse(rationale, current.decision, decision);
      if (rationale.length > 32760)
        throw new Error('The rationale is too long for Excel (32,767 characters per cell).');
      if (rationale === current.text && decision === current.decision) return;
      const latest = store.db
        .prepare('SELECT MAX(created_at) AS time FROM project_events WHERE review_url=?')
        .get(current.key)?.time;
      const createdAt = new Date(Math.max(Date.now(), (Date.parse(latest) || 0) + 1)).toISOString();
      store.projectEvent(
        randomUUID(),
        current.key,
        'history_studies_edited',
        {
          edits: [
            {
              studyId: target.studyId,
              runId: current.study.recommendation?.record.runId || null,
              sourceHash: current.sourceHash,
              previousDecision: current.decision,
              previousRationale: current.text,
              decision,
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
      `Your edit is saved locally, but Excel has not been updated. ${error.message}`,
      { cause: error },
    );
  }
}
