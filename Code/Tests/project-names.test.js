import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { normalizeProjectName, projectLabel, reviewFolder } from '../Application/config.js';
import { reviewDraft, saveSettings } from '../Application/settings.js';
import { criteriaApproval, validateProfile } from '../Application/profiles.js';
import { QueueStore } from '../Application/queue-store.js';
import { buildRequest } from '../Application/openai.js';
import { profileFile } from './fixtures.js';

test('project names are optional single-line Unicode labels up to 120 characters', () => {
  assert.equal(normalizeProjectName(), '');
  assert.equal(normalizeProjectName('   '), '');
  assert.equal(normalizeProjectName('  诊所 / Treatment 🧠  '), '诊所 / Treatment 🧠');
  assert.equal(normalizeProjectName('🧠'.repeat(120)), '🧠'.repeat(120));
  for (const name of [
    null,
    42,
    {},
    'a'.repeat(121),
    'Two\nlines',
    'Tab\tname',
    '\x1b[2J',
    'a\u2028b',
  ])
    assert.throws(() => normalizeProjectName(name), /[Pp]roject name/);
});

test('renaming and clearing keep the folder, approved criteria, AI request and saved batch intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-project-name-'));
  const projectLocation = (url) => path.join(dir, path.basename(reviewFolder(url)));
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  const before = await validateProfile(settings, 'demo', '1');
  assert.equal(before.projectName, ''); // Legacy settings need no migration.
  const file = path.join(projectLocation(before.reviewUrl), 'Project settings.json');
  const options = { file, baseDir: dir, loadCurrent: async () => before };
  const store = new QueueStore(path.join(dir, 'screening.sqlite'));
  const study = { studyId: '1', title: 'Local fixture', abstract: 'Local fixture text.' };
  try {
    const batch = store.create(before, ['1'], 'recommend-only');
    const originalItems = store.items(batch.id);
    for (const projectName of ['  诊所 and Treatment  ', 'Renamed project', '']) {
      await saveSettings({ ...settings, projectName }, options);
      const saved = JSON.parse(await readFile(file, 'utf8'));
      const after = await validateProfile(saved, 'demo', '1');
      assert.equal(saved.projectName, projectName.trim());
      assert.equal(after.configHash, before.configHash);
      assert.equal(saved.criteriaApproval, criteriaApproval(settings));
      assert.deepEqual(buildRequest(after, study), buildRequest(before, study));
      assert.deepEqual(store.settings(batch.id), before);
      assert.deepEqual(store.items(batch.id), originalItems);
      assert.deepEqual(store.job(batch.id), batch);
      const identity = path.basename(reviewFolder(batch.review_url));
      assert.equal(
        projectLabel(batch.review_url, { projectLocation }),
        saved.projectName ? `${saved.projectName} (${identity})` : identity,
      );
    }
    const content = await readFile(file, 'utf8');
    await assert.rejects(saveSettings({ ...settings, projectName: 'a'.repeat(121) }, options));
    assert.equal(await readFile(file, 'utf8'), content);
  } finally {
    store.close();
  }
});

test('switching reviews restores each name and duplicate names keep distinct review identities', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-project-labels-'));
  const projectLocation = (url) => path.join(dir, path.basename(reviewFolder(url)));
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  const current = { ...settings, projectName: 'Shared name' };
  const other = {
    ...settings,
    projectName: 'Other name',
    reviewUrl: 'https://demo.covidence.org/reviews/222',
  };
  for (const draft of [current, other]) {
    await mkdir(projectLocation(draft.reviewUrl), { recursive: true });
    await writeFile(
      path.join(projectLocation(draft.reviewUrl), 'Project settings.json'),
      JSON.stringify(draft),
    );
  }
  const switched = await reviewDraft(current, other.reviewUrl, { projectLocation });
  assert.equal(switched.projectName, 'Other name');
  const returned = await reviewDraft(switched, current.reviewUrl, { projectLocation });
  assert.equal(returned.projectName, 'Shared name');
  assert.notEqual(
    projectLabel(current.reviewUrl, { projectName: 'Shared name' }),
    projectLabel(other.reviewUrl, { projectName: 'Shared name' }),
  );
});

test('missing or damaged optional project metadata leaves saved batches accessible by review number', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-project-label-fallback-'));
  const reviewUrl = 'https://app.covidence.org/reviews/111';
  const options = { projectLocation: () => dir };
  const file = path.join(dir, 'Project settings.json');
  assert.equal(projectLabel(reviewUrl, options), 'Review 111');
  for (const content of [
    '{broken json',
    JSON.stringify({ reviewUrl }),
    JSON.stringify({ reviewUrl, projectName: 42 }),
    JSON.stringify({ reviewUrl, projectName: 'a\nb' }),
    JSON.stringify({
      reviewUrl: 'https://app.covidence.org/reviews/222',
      projectName: 'Wrong review',
    }),
  ]) {
    await writeFile(file, content);
    assert.equal(projectLabel(reviewUrl, options), 'Review 111');
  }
});
