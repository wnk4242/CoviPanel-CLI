// This function runs inside Chromium. It reads the DOM; it never invokes controls.
export function inspectStudy(selectors = {}) {
  const visible = (el) =>
    el instanceof HTMLElement &&
    el.checkVisibility() &&
    !el.closest('[hidden], [aria-hidden="true"]');
  const text = (el) => (el?.innerText ?? '').trim();
  const select = (root, css) => [...root.querySelectorAll(css)].filter(visible);
  const fail = (reason) => ({ ready: false, reason });
  const label = (button) => {
    const strings = [
      button.value,
      button.getAttribute('aria-label'),
      button.title,
      text(button),
    ].filter(Boolean);
    const matches = ['Yes', 'No', 'Maybe'].filter((value) =>
      strings.some((s) => new RegExp(`\\b${value}\\b`, 'i').test(s)),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const cards = select(document, selectors.studyContainer || '[data-testclass="study"]');
  if ((selectors.studyContainer || cards.length) && cards.length !== 1)
    return fail(`Expected one visible study card; found ${cards.length}.`);
  const scope = cards[0] || document;
  let buttons = select(scope, 'button[data-pendo-key="vote-button"], button.vote-option');
  if (!buttons.length)
    buttons = select(scope, 'button, [role="button"]').filter((b) =>
      /^(yes|no|maybe)$/i.test(b.getAttribute('aria-label') || text(b)),
    );
  const votes = {};
  for (const value of ['Yes', 'No', 'Maybe']) {
    const found = buttons.filter((b) => label(b) === value);
    if (found.length !== 1)
      return fail(`Expected one visible ${value} control; found ${found.length}.`);
    votes[value] = found[0];
  }
  const roots = [...cards];
  if (selectors.studyContainer && roots.length !== 1)
    return fail('studyContainer selector must match exactly one visible element.');
  if (!roots.length) {
    // Inspect ancestors nearest the controls first; never use the whole page.
    for (let el = votes.Yes.parentElement; el && el !== document.body; el = el.parentElement) {
      if (Object.values(votes).every((b) => el.contains(b))) roots.push(el);
    }
  }
  let lastReason = 'No study container containing all three controls was found.';
  for (const root of roots) {
    if (!Object.values(votes).every((b) => root.contains(b))) continue;
    if (
      root.matches('[aria-busy="true"], [role="progressbar"]') ||
      select(root, '[aria-busy="true"], [role="progressbar"]').length
    )
      return fail('Study is still loading.');
    const one = (css) => {
      const nodes = select(root, css);
      return nodes.length === 1 ? text(nodes[0]) : '';
    };
    // Identity must be a citation label, never the search input or arbitrary body text.
    const idNodes = select(
      root,
      selectors.studyId || '[data-testid="study-id"], .study-id, span, small, p, h1, h2, h3',
    );
    const ids = [
      ...new Set(
        idNodes
          .map((el) => text(el).match(/^(?:Study\s*(?:ID\s*)?:?\s*)?#(\d+)\b(?:\s.*)?$/i)?.[1])
          .filter(Boolean),
      ),
    ];
    if (ids.length !== 1) {
      lastReason = 'No unique displayed citation ID label (#123) found in the study container.';
      continue;
    }
    const cardId = root.getAttribute('data-testid')?.match(/^Study #(\d+)\b/)?.[1];
    if (cardId && cardId !== ids[0]) return fail('Study card ID and visible citation ID disagree.');
    const title = selectors.title
      ? one(selectors.title)
      : one('[data-testid="study-title"], [data-testid="citation-title"]') ||
        (() => {
          const headings = select(root, 'h1, h2, h3').filter(
            (el) => !/^(?:abstract\b|#\d+\b|Study\s*(?:ID)?\s*#)/i.test(text(el)),
          );
          return headings.length === 1 ? text(headings[0]) : '';
        })();
    if (!title) {
      lastReason = `Study #${ids[0]} has no unique visible title.`;
      continue;
    }
    const abstractSelector =
      selectors.abstract || '[data-testid="abstract"], [data-testid="study-abstract"]';
    const abstractNodes = [...root.querySelectorAll(abstractSelector)];
    const abstractToggles = [...root.querySelectorAll('button')].filter((el) =>
      /^Abstract$/i.test(el.getAttribute('aria-label') || el.textContent.trim()),
    );
    const labelledAbstracts = [...root.querySelectorAll('section, div, p')].filter(
      (el) =>
        /^abstract\b[:\s]/i.test(el.textContent.trim()) &&
        !Object.values(votes).some((b) => el.contains(b)),
    );
    if (abstractNodes.length > 1 || (!selectors.abstract && abstractToggles.length > 1)) {
      lastReason = `Study #${ids[0]} has ambiguous abstract elements.`;
      continue;
    }
    if (
      !selectors.abstract &&
      abstractToggles.length === 1 &&
      visible(abstractToggles[0]) &&
      abstractToggles[0].hasAttribute('aria-controls') &&
      abstractToggles[0].getAttribute('aria-expanded') === 'false'
    ) {
      return {
        ready: false,
        studyId: ids[0],
        title,
        abstractCollapsed: true,
        reason: `Study #${ids[0]}'s abstract is collapsed.`,
      };
    }
    let abstract = one(abstractSelector);
    if (!abstract && !selectors.abstract) {
      const toggles = select(root, 'button[aria-controls][aria-expanded="true"]').filter((el) =>
        /^Abstract$/i.test(text(el)),
      );
      if (toggles.length === 1) {
        const target = document.getElementById(toggles[0].getAttribute('aria-controls'));
        if (target && root.contains(target) && visible(target)) abstract = text(target);
      }
    }
    if (!abstract && !selectors.abstract) {
      const candidates = select(root, 'section, div, p').filter(
        (el) =>
          /^abstract\b[:\s]/i.test(text(el)) && !Object.values(votes).some((b) => el.contains(b)),
      );
      const smallest = candidates.filter(
        (el) => !candidates.some((other) => other !== el && el.contains(other)),
      );
      if (smallest.length === 1) abstract = text(smallest[0]);
    }
    abstract = abstract.replace(/^abstract\b[:\s]*/i, '').trim();
    // Observed Covidence cards omit the entire Abstract control/section when no
    // abstract was imported (#89). Hidden, empty or ambiguous abstract elements
    // are extraction failures, not evidence that the citation has no abstract.
    const noAbstract =
      !abstract &&
      !selectors.abstract &&
      root.matches('[data-testclass="study"]') &&
      cardId === ids[0] &&
      !abstractNodes.length &&
      !abstractToggles.length &&
      !labelledAbstracts.length;
    if (!abstract && !noAbstract) {
      lastReason = `Study #${ids[0]}'s abstract is not readable or is ambiguous.`;
      continue;
    }
    // Live demo markup places citation metadata immediately after its h3 title.
    const metadata = select(root, 'h3 + div > p');
    const authorText = text(metadata[0]);
    const years = metadata.map(text).filter((value) => /^(19|20)\d{2}$/.test(value));
    return {
      ready: true,
      studyId: ids[0],
      title,
      abstract,
      ...(noAbstract ? { abstractStatus: 'not_available' } : {}),
      author: selectors.author
        ? one(selectors.author)
        : one('[data-testid="study-authors"]') || (authorText.includes(',') ? authorText : ''),
      year: selectors.year
        ? one(selectors.year)
        : one('[data-testid="study-year"]') || (years.length === 1 ? years[0] : ''),
      controls: Object.fromEntries(
        Object.entries(votes).map(([key, el]) => [
          key,
          { found: true, enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true' },
        ]),
      ),
    };
  }
  return fail(lastReason);
}

export function assertReview(pageUrl, reviewUrl) {
  const actual = new URL(pageUrl);
  const expected = new URL(reviewUrl);
  const review = (value) => value.pathname.match(/^\/reviews\/(\d+)(?:\/|$)/)?.[1];
  if (actual.origin !== expected.origin || !review(actual) || review(actual) !== review(expected)) {
    const reviewsList =
      actual.origin === expected.origin &&
      /^\/reviews(?:\/(?:active|archived))?\/?$/.test(actual.pathname);
    /** @type {Error & {code?: string}} */
    const error = new Error(
      reviewsList
        ? `Review #${review(expected)} did not open. Covidence redirected to the reviews list (${actual.origin}${actual.pathname}). Choose the saved project matching the review available in Covidence.`
        : `Expected review #${review(expected)} at ${expected.origin}, but the browser opened ${actual.origin}${actual.pathname}. Open the selected review in Covidence, then continue.`,
    );
    error.code = 'REVIEW_NOT_OPEN';
    throw error;
  }
}

export async function searchStudy(page, config) {
  assertReview(page.url(), config.reviewUrl);
  const search = page.getByPlaceholder('Search studies', { exact: true });
  await search.waitFor({ state: 'visible', timeout: config.timeoutMs });
  if ((await search.count()) !== 1) throw new Error('Search studies field is ambiguous. Stopping.');
  const before = await page.evaluate(inspectStudy, config.selectors);
  await search.fill(`#${config.studyId}`);
  await search.press('Enter');
  // Poll snapshots, not element handles. Require a stable full citation, identity,
  // controls and absence of busy indicators, rather than a fixed navigation sleep.
  const deadline = Date.now() + config.timeoutMs;
  let previous = '';
  let stableSince = 0;
  let last = { reason: 'No study loaded.' };
  while (Date.now() < deadline) {
    assertReview(page.url(), config.reviewUrl);
    try {
      last = await page.evaluate(inspectStudy, config.selectors);
    } catch (error) {
      if (!/Execution context was destroyed/.test(error.message)) throw error;
      previous = '';
      stableSince = 0;
      continue;
    }
    if (last.abstractCollapsed && last.studyId === config.studyId) {
      const card = page
        .locator(config.selectors?.studyContainer || '[data-testclass="study"]')
        .filter({ visible: true });
      const toggle = card.getByRole('button', { name: 'Abstract', exact: true, expanded: false });
      if ((await card.count()) === 1 && (await toggle.count()) === 1)
        await toggle.click({ timeout: Math.min(config.timeoutMs, 3000) });
      previous = '';
      stableSince = 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    const oldContent =
      before.ready &&
      before.studyId !== config.studyId &&
      (last.title === before.title ||
        (Boolean(before.abstract) && last.abstract === before.abstract));
    if (last.ready && last.studyId === config.studyId && !oldContent) {
      const snapshot = JSON.stringify(last);
      if (snapshot !== previous) {
        previous = snapshot;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1500) return last;
    } else {
      previous = '';
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (last.ready && last.studyId !== config.studyId) {
    throw new Error(
      `Requested study #${config.studyId} but study #${last.studyId} is displayed. Stopping.`,
    );
  }
  throw new Error(
    `Could not verify stable study #${config.studyId}. ${last.reason || 'Content remained stale or unstable.'} Stopping.`,
  );
}
