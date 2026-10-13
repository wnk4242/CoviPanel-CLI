import { assertReview } from './covidence.js';

// Read only: IDs come from citation cards in the observed awaiting-vote view.
function inspectUnscreened() {
  const visible = (e) => e.checkVisibility() && !e.closest('[hidden],[aria-hidden="true"]');
  const links = [...document.querySelectorAll('a')].filter(
    (e) => visible(e) && /^Screen references\b/.test(e.innerText),
  );
  const count =
    links.length === 1
      ? links[0].innerText.trim().match(/^Screen references\s+([\d,]+)$/)?.[1]
      : null;
  const cards = [...document.querySelectorAll('[data-testclass="study"]')]
    .filter(visible)
    .map((e) => {
      const id = e.getAttribute('data-testid')?.match(/^Study #([1-9]\d*)\b/)?.[1];
      const labels = [...e.querySelectorAll('p')]
        .filter(visible)
        .map((p) => p.innerText.trim())
        .filter((t) => /^#\d+\b/.test(t));
      const titles = [...e.querySelectorAll('h3')].filter(visible).map((h) => h.innerText.trim());
      const buttons = [...e.querySelectorAll('button[data-pendo-key="vote-button"]')].filter(
        visible,
      );
      const valid =
        id &&
        labels.length === 1 &&
        labels[0].match(/^#(\d+)/)?.[1] === id &&
        titles.length === 1 &&
        titles[0] &&
        buttons.length === 3 &&
        ['Yes', 'No', 'Maybe'].every(
          (value) =>
            buttons.filter(
              (b) =>
                b.innerText.trim() === value &&
                !b.disabled &&
                b.getAttribute('aria-disabled') !== 'true',
            ).length === 1,
        ) &&
        !/Final decision|What was the agreed final decision\?/i.test(e.innerText);
      return { studyId: id, title: titles[0], valid: Boolean(valid) };
    });
  const more = [...document.querySelectorAll('button')].filter(
    (e) => visible(e) && e.innerText.trim() === 'Load more',
  );
  return {
    count: count === null || count === undefined ? null : Number(count.replaceAll(',', '')),
    cards,
    search: document.querySelector('input[placeholder="Search studies"]')?.value ?? '',
    busy: [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible),
    more: more.length,
    moreEnabled: more.length === 1 && !more[0].disabled,
  };
}

export function assertUnscreenedUrl(url, reviewUrl) {
  assertReview(url, reviewUrl);
  const u = new URL(url);
  if (
    !/^\/reviews\/\d+\/(?:review_studies\/)?screen\/?$/.test(u.pathname) ||
    u.searchParams.get('filter') !== 'vote_required_from' ||
    u.searchParams.getAll('filter').length !== 1 ||
    [...u.searchParams.keys()].some((k) => k !== 'filter')
  ) {
    throw new Error(
      'Use the Screen references address ending in /screen?filter=vote_required_from or /review_studies/screen?filter=vote_required_from, with no study search or other filters.',
    );
  }
}

export async function discoverUnscreened(
  page,
  config,
  {
    existingVote = async () => null,
    savedDecision = () => false,
    log = () => {},
    shouldStop = () => false,
    chooseCount,
  } = {},
) {
  assertReview(page.url(), config.reviewUrl);
  const links = page.getByRole('link', { name: /^Screen references\b/ });
  await links.first().waitFor({ state: 'visible', timeout: config.timeoutMs });
  if ((await links.count()) !== 1)
    throw new Error('Cannot identify a unique Screen references link.');
  const href = await links.getAttribute('href');
  const target = new URL(href, page.url()).href;
  assertUnscreenedUrl(target, config.reviewUrl);
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  let lastCount = -1,
    total = null,
    previous = '',
    stable = 0,
    snapshot,
    requested;
  const studies = [],
    blocked = [],
    examined = new Map();
  const result = (cancelled) => ({
    reviewUrl: config.reviewUrl,
    screenUrl: target,
    configHash: config.configHash,
    discoveredAt: new Date().toISOString(),
    total,
    requested,
    scanned: examined.size,
    fullyScanned: examined.size >= total && snapshot?.more === 0,
    cancelled,
    studies,
    blocked,
  });
  let deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error('Discovery cancelled. No screening job was started.');
    assertUnscreenedUrl(page.url(), config.reviewUrl);
    snapshot = await page.evaluate(inspectUnscreened);
    const key = JSON.stringify({ ...snapshot, count: undefined });
    if (key !== previous) {
      previous = key;
      stable = Date.now();
    }
    const hasCount = Number.isSafeInteger(snapshot.count) && snapshot.count >= 0;
    if (snapshot.busy || (!hasCount && !snapshot.cards.length) || Date.now() - stable < 750) {
      await page.waitForTimeout(150);
      continue;
    }
    if (snapshot.search) throw new Error('Clear the study search before discovery.');
    // The counter can lag or change when another reviewer works. Actual study
    // cards and pagination determine what can be collected, not count equality.
    total = Math.max(hasCount ? snapshot.count : 0, snapshot.cards.length);
    if (requested === undefined) {
      requested = total === 0 ? 0 : chooseCount ? await chooseCount(total) : total;
      if (requested === null || requested === 0) {
        requested = 0;
        return result(total > 0);
      }
      if (!Number.isInteger(requested) || requested < 1 || requested > Math.min(total, 10000))
        throw new Error('Choose up to 10,000 studies per batch.');
      // Recheck the page after the user answers; it may have changed while waiting.
      previous = '';
      deadline = Date.now() + config.timeoutMs;
      continue;
    }
    if (
      snapshot.cards.some((c) => !c.valid) ||
      new Set(snapshot.cards.map((c) => c.studyId)).size !== snapshot.cards.length
    )
      throw new Error(
        'Ambiguous study identity, duplicate card, or unavailable screening buttons.',
      );
    const loaded = snapshot.cards.length;
    for (const card of snapshot.cards) {
      if (examined.has(card.studyId)) {
        if (examined.get(card.studyId) !== card.title)
          throw new Error('A study changed during discovery. Run discovery again.');
        continue;
      }
      examined.set(card.studyId, card.title);
      if (await savedDecision(card.studyId)) {
        blocked.push({
          ...card,
          reason: 'Decision saved without submission; excluded from new batches.',
        });
        continue;
      }
      const prior = await existingVote(card.studyId);
      if (prior)
        blocked.push({
          ...card,
          reason: 'Existing local vote claim; inspect history before reusing a reset demo.',
        });
      else studies.push({ studyId: card.studyId, title: card.title });
      if (studies.length === requested) return result(false);
    }
    if (snapshot.more === 0) return result(false);
    if (loaded <= lastCount) {
      await page.waitForTimeout(150);
      continue;
    }
    if (snapshot.more !== 1)
      throw new Error('Multiple Load more controls; cannot select one reliably.');
    if (!snapshot.moreEnabled) {
      await page.waitForTimeout(150);
      continue;
    }
    log(`Collecting your batch: ${studies.length} of ${requested} available studies…`);
    lastCount = loaded;
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    previous = '';
    deadline = Date.now() + config.timeoutMs;
  }
  throw new Error('Study discovery timed out before the requested batch was verified.');
}
