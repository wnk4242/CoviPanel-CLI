import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { databasePath, profileDir, screeningAddress } from './config.js';
import { reviewKey } from './project-history.js';
import { readReviewer } from './reviewer.js';
import { withRecords } from './records.js';
import { acquireWorkerLock } from './queue-store.js';
import { browserLibrary } from './dependencies.js';

export function parsePersonalProgress(text) {
  const matches = [
    ...text.replace(/\s+/g, ' ').matchAll(/You've screened ([\d,]+) studies so far\b/g),
  ];
  if (matches.length !== 1 || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(matches[0][1]))
    throw new Error('Your personal screening total is unavailable in Covidence.');
  const total = Number(matches[0][1].replaceAll(',', ''));
  if (!Number.isSafeInteger(total)) throw new Error('Invalid Covidence screening total.');
  return total;
}

export async function readCovidenceProgress(page, reviewUrl, { timeout = 8000 } = {}) {
  const sourceUrl = reviewKey(screeningAddress(reviewUrl));
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout });
  const address = new URL(page.url());
  if (address.pathname === '/sign_in') throw new Error('Sign in through project settings to sync.');
  if (address.origin + address.pathname.replace(/\/$/, '') !== sourceUrl || address.search)
    throw new Error('The requested Covidence review summary did not open.');
  const section = page.getByRole('button', { name: 'Title and abstract screening', exact: true });
  await section.waitFor({ state: 'visible', timeout });
  if ((await section.count()) !== 1) throw new Error('Ambiguous screening progress section.');
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
  const id = await section.getAttribute('aria-controls');
  if (!id || !/^[\w-]+$/.test(id)) throw new Error('Missing screening progress section.');
  const panel = page.locator(`[id="${id}"]`);
  await panel.waitFor({ state: 'visible', timeout });
  await panel.getByText(/You've\s+screened/).waitFor({ state: 'visible', timeout });
  const total = parsePersonalProgress(await panel.innerText());
  const reviewer = await readReviewer(page);
  if (!reviewer?.name) throw new Error('Cannot identify the signed-in Covidence account.');
  return { total, reviewer: reviewer.name, sourceUrl, syncedAt: new Date().toISOString() };
}

export function saveCovidenceProgress(databaseFile, reviewUrl, progress) {
  if (
    !Number.isSafeInteger(progress.total) ||
    progress.total < 0 ||
    !progress.reviewer ||
    reviewKey(reviewUrl) !== progress.sourceUrl ||
    !Number.isFinite(Date.parse(progress.syncedAt))
  )
    throw new Error('Invalid personal progress snapshot.');
  withRecords(databaseFile, (store) =>
    store.projectEvent(randomUUID(), reviewUrl, 'covidence_progress', progress),
  );
}

// An independent read-only browser page: never changes a worker's study or submits votes.
// The lock also avoids opening a second persistent browser while screening is active.
export async function syncCovidenceProgress(
  projects,
  {
    databaseFile = databasePath,
    browserProfile = profileDir,
    launch = (dir) =>
      browserLibrary().chromium.launchPersistentContext(dir, { headless: true, timeout: 8000 }),
    lock = () => acquireWorkerLock(path.dirname(databaseFile)),
    read = readCovidenceProgress,
  } = {},
) {
  if (!projects.length) return new Map();
  const results = new Map();
  let context, release;
  try {
    if (!existsSync(browserProfile)) throw new Error('Sign in through project settings to sync.');
    release = await lock();
    context = await launch(browserProfile);
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(8000);
    for (const project of projects) {
      try {
        const progress = await read(page, project.reviewUrl);
        saveCovidenceProgress(databaseFile, project.reviewUrl, progress);
        // Every project uses the same summary refresh. Individual study History is not
        // inspected here; local counts continue to use the evidence already recorded.
        results.set(reviewKey(project.reviewUrl), { synced: true });
      } catch {
        results.set(reviewKey(project.reviewUrl), {
          error: 'Sync unavailable; check login or connection.',
        });
      }
    }
  } catch {
    for (const project of projects)
      results.set(reviewKey(project.reviewUrl), {
        error: 'Sync unavailable; check login, connection or active screening.',
      });
  } finally {
    try {
      await context?.close();
    } finally {
      await release?.();
    }
  }
  return results;
}
