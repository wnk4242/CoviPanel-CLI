import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { reviewDraft, saveSettings } from '../Application/settings.js';
import { validateProfile } from '../Application/profiles.js';
import { initializeSettings } from '../Application/setup.js';
import { profileFile, loadProfile } from './fixtures.js';

test('a different real review starts unapproved with empty criteria and its own identity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-new-review-'));
  const current = {
    ...JSON.parse(await readFile(profileFile('demo'), 'utf8')),
    dataset: 'standard-review',
    projectName: 'Project A',
    reviewUrl: 'https://app.covidence.org/reviews/111',
    criteria: {
      inclusion: ['Only project A'],
      exclusion: ['Project A exclusion'],
      interpretation: [],
    },
    criteriaApproval: 'old-approval',
  };
  const options = { projectLocation: () => path.join(dir, 'new') };
  const fresh = await reviewDraft(current, 'https://app.covidence.org/reviews/222', options);
  assert.deepEqual(fresh.promptSections, { inclusion: '', exclusion: '', responseFormat: '' });
  assert.equal(fresh.criteriaApproved, false);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.criteriaApproval, undefined);
  assert.equal(fresh.projectName, '');
  assert.notEqual(fresh.criteriaVersion, current.criteriaVersion);
  assert.deepEqual(fresh.openai, current.openai);
  fresh.promptSections.inclusion = 'Separate';
  assert.equal(current.criteria.inclusion.length, 1);
});

test('saved approval is bound to this review and criteria, and disabled settings can be repaired', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-approval-')),
    file = path.join(dir, 'settings.json');
  const draft = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  await saveSettings(draft, {
    file,
    baseDir: dir,
    loadCurrent: async () => {
      throw new Error('Profile disabled');
    },
  });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(saved.criteriaApproval);
  await validateProfile(saved, 'demo', '1');
  await assert.rejects(
    validateProfile({ ...saved, reviewUrl: 'https://demo.covidence.org/reviews/999' }, 'demo', '1'),
    /since approval/,
  );
  await assert.rejects(
    validateProfile(
      { ...saved, criteria: { ...saved.criteria, inclusion: ['Different rules'] } },
      'demo',
      '1',
    ),
    /since approval/,
  );
});

test('renamed runtime keeps legacy prompt paths and recommendation settings hashes valid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'covipanel-runtime-path-'));
  await mkdir(path.join(root, 'Setups', 'Settings'), { recursive: true });
  const expected = await loadProfile('demo', '1');
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  await writeFile(path.join(root, 'Setups', 'Settings', 'screening-prompt.txt'), expected.prompt);
  for (const promptFile of [
    'Setups/Settings/screening-prompt.txt',
    'Program/Settings/screening-prompt.txt',
    'Program\\Settings\\screening-prompt.txt',
  ]) {
    const config = await validateProfile({ ...settings, promptFile }, 'demo', '1', { root });
    assert.equal(config.prompt, expected.prompt);
    assert.equal(config.configHash, expected.configHash);
  }
  await assert.rejects(stat(path.join(root, 'Program')), (error) => error.code === 'ENOENT');
});

test('first-run setup needs no personal settings and preserves existing credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'covipanel-setup-'));
  const created = await initializeSettings(root);
  assert.equal(created.length, 4);
  const key = path.join(root, 'Setups', 'Settings', '.env');
  await writeFile(key, 'OPENAI_API_KEY=local-test-only\n');
  assert.equal((await initializeSettings(root)).length, 0);
  assert.equal(await readFile(key, 'utf8'), 'OPENAI_API_KEY=local-test-only\n');
  const index = JSON.parse(
    await readFile(path.join(root, 'Setups', 'Settings', 'projects.json'), 'utf8'),
  );
  const blank = JSON.parse(
    await readFile(path.join(root, 'Covidence Projects', index.demo), 'utf8'),
  );
  assert.equal(blank.enabled, false);
  assert.equal(blank.promptSections.inclusion, '');
  assert.equal(blank.criteria, undefined);
  await assert.rejects(
    stat(path.join(root, 'Setups', 'State', 'screening.sqlite')),
    (error) => error.code === 'ENOENT',
  );
  // Loading a fixture never consults this newly created runtime or the user's.
  assert.equal((await loadProfile('demo', '1')).openai.model, 'fixture-model');
});
