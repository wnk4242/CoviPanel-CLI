import { runQueue } from './queue-runner.js';
import { recoverBeforeClick } from './recovery.js';
import { isKnownBeforeClick, requiresReview, finishedItem } from './states.js';
import { preparedItem } from './review-decisions.js';

export function browserDisconnected(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (
      /Target (?:page, context or browser|page|context|browser) has been closed|Page crashed|Browser (?:closed|disconnected)|browser has disconnected/i.test(
        String(current.message || current),
      )
    )
      return true;
  }
  return false;
}

export function resumeBrowserInterruption(store, job, config, item) {
  if (
    !item ||
    !requiresReview(item.state) ||
    !browserDisconnected(item.data.error) ||
    !['extracting', 'voting'].includes(item.data.stage) ||
    (item.data.voteRecord && !isKnownBeforeClick(item.data.voteRecord))
  )
    return false;
  // Rechecks the canonical vote/claim inside a transaction. The cached queue
  // record alone cannot authorize resetting an attempt that may have clicked.
  recoverBeforeClick(
    store,
    job,
    config,
    item.study_id,
    'Browser disconnected before submission. Resume using any validated saved GPT answer.',
  );
  return true;
}

// A fresh browser gets fresh locators. Retry only a disconnected browser, once
// per run, and only while the database proves no vote needs verification.
// API failures and potentially submitted votes never enter this restart path.
export async function runBrowserQueue({
  store,
  job,
  config,
  openBrowser,
  operationsForPage,
  shouldStop = () => false,
  log = console.log,
}) {
  store.recover(job.id);
  const next = () =>
    store
      .items(job.id)
      .find(
        (item) =>
          !(job.mode === 'review-all'
            ? preparedItem(item, job.mode)
            : finishedItem(item, job.mode)),
      );
  let restarts = 0;
  while (!shouldStop()) {
    const item = next();
    if (!item) break;
    if (requiresReview(item.state) && !resumeBrowserInterruption(store, job, config, item)) {
      log(
        `Study #${item.study_id} is paused: ${item.data.error || 'An earlier request or vote has an unresolved outcome.'}`,
      );
      break;
    }
    let session;
    try {
      session = await openBrowser();
      await runQueue({
        store,
        job,
        config,
        operations: operationsForPage(session.page),
        shouldStop,
        log,
      });
    } catch (error) {
      // Opening a review has not requested a decision or clicked a vote.
      if (session || !browserDisconnected(error) || shouldStop() || restarts >= 1) throw error;
      restarts++;
      log('The browser disconnected while opening the review. Reopening it once.');
      continue;
    } finally {
      if (session) await session.close();
    }
    const stopped = next();
    if (
      shouldStop() ||
      restarts >= 1 ||
      !stopped ||
      !requiresReview(stopped.state) ||
      !browserDisconnected(stopped.data.error)
    )
      break;
    if (!resumeBrowserInterruption(store, job, config, stopped)) break;
    restarts++;
    log(
      `Browser disconnected before submitting study #${stopped.study_id}. Reopening once; saved GPT answers will be reused.`,
    );
  }
  return store.items(job.id);
}
