// @ts-check

/** @typedef {'pending'|'processing'|'recommended'|'saved'|'completed'|'needs_review'|'error'|'skipped'} QueueState */

/** @type {Readonly<Record<QueueState, readonly QueueState[]>>} */
const transitions = Object.freeze({
  pending: [
    'pending',
    'processing',
    'recommended',
    'completed',
    'needs_review',
    'error',
    'skipped',
  ],
  processing: [
    'processing',
    'pending',
    'recommended',
    'completed',
    'needs_review',
    'error',
    'skipped',
  ],
  recommended: [
    'recommended',
    'saved',
    'processing',
    'completed',
    'needs_review',
    'error',
    'skipped',
  ],
  saved: ['saved'],
  needs_review: ['needs_review', 'pending', 'recommended', 'completed', 'error', 'skipped'],
  error: ['error', 'pending', 'recommended', 'completed', 'needs_review', 'skipped'],
  completed: ['completed', 'needs_review'],
  skipped: ['skipped', 'completed', 'needs_review'],
});

/** @param {string} from @param {string} to */
export function assertQueueTransition(from, to) {
  if (
    !Object.hasOwn(transitions, from) ||
    !transitions[/** @type {QueueState} */ (from)].includes(/** @type {QueueState} */ (to))
  ) {
    throw new Error(`Unsupported queue transition: ${from} -> ${to}.`);
  }
}

/** @param {{status?:string, clickedAt?:string, recordedVote?:string|null}} record */
export function isKnownBeforeClick(record) {
  return (
    !record.clickedAt &&
    !record.recordedVote &&
    ['prepared', 'awaiting_confirmation', 'cancelled', 'blocked_before_click'].includes(
      record.status || '',
    )
  );
}

/** @param {{state:string}} item @param {string} mode */
export function finishedItem(item, mode) {
  return (
    ['completed', 'skipped', 'saved'].includes(item.state) ||
    (mode === 'recommend-only' && item.state === 'recommended')
  );
}

/** @param {string|undefined} state */
export function requiresReview(state) {
  return state === 'error' || state === 'needs_review';
}
