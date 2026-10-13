import { assertReview } from './covidence.js';
export function browserOptions(mode = 'visible') {
  if (!['visible', 'headless'].includes(mode))
    throw new Error('Browser mode must be visible or headless.');
  return { headless: mode === 'headless' };
}
export async function openReview(page, config, mode, question) {
  browserOptions(mode);
  await page.goto(config.reviewUrl, { waitUntil: 'domcontentloaded' });
  const address = new URL(page.url());
  if (
    address.origin === new URL(config.reviewUrl).origin &&
    /^\/sign_in\/?$/.test(address.pathname)
  ) {
    if (mode === 'headless') {
      /** @type {Error & {code?: string}} */
      const error = new Error('Your Covidence session has expired. Log in to continue.');
      error.code = 'LOGIN_REQUIRED';
      throw error;
    }
    await question('Log in in Chromium, then press Enter here to continue. ');
    await page.goto(config.reviewUrl, { waitUntil: 'domcontentloaded' });
  }
  try {
    assertReview(page.url(), config.reviewUrl);
    await page
      .getByPlaceholder('Search studies', { exact: true })
      .waitFor({ state: 'visible', timeout: config.timeoutMs });
    assertReview(page.url(), config.reviewUrl);
  } catch (error) {
    if (/** @type {Error & {code?: string}} */ (error).code === 'REVIEW_NOT_OPEN') throw error;
    if (mode === 'headless')
      throw new Error(
        'Could not access the screening page. Check the connection and your access to this review. No new vote was submitted.',
        { cause: error },
      );
    throw error;
  }
}

// Expired headless sessions reopen visibly for login. A working session proceeds
// without a readiness prompt; unrelated page failures are not treated as login.
export function observeBrowser(context, onEvent) {
  const listeners = [];
  const listen = (target, name, callback) => {
    target.on(name, callback);
    listeners.push(() => target.off(name, callback));
  };
  const report = (kind) => {
    try {
      onEvent({ kind, at: new Date().toISOString() });
    } catch {
      console.error('Could not save the browser diagnostic event.');
    }
  };
  const watchPage = (page) => {
    listen(page, 'crash', () => report('page_crashed'));
    listen(page, 'close', () => report('page_closed'));
  };
  listen(context, 'page', watchPage);
  for (const page of context.pages()) watchPage(page);
  listen(context, 'close', () => report('context_closed'));
  const browser = context.browser();
  if (browser) listen(browser, 'disconnected', () => report('browser_disconnected'));
  return async () => {
    // Intentional cleanup must not appear as an unexpected browser failure.
    for (const remove of listeners) remove();
    await context.close();
  };
}

export async function openReviewBrowser({
  chromium,
  profileDir,
  config,
  mode,
  question,
  managedShutdown = false,
  onEvent,
}) {
  let context, close;
  try {
    const open = async () => {
      context = await chromium.launchPersistentContext(profileDir, {
        ...browserOptions(mode),
        // The worker owns cooperative stopping and must finish its checkpoint
        // before closing Chromium. Playwright otherwise closes it on SIGINT.
        ...(managedShutdown ? { handleSIGINT: false, handleSIGTERM: false } : {}),
      });
      close = onEvent ? observeBrowser(context, onEvent) : () => context.close();
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(config.timeoutMs);
      await openReview(page, config, mode, question);
      return page;
    };
    let page;
    try {
      page = await open();
    } catch (error) {
      if (
        mode !== 'headless' ||
        /** @type {Error & {code?: string}} */ (error).code !== 'LOGIN_REQUIRED'
      )
        throw error;
      await close?.();
      context = null;
      close = null;
      mode = 'visible';
      page = await open();
    }
    return { context, page, close };
  } catch (error) {
    await close?.();
    throw error;
  }
}
