import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { browserLibrary } from '../Application/dependencies.js';
import {
  parsePersonalProgress,
  readCovidenceProgress,
  saveCovidenceProgress,
  syncCovidenceProgress,
} from '../Application/covidence-progress.js';
import { listProjects, projectLocation } from '../Application/projects.js';
import { withRecords } from '../Application/records.js';
import { chooseProject } from '../Application/project-menu.js';
import { screenText } from '../Application/terminal-screen.js';

const reviewUrl =
  'https://app.covidence.org/reviews/123/review_studies/screen?filter=vote_required_from';
const sourceUrl = 'https://app.covidence.org/reviews/123';
const snapshot = (total = 403) => ({
  total,
  reviewer: 'Fixture Reviewer',
  sourceUrl,
  syncedAt: '2026-09-15T12:00:00Z',
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-progress-'));
  const root = path.join(dir, 'Projects');
  const folder = projectLocation(reviewUrl, root);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'Project settings.json'),
    JSON.stringify({ reviewUrl, projectName: 'Progress fixture' }),
  );
  return { root, databaseFile: path.join(dir, 'screening.sqlite'), browserProfile: dir };
}

test('personal progress cannot be confused with team totals, remaining studies or malformed numbers', () => {
  assert.equal(
    parsePersonalProgress(
      "11596 Done 11804 studies to screen You've\n screened 403 studies so far",
    ),
    403,
  );
  assert.equal(parsePersonalProgress("You've screened 1,403 studies so far"), 1403);
  assert.equal(parsePersonalProgress("You've screened 0 studies so far"), 0);
  for (const text of [
    '403 Done',
    '403 studies to screen',
    "You've screened 4,03 studies so far",
    "You've screened 1 studies so far You've screened 2 studies so far",
    "You've screened 9007199254740992 studies so far",
  ])
    assert.throws(() => parsePersonalProgress(text));
});

test('summary reader uses the personal title/abstract section and never clicks a vote on local browser fixtures', async (t) => {
  const browser = await browserLibrary().chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(500);
  let votes = 0;
  await page.exposeFunction('voteFixture', () => votes++);
  let body = `<button aria-label="Profile menu"><span role="img" aria-label="Fixture Reviewer"></span></button>
    <button aria-expanded="false" aria-controls="title-progress" onclick="this.setAttribute('aria-expanded','true');document.getElementById('title-progress').hidden=false">Title and abstract screening</button>
    <div id="title-progress" hidden>11596 Done 11804 studies to screen <p>You've screened <b>403</b> studies so far</p></div>
    <div>Full text review You've screened 999 studies so far</div>
    <button data-pendo-key="vote-button" onclick="voteFixture()">Yes</button>`;
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body }));
  const progress = await readCovidenceProgress(page, reviewUrl, { timeout: 1000 });
  assert.equal(progress.total, 403);
  assert.equal(progress.reviewer, 'Fixture Reviewer');
  assert.equal(progress.sourceUrl, sourceUrl);
  assert.equal(votes, 0);
  body = body.replace('aria-label="Fixture Reviewer"', 'aria-label=""');
  await assert.rejects(readCovidenceProgress(page, reviewUrl, { timeout: 1000 }), /signed-in/);
  await assert.rejects(
    readCovidenceProgress(
      { goto: async () => {}, url: () => 'https://app.covidence.org/sign_in' },
      reviewUrl,
    ),
    /Sign in/,
  );
  await assert.rejects(
    readCovidenceProgress(
      { goto: async () => {}, url: () => 'https://app.covidence.org/reviews/999' },
      reviewUrl,
    ),
    /did not open/,
  );
  assert.equal(votes, 0);
});

