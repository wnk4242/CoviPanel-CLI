import { loadProfile, profileFile } from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { saveSettings, reviewDraft } from '../Application/settings.js';
import { validateProfile } from '../Application/profiles.js';
import { QueueStore } from '../Application/queue-store.js';
import { buildRequest } from '../Application/openai.js';
import { reviewFolder, screeningAddress, profileForReview } from '../Application/config.js';

test('pasted demo and real review home addresses resolve to screening without accepting unrelated filters or sites', () => {
  for (const root of [
    'https://demo.covidence.org/reviews/160736',
    'https://app.covidence.org/reviews/900001',
  ]) {
    const expected = root + '/review_studies/screen?filter=vote_required_from';
    for (const input of [
      root,
      root + '/',
      `  ${root}\r\n`,
      `[Review](${root})`,
      `<${root}>`,
      root + '/screen',
      root + '/screen?filter=vote_required_from',
      root + '/review_studies/screen',
      expected,
    ])
      assert.equal(screeningAddress(input), expected);
    assert.equal(profileForReview(root), root.includes('demo.') ? 'demo' : 'standard');
  }
  for (const input of [
    'https://example.com/reviews/1',
    'http://demo.covidence.org/reviews/1',
    'https://demo.covidence.org.evil.test/reviews/1',
    'https://user:password@app.covidence.org/reviews/1',
    'https://app.covidence.org/reviews/1?filter=all',
    'https://app.covidence.org/reviews/1?query=word',
    'https://app.covidence.org/reviews/1/screen?filter=vote_required_from&filter=all',
    'https://app.covidence.org/reviews/1#search',
  ])
    assert.throws(() => screeningAddress(input));
});

test('response wording changes request and configuration hash while preserving the voting schema', async () => {
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  const before = await validateProfile(settings, 'demo', '1');
  const after = await validateProfile(
    { ...settings, responseInstructions: 'Explain in three sentences.' },
    'demo',
    '1',
  );
  assert.notEqual(before.configHash, after.configHash);
  const study = {
    title: 'Treatment experiment.',
    abstract: 'Patients received vitamin C.',
    studyId: '1',
  };
  const request = buildRequest(after, study);
  assert.match(request.instructions, /Explain in three sentences/);
  assert.deepEqual(request.text.format.schema, buildRequest(before, study).text.format.schema);
});
test('saving settings preserves legacy and new batches and rejects invalid settings before writing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-settings-'));
  const file = path.join(dir, 'demo.json');
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  const before = await loadProfile('demo', '1');
  await writeFile(file, JSON.stringify(settings));
  const store = new QueueStore(path.join(dir, 'screening.sqlite'));
  try {
    const legacy = store.create(before, ['1'], 'recommend-only');
    const current = store.create(before, ['2'], 'recommend-only');
    store.db.prepare('DELETE FROM job_settings WHERE job_id=?').run(legacy.id);
    const draft = {
      ...settings,
      reviewerName: 'Changed Reviewer',
      responseInstructions: 'A detailed rationale.',
    };
    await saveSettings(draft, { file, baseDir: dir, loadCurrent: async () => before });
    for (const job of [legacy, current]) assert.deepEqual(store.settings(job.id), before);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).reviewerName, 'Changed Reviewer');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Number.isFinite(Date.parse(saved.settingsSavedAt)));
    assert.equal(
      (
        await validateProfile(
          { ...saved, settingsSavedAt: '2000-01-01T00:00:00.000Z' },
          'demo',
          '1',
        )
      ).configHash,
      (await validateProfile(saved, 'demo', '1')).configHash,
    );
    await assert.rejects(
      saveSettings(
        { ...draft, criteria: { ...draft.criteria, inclusion: [] } },
        { file, baseDir: dir, loadCurrent: async () => before },
      ),
      /criteria/,
    );
    assert.equal(
      JSON.parse(await readFile(file, 'utf8')).criteria.inclusion.length,
      settings.criteria.inclusion.length,
    );
  } finally {
    store.close();
  }
});

