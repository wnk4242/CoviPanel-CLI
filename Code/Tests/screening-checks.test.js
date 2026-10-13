import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { browserLibrary } from '../Application/dependencies.js';

const { chromium } = browserLibrary();
import { readReviewer } from '../Application/reviewer.js';
import { QueueStore } from '../Application/queue-store.js';
import { queueOperations } from '../Application/queue-operations.js';
import { runQueue } from '../Application/queue-runner.js';
import { studyHash } from '../Application/profiles.js';
import { saveSettings } from '../Application/settings.js';
import { profileFile, loadProfile } from './fixtures.js';

test('account metadata is optional and never requires a manually entered name', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const menu =
    '<button aria-label="Profile menu"><div role="img" aria-label="Example Reviewer">ER</div></button>';
  await page.setContent(menu);
  assert.equal((await readReviewer(page)).name, 'Example Reviewer');
  for (const body of [
    '',
    menu + menu,
    '<button aria-label="Profile menu">ER</button>',
    menu.replace('aria-label="Example Reviewer"', 'aria-label=""'),
  ]) {
    await page.setContent(body);
    assert.equal(await readReviewer(page), null);
  }
  assert.equal(
    await readReviewer({
      getByRole: () => {
        throw new Error('Menu unavailable');
      },
    }),
    null,
  );
});

test('automatic queue runs regardless of a missing or different saved reviewer name', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-no-name-check-'));
  const databasePath = path.join(dir, 'screening.sqlite');
  const store = new QueueStore(databasePath);
  t.after(() => store.close());
  const base = await loadProfile('demo', '1');
  for (const reviewerName of [undefined, '', 'E.R.', 'Other name']) {
    const config = { ...base, reviewerName };
    const job = store.create(config, ['1'], 'auto-vote');
    const study = { ready: true, studyId: '1', title: 'Test', abstract: 'Trial' };
    const operations = queueOperations({ config, databasePath });
    // This queue test has no browser. Any new account prerequisite would fail.
    operations.extract = async () => study;
    operations.cached = async () => ({
      record: { status: 'recommended', studyHash: studyHash(study), decision: 'Include' },
    });
    operations.vote = async () => ({ record: { status: 'confirmed', recordedVote: 'Yes' } });
    const result = await runQueue({ store, job, config, operations, log: () => {} });
    assert.equal(result[0].state, 'completed');
  }
});

test('project settings save with no reviewer name and retain the original prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-no-reviewer-setting-'));
  const file = path.join(dir, 'project.json');
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  delete settings.reviewerName;
  const before = await loadProfile('demo', '1');
  await saveSettings(settings, { file, baseDir: dir, loadCurrent: async () => before });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.reviewerName, undefined);
  assert.equal(saved.promptFile, settings.promptFile);
  assert.deepEqual(saved.criteria, settings.criteria);
});
