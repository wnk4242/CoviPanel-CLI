import { decisionMap } from './decisions.js';
import { hash } from './profiles.js';

// Human edits are separate from the immutable, reusable AI response.
export function recommendationText(recommendation) {
  const { record, parsed = {} } = recommendation;
  return parsed.ResponseText || parsed.Rationale || record.rationale || '';
}

export function rationaleParts(text) {
  const match = /(?:^|\n)Rationale:[ \t]*/.exec(text);
  if (!match) return { prefix: '', explanation: text, suffix: '' };
  const end = match.index + match[0].length;
  const next = /\r?\n[A-Za-z][A-Za-z /]*:[ \t]*/.exec(text.slice(end));
  const stop = next ? end + next.index : text.length;
  return {
    prefix: text.slice(0, end),
    explanation: text.slice(end, stop),
    suffix: text.slice(stop),
  };
}

export function reviewDecision(recommendation, draft) {
  const r = recommendation.record;
  if (draft && (draft.runId !== r.runId || draft.studyHash !== r.studyHash))
    throw new Error('The saved review belongs to a different AI response or citation.');
  const result = draft || {
    runId: r.runId,
    studyHash: r.studyHash,
    decision: r.decision,
    rationale: recommendationText(recommendation),
  };
  if (!Object.hasOwn(decisionMap, result.decision) || typeof result.rationale !== 'string')
    throw new Error('Invalid reviewed decision or rationale.');
  return result;
}

export function reviewedRecommendation(recommendation, data, job) {
  const draft = reviewDecision(recommendation, data.batchReview);
  const approval = data.batchApproval;
  if (!approval?.id || !approval.confirmedAt || approval.reviewHash !== hash(draft))
    throw new Error('This decision has not been confirmed with the batch. Return to batch review.');
  const humanReview = {
    ...draft,
    jobId: job.id,
    reviewUrl: job.review_url,
    configHash: job.config_hash,
    confirmationId: approval.id,
    confirmedAt: approval.confirmedAt,
    originalDecision: recommendation.record.decision,
  };
  return {
    ...recommendation,
    humanReview,
    record: {
      ...recommendation.record,
      decision: draft.decision,
      expectedButton: decisionMap[draft.decision],
      rationale: draft.rationale,
    },
  };
}

export function reviewedResponse(text, originalDecision, decision) {
  // Only an explicit decision edit updates the decision label in the final copy.
  return decision === originalDecision
    ? text
    : text.replace(
        /^Decision:[ \t]*(?:Include|Exclude|Maybe|Yes|No)[ \t]*$/m,
        `Decision: ${decision}`,
      );
}

export function awaitingBatchConfirmation(items, mode) {
  return (
    mode === 'review-all' &&
    items.length > 0 &&
    items.every((item) => ['recommended', 'completed', 'skipped', 'saved'].includes(item.state)) &&
    items.some((item) => item.state === 'recommended' && !item.data.batchApproval)
  );
}

export function preparedItem(item, mode) {
  return (
    ['completed', 'skipped', 'saved'].includes(item.state) ||
    (item.state === 'recommended' &&
      (mode === 'recommend-only' || (mode === 'review-all' && !item.data.batchApproval)))
  );
}