test('copied databases retain laptop ownership, unknown history stays unassigned and new laptop work stays separate', async () => {
  const f = await fixture();
  const today = new Date(2026, 8, 15, 12);
  const yesterday = new Date(2026, 8, 14, 12).toISOString();
  withRecords(f.databaseFile, (store) => {
    for (const [runId, studyId, deviceId, updatedAt] of [
      ['legacy', '1', null, yesterday],
      ['a', '2', 'laptop-a', yesterday],
      ['a-retry', '2', 'laptop-a', today.toISOString()],
      ['b', '3', 'laptop-b', today.toISOString()],
      ['unknown', '4', null, yesterday],
    ])
      store.saveRecommendation({
        record: {
          runId,
          studyId,
          deviceId,
          updatedAt,
          reviewUrl,
          status: 'recommended',
          configHash: runId,
          dataset: 'fixture',
        },
      });
    store.projectEvent('assignment', reviewUrl, 'screening_device_assignment', {
      deviceId: 'laptop-a',
      refs: ['recommendation:legacy'],
    });
  });
  saveCovidenceProgress(f.databaseFile, reviewUrl, snapshot());
  const a = (await listProjects({ ...f, now: today, deviceId: 'laptop-a' }))[0];
  assert.deepEqual(a.localScreened, { today: 0, total: 2 });
  assert.equal(a.unassignedScreened, 1);
  const copied = path.join(f.browserProfile, 'copy.sqlite');
  await copyFile(f.databaseFile, copied);
  const b = (
    await listProjects({ ...f, databaseFile: copied, now: today, deviceId: 'laptop-b' })
  )[0];
  assert.deepEqual(b.localScreened, { today: 1, total: 1 });
  assert.equal(a.covidenceProgress.total, 403);
  assert.equal(b.covidenceProgress.total, 403);
  assert.deepEqual((await listProjects({ ...f, deviceId: 'new-laptop' }))[0].localScreened, {
    today: 0,
    total: 0,
  });
});

test('sync replaces server totals, handles other-laptop work and decreases, and keeps the last snapshot offline', async () => {
  const f = await fixture();
  const projects = [{ reviewUrl }];
  let serverTotal = 403,
    closed = 0,
    released = 0;
  const opts = {
    ...f,
    lock: async () => async () => released++,
    launch: async () => ({
      pages: () => [{ setDefaultTimeout: () => {} }],
      close: async () => closed++,
    }),
    read: async () => snapshot(serverTotal),
  };
  await syncCovidenceProgress(projects, opts);
  serverTotal = 420;
  await syncCovidenceProgress(projects, opts);
  assert.equal((await listProjects(f))[0].covidenceProgress.total, 420);
  serverTotal = 419; // Covidence may remove duplicate or undone contributions.
  await syncCovidenceProgress(projects, opts);
  assert.equal((await listProjects(f))[0].covidenceProgress.total, 419);
  const failed = await syncCovidenceProgress(projects, {
    ...opts,
    read: async () => {
      throw new Error('Offline');
    },
  });
  assert.ok(failed.get(sourceUrl).error);
  assert.equal((await listProjects(f))[0].covidenceProgress.total, 419);
  assert.equal(closed, 4);
  assert.equal(released, 4);
  await syncCovidenceProgress(projects, {
    ...opts,
    lock: async () => {
      throw new Error('Worker active');
    },
    launch: () => assert.fail('Must not launch during screening'),
  });
  assert.equal((await listProjects(f))[0].covidenceProgress.total, 419);
  assert.throws(() =>
    saveCovidenceProgress(f.databaseFile, reviewUrl, { ...snapshot(), sourceUrl: sourceUrl + '4' }),
  );
});

test('saved-project refresh shows history and Covidence counts with offline time and controls', async () => {
  const projects = [
    {
      name: 'Progress fixture',
      reviewUrl,
      unfinished: 0,
      screened: { today: 47, total: 138 },
      localScreened: { today: 16, total: 100 },
      historyTotal: 151,
      submittedToday: 12,
      screenedNotSubmitted: 4,
      covidenceProgress: snapshot(),
      syncError: 'offline',
    },
  ];
  const answers = ['r', '0'];
  const output = [];
  let refreshed = 0;
  await chooseProject(async () => answers.shift(), projects, {
    show: (title, lines) => output.push(screenText(title, lines, '', 80, 30)),
    reload: async () => {
      refreshed++;
      return projects.map((p) => ({ ...p, covidenceProgress: snapshot(410), syncError: null }));
    },
  });
  assert.equal(refreshed, 1);
  assert.match(output[0], /AI decision submitted today: 12/);
  assert.match(output[0], /Screened but not submitted: 4/);
  assert.doesNotMatch(output[0], /Decision history \| Total:|This laptop today:|\d+ unfinished/);
  assert.match(output[0], /^Covidence total \| 403$/m);
  assert.match(output[0], /Last synced:/);
  assert.match(output[0], /Sync unavailable/);
  assert.match(output[1], /^Covidence total \| 410$/m);
  assert.doesNotMatch(output[1], /Sync unavailable/);
  for (const screen of output) {
    assert.match(screen, /R\. Refresh counts/);
    assert.match(screen, /0\. Back to main menu/);
    assert.doesNotMatch(screen, /Full details are saved|Studies screened \| Today:/);
  }
});
