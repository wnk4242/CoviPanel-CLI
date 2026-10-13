import { inspectStudy, assertReview, searchStudy } from './covidence.js';
import { validateVoteConfig } from './decisions.js';
import { createAudit } from './audit.js';
import { studyHash } from './profiles.js';
import { readReviewer } from './reviewer.js';

const cardSelector = '[data-testclass="study"]:visible';
const normalize = (value) => value.replace(/\s+/g, ' ').trim();

export async function readCard(page, studyId, expectedTitle) {
  const card = page.locator(cardSelector);
  if ((await card.count()) !== 1) throw new Error('Expected exactly one visible study card.');
  const info = await card.evaluate((el) => ({
    testId: el.getAttribute('data-testid'),
    labels: [...el.querySelectorAll('p')]
      .filter((p) => p.checkVisibility())
      .map((p) => p.innerText.trim())
      .filter((t) => /^#\d+\b/.test(t)),
    titles: [...el.querySelectorAll('h3')]
      .filter((h) => h.checkVisibility())
      .map((h) => h.innerText.trim()),
  }));
  if (
    info.testId?.match(/^Study #(\d+)\b/)?.[1] !== studyId ||
    info.labels.length !== 1 ||
    info.labels[0].match(/^#(\d+)\b/)?.[1] !== studyId ||
    info.titles.length !== 1 ||
    (expectedTitle && normalize(info.titles[0]) !== normalize(expectedTitle))
  )
    throw new Error('Study card identity/title mismatch.');
  return card;
}

async function targetVote(page, config, study) {
  assertReview(page.url(), config.reviewUrl);
  const current = await page.evaluate(inspectStudy, config.selectors);
  if (
    !current.ready ||
    current.studyId !== config.studyId ||
    current.title !== study.title ||
    current.abstract !== study.abstract
  ) {
    throw new Error('The verified study content changed before voting.');
  }
  const card = await readCard(page, config.studyId, study.title);
  const locator = card
    .locator('button[data-pendo-key="vote-button"]')
    .and(card.getByRole('button', { name: config.expectedButton, exact: true }));
  if ((await locator.count()) !== 1 || !(await locator.isVisible()) || !(await locator.isEnabled()))
    throw new Error('Requested vote button is missing, ambiguous, or disabled.');
  const evidence = await locator.evaluate((el) => ({
    text: el.innerText.trim(),
    ariaLabel: el.getAttribute('aria-label'),
    value: el.getAttribute('value'),
  }));
  if (
    evidence.text !== config.expectedButton ||
    [evidence.ariaLabel, evidence.value].some((value) => value && value !== config.expectedButton)
  ) {
    throw new Error('Actual vote button label/value disagrees with the expected mapping.');
  }
  return { locator, evidence };
}

export async function readHistory(page, studyId, title, requireComplete = false) {
  const card = await readCard(page, studyId, title);
  await card.getByRole('button', { name: 'History', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'History', exact: true });
  await dialog.waitFor({ state: 'attached' });
  await dialog.getByRole('heading', { name: 'History', exact: true }).waitFor({ state: 'visible' });
  try {
    await dialog.locator('ol').waitFor({ state: 'attached' });
    await dialog.getByRole('img', { name: 'Loading', exact: true }).waitFor({ state: 'hidden' });
    if (normalize(await dialog.locator('h3').innerText()) !== normalize(title))
      throw new Error('History title does not match the verified study.');
    if (requireComplete) {
      const complete = await dialog.evaluate((el) => {
        const visible = (node) => node.checkVisibility();
        return (
          el.querySelectorAll('ol').length === 1 &&
          ![...el.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible) &&
          ![...el.querySelectorAll('button,a,[role="button"]')].some(
            (node) =>
              visible(node) &&
              !node.disabled &&
              node.getAttribute('aria-disabled') !== 'true' &&
              node.innerText.trim() !== 'Done',
          )
        );
      });
      if (!complete) throw new Error('History may be incomplete or paginated; records kept.');
    }
    return { rows: await dialog.locator('ol > li').allInnerTexts() };
  } finally {
    // Pendo walkthroughs can intercept pointer clicks on Done. Activate only
    // this dialog's close button by keyboard, then verify it actually closed.
    // Vote buttons still use the normal checked pointer-click path below.
    await dialog.getByRole('button', { name: 'Done', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'detached' });
  }
}

export function compareHistory(before, after, reviewerName = '') {
  reviewerName = normalize(reviewerName);
  const counts = new Map();
  for (const row of before) {
    const key = normalize(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const added = after.filter((row) => {
    const key = normalize(row);
    const count = counts.get(key) || 0;
    if (count) {
      counts.set(key, count - 1);
      return false;
    }
    return true;
  });
  const votes = added
    .map((row) => {
      const lines = row.split(/\r?\n/).map(normalize).filter(Boolean);
      // Observed Covidence History: "No vote" / "by Example Reviewer" / date.
      const event = lines[0]?.match(/^(Yes|No|Maybe) vote$/);
      if (event && (lines[1] === 'by You' || (reviewerName && lines[1] === `by ${reviewerName}`)))
        return event[1];
      const own =
        /^You\b/i.test(normalize(row)) ||
        (reviewerName && normalize(row).startsWith(`${reviewerName} `));
      return own ? normalize(row).match(/\bvoted\s+["“']?(Yes|No|Maybe)\b/i)?.[1] : null;
    })
    .filter(Boolean);
  if (votes.length !== 1) {
    return {
      recordedVote: null,
      addedRows: added,
      reason: 'No single new vote by the signed-in account was confirmed in Covidence History.',
    };
  }
  return {
    recordedVote: { yes: 'Yes', no: 'No', maybe: 'Maybe' }[votes[0].toLowerCase()],
    addedRows: added,
  };
}

export async function verificationLinks(page, reviewUrl) {
  const links = await page
    .getByRole('link')
    .evaluateAll((els) => els.map((el) => ({ text: el.innerText, href: el.href })));
  return [
    ...new Set([
      reviewUrl,
      ...links
        .filter((link) =>
          /^(?:Screen references|Resolve conflicts|Awaiting other reviewer|Irrelevant references)\b/.test(
            link.text,
          ),
        )
        .map((link) => link.href),
    ]),
  ].filter((url) => {
    try {
      assertReview(url, reviewUrl);
      return true;
    } catch {
      return false;
    }
  });
}

export async function verifyRecordedVote(page, config, study, beforeHistory, urls) {
  const observations = [];
  // A stored name typed in Project settings is never used. Prefer the account
  // observed at the actual click; older attempts can use the live session.
  const reviewerIdentity = study.reviewerIdentity || (await readReviewer(page));
  // Reload through observed navigation links: evidence must survive a server-backed page load.
  for (const url of urls) {
    try {
      assertReview(url, config.reviewUrl);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
      assertReview(page.url(), config.reviewUrl);
      const search = page.getByPlaceholder('Search studies', { exact: true });
      await search.fill(`#${config.studyId}`, { timeout: 5000 });
      await search.press('Enter');
      let card;
      const deadline = Date.now() + Math.min(config.timeoutMs, 6000);
      while (Date.now() < deadline) {
        try {
          card = await readCard(page, config.studyId, study.title);
          break;
        } catch {
          /* wait for search result */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!card) {
        observations.push({ url, reason: 'Requested card not found in this view.' });
        continue;
      }
      const history = await readHistory(page, config.studyId, study.title);
      const comparison = compareHistory(beforeHistory.rows, history.rows, reviewerIdentity?.name);
      observations.push({ url: page.url(), ...comparison });
      if (comparison.recordedVote)
        return { ...comparison, observations, reviewerIdentity, reason: null, error: null };
    } catch (error) {
      observations.push({ url, reason: error.message });
    }
  }
  const detail = (observations.find((entry) => entry.addedRows?.length) || observations[0])?.reason;
  return {
    recordedVote: null,
    observations,
    reviewerIdentity,
    reason: `Outcome uncertain. ${detail || 'No verifiable vote was found in Covidence History.'} No automatic retry.`,
  };
}

export async function runVote({
  page,
  config: input,
  databasePath,
  confirm,
  recommendation = null,
  onCheckpoint = async () => {},
}) {
  const config = validateVoteConfig(input);
  if (
    recommendation &&
    (recommendation.record.status !== 'recommended' ||
      recommendation.record.decision !== config.decision ||
      recommendation.record.dataset !== config.dataset ||
      recommendation.record.reviewUrl !== config.reviewUrl ||
      recommendation.record.studyId !== config.studyId ||
      recommendation.record.configHash !== config.configHash)
  )
    throw new Error('AI recommendation does not match this vote configuration.');
  const audit = await createAudit(
    databasePath,
    {
      dataset: config.dataset,
      reviewId: config.reviewId,
      reviewUrl: config.reviewUrl,
      studyId: config.studyId,
      decision: config.decision,
      expectedButton: config.expectedButton,
      decisionSource: recommendation?.humanReview
        ? 'human-batch-review'
        : recommendation
          ? 'openai-recommendation'
          : 'explicit-test-input',
      ...(recommendation?.humanReview ? { humanReview: recommendation.humanReview } : {}),
      recommendationRunId: recommendation?.record.runId ?? null,
      model: recommendation?.record.model ?? null,
      configHash: recommendation?.record.configHash ?? null,
      recommendationStudyHash: recommendation?.record.studyHash ?? null,
    },
    onCheckpoint,
  );
  let attempted = false;
  try {
    const study = await searchStudy(page, config);
    if (recommendation && studyHash(study) !== recommendation.record.studyHash)
      throw new Error(
        'Citation changed since the AI recommendation. Generate a new recommendation before voting.',
      );
    await audit.save({ title: study.title, author: study.author, year: study.year });
    const target = await targetVote(page, config, study);
    const reviewerIdentity = await readReviewer(page);
    await audit.save({ reviewerIdentity });
    const beforeHistory = await readHistory(page, config.studyId, study.title);
    if (
      beforeHistory.rows.some(
        (row) => compareHistory([], [row], reviewerIdentity?.name).recordedVote,
      )
    ) {
      await audit.save({ beforeHistory });
      throw new Error(
        'History already contains a vote by this reviewer. No replacement vote will be submitted.',
      );
    }
    const urls = await verificationLinks(page, config.reviewUrl);
    await audit.save({
      actualButton: target.evidence.text,
      mappingResult: 'match',
      targetEvidence: target.evidence,
      beforeHistory,
      verificationUrls: urls,
      status: 'awaiting_confirmation',
    });
    if (!(await confirm(audit.record))) {
      await audit.save({ status: 'cancelled' });
      await audit.releaseWithoutClick();
      return audit;
    }
    // The click-intent checkpoint is durable before any possible submission.
    await audit.save({
      status: 'click_intent',
      confirmedAt: new Date().toISOString(),
      reviewerIdentity: await readReviewer(page),
    });
    const finalTarget = await targetVote(page, config, study);
    // Retain this exact node. If React replaces it, fail instead of resolving a different button.
    const handle = await finalTarget.locator.elementHandle();
    if (!handle) throw new Error('Vote button detached before submission.');
    attempted = true;
    try {
      await handle.click({ timeout: 3000, noWaitAfter: true });
    } finally {
      await handle.dispose();
    }
    await audit.save({
      status: 'click_returned',
      clickedAt: new Date().toISOString(),
      targetEvidence: finalTarget.evidence,
    });
    // Give the normal UI a bounded chance to leave the pre-vote state before reloading.
    await page
      .locator(cardSelector)
      .getByRole('button', { name: config.expectedButton, exact: true })
      .waitFor({ state: 'hidden', timeout: config.timeoutMs })
      .catch(() => {});
    const result = await verifyRecordedVote(
      page,
      config,
      { ...study, reviewerIdentity: audit.record.reviewerIdentity },
      beforeHistory,
      urls,
    );
    const voteComparison = result.recordedVote
      ? result.recordedVote === config.expectedButton
        ? 'match'
        : 'mismatch'
      : 'unverifiable';
    await audit.save({
      ...result,
      voteComparison,
      status: result.recordedVote
        ? voteComparison === 'match'
          ? 'confirmed'
          : 'mismatch'
        : 'uncertain',
    });
  } catch (error) {
    await audit.save({
      status: attempted ? 'uncertain' : 'blocked_before_click',
      error: error.message,
    });
    if (!attempted) await audit.releaseWithoutClick();
  }
  return audit;
}