test('changing the demo review creates its own project settings and preserves the old project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-project-layout-'));
  const projectRoot = path.join(dir, 'Projects'),
    indexFile = path.join(dir, 'projects.json');
  const settings = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  settings.reviewUrl =
    'https://demo.covidence.org/reviews/160676/review_studies/screen?filter=vote_required_from';
  const before = await validateProfile(settings, 'demo', '1');
  const projectLocation = (url) => path.join(projectRoot, path.basename(reviewFolder(url)));
  const oldFile = path.join(projectLocation(settings.reviewUrl), 'Project settings.json');
  await mkdir(path.dirname(oldFile), { recursive: true });
  await writeFile(oldFile, JSON.stringify(settings));
  await writeFile(indexFile, JSON.stringify({ demo: path.relative(projectRoot, oldFile) }));
  const draft = {
    ...settings,
    reviewUrl: 'https://demo.covidence.org/reviews/160736/screen?filter=vote_required_from',
  };
  await saveSettings(draft, {
    baseDir: path.join(dir, 'State'),
    loadCurrent: async () => before,
    projectLocation,
    indexFile,
    projectRoot,
  });
  assert.deepEqual(JSON.parse(await readFile(oldFile, 'utf8')), settings);
  const selected = JSON.parse(await readFile(indexFile, 'utf8')).demo;
  assert.equal(selected, 'Demo Review 160736/Project settings.json');
  assert.equal(
    JSON.parse(await readFile(path.join(projectRoot, selected), 'utf8')).reviewUrl,
    screeningAddress(draft.reviewUrl),
  );
  assert.notEqual(reviewFolder(settings.reviewUrl), reviewFolder(draft.reviewUrl));
});

test('switching to a real review uses its own criteria and saves an active project without changing demo settings or batches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-real-settings-')),
    projectRoot = path.join(dir, 'Projects'),
    indexFile = path.join(dir, 'projects.json'),
    baseDir = path.join(dir, 'State');
  const demo = JSON.parse(await readFile(profileFile('demo'), 'utf8')),
    before = await loadProfile('demo', '1');
  const projectLocation = (url) => path.join(projectRoot, path.basename(reviewFolder(url)));
  await writeFile(
    indexFile,
    JSON.stringify({
      demo: 'Demo original/Project settings.json',
      standard: 'Unconfigured/Project settings.json',
    }),
  );
  const draft = await reviewDraft(demo, 'https://app.covidence.org/reviews/900001', {
    projectLocation,
  });
  assert.equal(draft.dataset, 'standard-review');
  assert.equal(draft.promptSections.inclusion, '');
  const options = {
    baseDir,
    projectLocation,
    indexFile,
    projectRoot,
    loadCurrent: async () => before,
  };
  await assert.rejects(saveSettings(draft, options), /criteria/);
  const store = new QueueStore(path.join(baseDir, 'screening.sqlite'));
  try {
    const oldJob = store.create(before, ['105'], 'recommend-only');
    draft.promptSections = {
      inclusion: 'Randomized trials of vitamin C treatment in adults.',
      exclusion: 'Review articles.',
      responseFormat:
        'Return Decision: Include / Exclude / Maybe and Rationale: explanation on separate lines.',
    };
    draft.criteriaVersion = 'configured-real-test';
    await saveSettings(draft, options);
    const index = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.equal(index.active, 'standard');
    assert.equal(index.demo, 'Demo original/Project settings.json');
    assert.equal(index['standard'], 'Review 900001/Project settings.json');
    const saved = JSON.parse(await readFile(path.join(projectRoot, index['standard']), 'utf8'));
    const config = await validateProfile(saved, 'standard', '105');
    assert.equal(config.reviewId, '900001');
    assert.equal(config.enabled, true);
    assert.deepEqual(store.settings(oldJob.id), before);
    const realJob = store.create(config, ['105'], 'confirm-each-vote');
    assert.equal(store.enableBatchReview(realJob.id).mode, 'review-all');
    assert.equal(store.items(realJob.id)[0].state, 'pending');
    assert.deepEqual(
      (await reviewDraft(demo, 'https://app.covidence.org/reviews/900001', { projectLocation }))
        .promptSections,
      draft.promptSections,
    );
  } finally {
    store.close();
  }
});
