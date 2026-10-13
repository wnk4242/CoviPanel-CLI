import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import {
  listProjects,
  readProject,
  loadProject,
  projectLocation,
  pendingScreenings,
} from '../Application/projects.js';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { runMainMenu, chooseProject } from '../Application/project-menu.js';
import { screenText } from '../Application/terminal-screen.js';
import { startScreening } from '../Application/screening-session.js';
import { runQueue } from '../Application/queue-runner.js';
import { validateProfile, studyHash } from '../Application/profiles.js';
import { projectSettings, reviewDraft, saveSettings } from '../Application/settings.js';
import { createProject } from '../Application/project-setup.js';
import { loadProfile } from './fixtures.js';
import { buildRequest } from '../Application/openai.js';
import { buildPrompt } from '../Application/prompt-sections.js';
import { readProjectHistory, reviewKey } from '../Application/project-history.js';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-project-flow-'));
  const root = path.join(dir, 'Projects'),
    databaseFile = path.join(dir, 'screening.sqlite');
  const legacy = await loadProfile('demo', '1');
  const configs = [];
  for (const id of ['111', '222', '333']) {
    const { criteria, promptFile, prompt, configHash, profile, reviewId, ...base } = legacy;
    const settings = {
      ...base,
      dataset: 'standard-review',
      projectName: `Project ${id}`,
      reviewUrl: `https://app.covidence.org/reviews/${id}/review_studies/screen?filter=vote_required_from`,
      promptSections: {
        inclusion: `Include project ${id}.`,
        exclusion: 'Reviews.',
        responseFormat: 'Decision: Include / Exclude / Maybe\nRationale: explanation',
      },
    };
    delete settings.criteriaApproval;
    const config = await validateProfile(settings, 'standard', '1');
    const folder = projectLocation(config.reviewUrl, root);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(settings));
    configs.push(config);
  }
  return { root, databaseFile, configs };
}
function answers(values) {
  const prompts = [];
  const question = async (prompt) => {
    prompts.push(prompt);
    assert.ok(values.length, `Unexpected prompt: ${prompt}`);
    return values.shift();
  };
  return { question, prompts };
}

test('project catalog lists multiple real reviews, completed projects and broken settings independently', async () => {
  const f = await fixture();
  assert.equal((await listProjects(f)).length, 3);
  await assert.rejects(access(f.databaseFile), (error) => error.code === 'ENOENT');
  const store = new QueueStore(f.databaseFile);
  const job = store.create(f.configs[0], ['1'], 'recommend-only');
  store.update(job.id, '1', 'processing', {});
  store.update(job.id, '1', 'recommended', {});
  const waiting = store.create(f.configs[1], ['1', '2'], 'auto-vote');
  store.update(waiting.id, '1', 'processing', {});
  store.update(waiting.id, '1', 'error', { error: 'Synthetic problem' });
  store.close();
  const list = await listProjects(f);
  assert.equal(list.find((p) => p.name === 'Project 111').unfinished, 0);
  assert.equal(list.find((p) => p.name === 'Project 222').unfinished, 2);
  assert.equal(list.find((p) => p.name === 'Project 222').attention, 1);
  for (const config of f.configs)
    assert.equal((await loadProject(config.reviewUrl, f)).configHash, config.configHash);
  await writeFile(
    path.join(projectLocation(f.configs[2].reviewUrl, f.root), 'Project settings.json'),
    '{broken',
  );
  assert.ok((await listProjects(f)).find((p) => p.reviewUrl === f.configs[2].reviewUrl).error);
});

test('main and project menus dispatch every action to the chosen project, retaining context after errors', async () => {
  const f = await fixture(),
    projects = await listProjects(f);
  const { question } = answers([
    '2',
    'n',
    '2',
    '3',
    '',
    '4',
    '5',
    '6',
    '2',
    '1',
    '0',
    '1',
    '0',
    '0',
  ]);
  const calls = [],
    screens = [];
  const selected = projects[1];
  await runMainMenu(
    question,
    {
      list: async () => projects,
      create: async () => projects[0],
      export: async (p) => {
        calls.push(['export', p.reviewUrl]);
        throw new Error('Workbook is open');
      },
      open: async (p) => calls.push(['open', p.reviewUrl]),
      backup: async (p) => calls.push(['backup', p.reviewUrl]),
      unfinished: async (p) => calls.push(['unfinished', p.reviewUrl]),
      settings: async (p) => {
        calls.push(['settings', p.reviewUrl]);
        return { ...p, name: 'Renamed' };
      },
      start: async (p) => calls.push(['start', p.reviewUrl]),
    },
    { show: (title, lines) => screens.push([title, lines]) },
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ['export', 'open', 'backup', 'unfinished', 'settings', 'start'],
  );
  assert.ok(calls.every(([, url]) => url === selected.reviewUrl));
  assert.ok(screens.some(([title]) => title.includes('Renamed')));
  assert.deepEqual(screens[0][1], [
    '1. Start a new screening',
    '2. Continue a saved screening',
    '3. Clean temporary files',
    '0. Exit',
  ]);
  const projectScreen = screens.find(
    ([title, lines]) =>
      title.includes(selected.name) && lines.includes('1. Start / continue screening'),
  );
  assert.deepEqual(projectScreen[1], [
    `Review ${selected.reviewUrl.match(/\/reviews\/(\d+)/)[1]} | ${new URL(selected.reviewUrl).hostname}`,
    '',
    '1. Start / continue screening',
    '2. Edit project settings',
    '3. Export project history',
    '4. Open project folder',
    '5. Back up project records',
    '6. Review unfinished studies',
    '0. Back to main menu',
  ]);
});

test('project selection paginates and returning without choosing starts nothing', async () => {
  const f = await fixture(),
    list = await listProjects(f);
  assert.equal(
    await chooseProject(answers(['n', '3']).question, list, { show: () => {}, pageSize: 2 }),
    list[2],
  );
  assert.equal(await chooseProject(answers(['0']).question, list, { show: () => {} }), null);
});

test('screening counts use first saved decisions, local days and review identity across retries and restarts', async () => {
  const f = await fixture();
  const now = new Date(2026, 8, 15, 12);
  const yesterday = new Date(2026, 8, 14, 23, 59).toISOString();
  const today = new Date(2026, 8, 15, 0, 1).toISOString();
  const tomorrow = new Date(2026, 8, 16, 0, 1).toISOString();
  assert.ok((await listProjects(f)).every((p) => p.screened.total === 0));
  const queue = new QueueStore(f.databaseFile);
  const job = queue.create(f.configs[0], ['1', '2', '3', '4'], 'auto-vote');
  queue.update(job.id, '2', 'skipped', {});
  queue.update(job.id, '3', 'error', {});
  queue.close();
  withRecords(f.databaseFile, (store) => {
    const save = (runId, studyId, updatedAt, extra = {}) =>
      store.saveRecommendation({
        record: {
          runId,
          studyId,
          dataset: 'fixture',
          configHash: runId,
          reviewUrl: f.configs[0].reviewUrl,
          status: 'recommended',
          createdAt: yesterday,
          updatedAt,
          ...extra,
        },
      });
    save('old', '1', yesterday);
    save('retry', '1', today, { reviewUrl: 'https://app.covidence.org/reviews/111' });
    save('new', '5', today);
    save('reparsed', '6', yesterday, { reprocessedAt: today });
    save('failed', '7', today, { status: 'error' });
    save('waiting', '8', today, { status: 'response_saved' });
    save('undated', '9', null, { createdAt: null });
    save('other-review', '1', today, { reviewUrl: f.configs[1].reviewUrl });
    save('other-host', '1', today, { reviewUrl: 'https://demo.covidence.org/reviews/111' });
    save('future', '10', tomorrow);
    for (const [attemptId, studyId, status, clickedAt] of [
      ['v1', '1', 'confirmed', today],
      ['v2', '11', 'confirmed', yesterday],
      ['v3', '12', 'uncertain', today],
      ['v4', '13', 'cancelled', today],
      ['v5', '14', 'mismatch', today],
    ])
      store.saveVote({
        attemptId,
        studyId,
        reviewUrl: f.configs[0].reviewUrl,
        status,
        clickedAt,
        updatedAt: today,
      });
    store.projectEvent('clear', f.configs[0].reviewUrl, 'batch_cleared', { jobId: job.id });
  });
  const before = await readFile(f.databaseFile);
  const readCounts = async (date) =>
    (await listProjects({ ...f, now: date })).find((p) => p.name === 'Project 111').screened;
  assert.deepEqual(await readCounts(now), { today: 2, total: 6 });
  assert.deepEqual(await readCounts(now), { today: 2, total: 6 });
  assert.deepEqual(await readCounts(new Date(2026, 8, 14, 12)), { today: 2, total: 6 });
  assert.deepEqual(await readCounts(new Date(2026, 8, 16, 12)), { today: 1, total: 6 });
  const projects = await listProjects({ ...f, now });
  for (const project of projects)
    assert.equal(
      project.historyTotal,
      readProjectHistory(f.databaseFile, project.reviewUrl).rows.length - 1,
      'History total includes every exported study regardless of queue or vote state',
    );
  assert.deepEqual(projects.find((p) => p.name === 'Project 222').screened, { today: 1, total: 1 });
  assert.deepEqual(projects.find((p) => p.name === 'Project 333').screened, { today: 0, total: 0 });
  assert.deepEqual(
    await readFile(f.databaseFile),
    before,
    'Counting must not write to the database',
  );
});

test('saved-screening screen shows counts only under each project and keeps controls visible', async () => {
  const f = await fixture();
  const projects = (await listProjects(f)).map((p) => ({
    ...p,
    screened: { today: 2, total: 10 },
    historyTotal: 13,
    localScreened: { today: 1, total: 4 },
    unassignedScreened: 3,
    submittedToday: 1,
    screenedNotSubmitted: 5,
  }));
  const screens = [];
  await chooseProject(answers(['n', '0']).question, projects, {
    pageSize: 2,
    remove: () => assert.fail('Displaying counts must not delete'),
    show: (title, lines) => screens.push(screenText(title, lines, '', 80, 30)),
  });
  for (const screen of screens) {
    assert.doesNotMatch(
      screen,
      /Studies screened \| Today:|Across saved projects|Counts saved decisions/,
    );
    assert.match(screen, /AI decision submitted today: 1/);
    assert.match(screen, /Screened but not submitted: 5/);
    assert.doesNotMatch(
      screen,
      /Decision history \| Total:|This laptop today:|\d+ unfinished|batches to resume/,
    );
    assert.doesNotMatch(screen, /This laptop \||Older records without a laptop/);
    assert.match(screen, /n = next page; p = previous page/);
    assert.match(screen, /D\. Delete a saved project/);
    assert.match(screen, /0\. Back to main menu/);
    assert.doesNotMatch(screen, /Full details are saved/);
  }
});

test('history total follows merged exports across devices, repeated imports and later screenings', async () => {
  const f = await fixture();
  const now = new Date(2026, 8, 24, 12);
  const today = now.toISOString();
  const queue = new QueueStore(f.databaseFile);
  queue.create(f.configs[0], ['1'], 'recommend-only');
  queue.close();
  const key = reviewKey(f.configs[0].reviewUrl);
  const rows = [
    ['1', 'Overlapping study', 'Include', 'Source wording'],
    ['2', 'Mac-only study', 'Maybe', 'Unclear'],
  ];
  withRecords(f.databaseFile, (store) => {
    for (const eventId of ['mac-import', 'repeated-import'])
      store.projectEvent(eventId, key, 'history_workbook_imported', { rows }, today);
    store.projectEvent(
      'another-review',
      reviewKey(f.configs[1].reviewUrl),
      'history_workbook_imported',
      {
        rows: [['3', 'Other review', 'Exclude', 'Different review']],
      },
    );
    store.projectEvent('another-host', key.replace('app.', 'demo.'), 'history_workbook_imported', {
      rows: [['4', 'Other host', 'Exclude', 'Different host']],
    });
    store.saveRecommendation({
      record: {
        runId: 'mac-recommendation',
        studyId: '5',
        reviewUrl: key,
        dataset: 'fixture',
        configHash: 'fixture',
        status: 'recommended',
        decision: 'Include',
        createdAt: today,
        deviceId: 'another-device',
      },
    });
    store.db
      .prepare('INSERT INTO vote_claims VALUES (?,?)')
      .run('app.covidence.org-111-6', 'retained-claim');
  });
  const check = async (total) => {
    const projects = await listProjects({ ...f, now, deviceId: 'this-device' });
    const project = projects.find((p) => reviewKey(p.reviewUrl) === key);
    assert.equal(project.historyTotal, total);
    assert.equal(project.historyTotal, readProjectHistory(f.databaseFile, key).rows.length - 1);
    assert.equal(
      project.screened.today,
      1,
      'Undated workbook imports do not become screenings today',
    );
    assert.equal(
      project.localScreened.total,
      0,
      'Device attribution does not filter the history total',
    );
    assert.equal(projects.find((p) => p.name === 'Project 222').historyTotal, 1);
  };
  await check(4);
  withRecords(f.databaseFile, (store) =>
    store.projectEvent(
      'next-import',
      key,
      'history_workbook_imported',
      {
        rows: [...rows, ['7', 'Next Mac study', 'Exclude', 'Additional source']],
      },
      today,
    ),
  );
  await check(5);
  withRecords(f.databaseFile, (store) =>
    store.saveRecommendation({
      record: {
        runId: 'later-local-record',
        studyId: '2',
        reviewUrl: key,
        dataset: 'fixture',
        configHash: 'fixture',
        status: 'recommended',
        decision: 'Maybe',
        createdAt: new Date(2026, 8, 23, 12).toISOString(),
        deviceId: 'another-device',
      },
    }),
  );
  await check(5);
});

test('deleting from the selector requires explicit confirmation and refreshes the list', async () => {
  const f = await fixture();
  let projects = await listProjects(f);
  const removed = projects[1],
    remaining = projects[0],
    calls = [],
    screens = [];
  const selected = await chooseProject(
    answers(['d', '0', 'd', '2', 'delete', 'd', '2', 'DELETE', '', '1']).question,
    projects,
    {
      pageSize: 2,
      show: (title, lines) => screens.push([title, lines]),
      remove: async (project) => {
        calls.push(project);
        projects = projects.filter((p) => p !== project);
      },
      reload: async () => projects,
    },
  );
  assert.deepEqual(calls, [removed]);
  assert.equal(selected, remaining);
  assert.ok(screens.some(([, lines]) => lines.includes('D. Delete a saved project')));
  const confirmation = screens.find(([title]) => title.endsWith('Delete this local project?'))[1];
  assert.ok(confirmation.includes(removed.name));
  assert.ok(
    confirmation.some((line) =>
      line.includes('online Covidence review and its votes are unchanged'),
    ),
  );
});

test('deleting the final project on a page returns to a valid page', async () => {
  const f = await fixture();
  let projects = await listProjects(f);
  const remaining = projects[1],
    last = projects[2];
  const selected = await chooseProject(
    answers(['n', 'd', '3', 'DELETE', '', '2']).question,
    projects,
    {
      show: () => {},
      pageSize: 2,
      remove: async (project) => {
        assert.equal(project, last);
        projects = projects.filter((p) => p !== project);
      },
      reload: async () => projects,
    },
  );
  assert.equal(selected, remaining);
});

test('a deletion error stays on the saved-project selector and does not start screening', async () => {
  const f = await fixture(),
    projects = await listProjects(f);
  const input = answers(['2', 'd', '1', 'DELETE', '', '0', '0']);
  await runMainMenu(
    input.question,
    {
      list: async () => projects,
      delete: async (project) => {
        assert.equal(project, projects[0]);
        throw new Error('Folder is in use');
      },
      start: () => assert.fail('Deletion must never start screening'),
    },
    { show: () => {} },
  );
  assert.ok(input.prompts.some((p) => p.includes('Could not delete project: Folder is in use')));
});

test('selected-project settings retain the review address and return saved values', async () => {
  const f = await fixture(),
    project = await readProject(f.configs[0].reviewUrl, f);
  const before = await readFile(
    path.join(projectLocation(f.configs[1].reviewUrl, f.root), 'Project settings.json'),
    'utf8',
  );
  let saved;
  const input = answers(['1', 'Renamed project', '7']);
  const result = await projectSettings(input.question, {
    readCurrent: async () => project.settings,
    save: async (settings) => {
      saved = settings;
    },
    show: () => {},
    lockedReview: project.reviewUrl,
  });
  assert.equal(saved.reviewUrl, project.reviewUrl);
  assert.equal(result.saved, true);
  assert.equal(saved.projectName, 'Renamed project');
  assert.ok(input.prompts.every((prompt) => !/reviewer|full name/i.test(prompt)));
  assert.equal(
    await readFile(
      path.join(projectLocation(f.configs[1].reviewUrl, f.root), 'Project settings.json'),
      'utf8',
    ),
    before,
  );
  await assert.rejects(
    projectSettings(async () => assert.fail('Must reject before prompting'), {
      readCurrent: async () => project.settings,
      lockedReview: f.configs[1].reviewUrl,
    }),
    /selected project/,
  );
});

test('pending work uses each saved mode and honors old clear/restore records within the selected review', async () => {
  const f = await fixture(),
    store = new QueueStore(f.databaseFile),
    c = f.configs[0];
  const own = store.create(c, ['1'], 'recommend-only');
  store.create(f.configs[1], ['1'], 'recommend-only');
  const renamed = store.create({ ...c, reviewerName: 'Another reviewer' }, ['2'], 'recommend-only');
  const voting = store.create(c, ['3'], 'auto-vote');
  const hidden = store.create(c, ['4'], 'recommend-only');
  const restored = store.create(c, ['5'], 'confirm-each-vote');
  const done = store.create(c, ['6'], 'recommend-only');
  store.update(done.id, '6', 'recommended', {});
  withRecords(f.databaseFile, (records) => {
    records.projectEvent('clear-hidden', c.reviewUrl, 'batch_cleared', { jobId: hidden.id });
    records.projectEvent('clear-restored', c.reviewUrl, 'batch_cleared', { jobId: restored.id });
    records.projectEvent('restore', c.reviewUrl, 'batch_restored', { jobId: restored.id });
  });
  assert.deepEqual(
    pendingScreenings(store, c).map((w) => w.job.id),
    [own.id, renamed.id, voting.id, restored.id],
  );
  store.close();
});

test('continuing lets a saved headless screening run visibly and respects a user interruption', async () => {
  const f = await fixture(),
    c = f.configs[0],
    store = new QueueStore(f.databaseFile);
  const first = store.create({ ...c, headless: true }, ['1'], 'recommend-only');
  store.create(c, ['2'], 'recommend-only');
  store.db.prepare('UPDATE items SET updated_at=? WHERE job_id=?').run('2099-01-01', first.id);
  store.close();
  const runs = [];
  await startScreening({ name: 'Chosen', reviewUrl: c.reviewUrl }, answers(['']).question, {
    databaseFile: f.databaseFile,
    load: async () => c,
    chooseBrowserMode: async () => 'visible',
    show: () => {},
    discover: async () => assert.fail('Must resume existing work'),
    run: async (script, args) => {
      runs.push(args);
      return 130;
    },
  });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [
    'resume',
    '--job',
    first.id,
    '--browser',
    'visible',
    '--mode',
    'review-all',
  ]);
});

test('project screening discovers with the selected settings and creates work only after confirmation', async () => {
  const f = await fixture(),
    c = f.configs[1];
  const runs = [];
  const options = {
    databaseFile: f.databaseFile,
    load: async (url) => {
      assert.equal(url, c.reviewUrl);
      return c;
    },
    chooseBrowserMode: async () => 'headless',
    show: () => {},
    discover: async (q, log, { config }) => {
      assert.equal(config, c);
      return { result: { studies: [{ studyId: '9' }] } };
    },
    run: async (script, args) => {
      runs.push(args);
      return 0;
    },
  };
  const project = { name: c.projectName, reviewUrl: c.reviewUrl };
  await startScreening(project, answers(['n']).question, options);
  assert.equal(runs.length, 0);
  await startScreening(project, answers(['y', '']).question, options);
  assert.equal(runs.length, 1);
  const store = new QueueStore(f.databaseFile);
  const jobs = store.db.prepare('SELECT * FROM jobs').all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].review_url, c.reviewUrl);
  assert.equal(store.settings(jobs[0].id).configHash, c.configHash);
  assert.equal(store.settings(jobs[0].id).headless, true);
  store.close();
});

test('menu-saved criteria reach the next screening request despite older unfinished work and reference text', async () => {
  const f = await fixture(),
    c = f.configs[0],
    store = new QueueStore(f.databaseFile);
  const job = store.create(c, ['1'], 'auto-vote');
  store.update(job.id, '1', 'recommended', { recommendationId: 'old-response' });
  const before = {
    job: store.job(job.id),
    settings: store.settings(job.id),
    items: store.items(job.id),
  };
  store.close();
  const folder = projectLocation(c.reviewUrl, f.root);
  const reference = path.join(folder, 'Screening criteria.txt');
  await writeFile(reference, 'Obsolete reference text must not control screening.');
  const sections = {
    inclusion: 'Yes requires an explicit treatment-outcome link. Unclear means Maybe.',
    exclusion: 'Observational studies and prevention-only studies: No.',
    responseFormat: 'Keep all six fields. Write a short, natural Rationale.',
  };
  await projectSettings(answers(['3', '4', '5', '7']).question, {
    readCurrent: async () => (await readProject(c.reviewUrl, f)).settings,
    edit: async (_question, key) => sections[key],
    save: (draft) =>
      saveSettings(draft, {
        file: path.join(folder, 'Project settings.json'),
        baseDir: path.dirname(f.databaseFile),
        loadCurrent: async () => c,
      }),
    show: () => {},
    lockedReview: c.reviewUrl,
  });
  const current = await loadProject(c.reviewUrl, f);
  assert.deepEqual(current.promptSections, sections);
  assert.notEqual(current.configHash, c.configHash);
  const screens = [];
  const runs = [];
  const options = {
    databaseFile: f.databaseFile,
    load: (url) => loadProject(url, f),
    chooseBrowserMode: async () => 'headless',
    show: (title, lines) => screens.push(lines.join('\n')),
    discover: async (_question, _log, { config }) => {
      assert.equal(config.configHash, current.configHash);
      return { result: { studies: [{ studyId: '1' }] } };
    },
    run: async (script, args) => {
      runs.push(args);
      const queue = new QueueStore(f.databaseFile);
      try {
        assert.notEqual(args[2], job.id);
        assert.equal(queue.job(args[2]).mode, 'review-all');
        const config = queue.settings(args[2]);
        assert.equal(config.configHash, current.configHash);
        const request = buildRequest(config, {
          studyId: '1',
          title: 'Synthetic study',
          abstract: 'Synthetic abstract',
        });
        assert.equal(request.instructions, buildPrompt(sections));
      } finally {
        queue.close();
      }
      return 0;
    },
  };
  const project = { name: c.projectName, reviewUrl: c.reviewUrl };
  await startScreening(project, answers(['n']).question, options);
  assert.equal(runs.length, 0);
  await startScreening(project, answers(['y', '']).question, options);
  assert.equal(runs.length, 1);
  assert.equal(
    screens.length,
    2,
    'Only each post-discovery start summary is shown; no introductory page',
  );
  const after = new QueueStore(f.databaseFile);
  try {
    assert.deepEqual(
      { job: after.job(job.id), settings: after.settings(job.id), items: after.items(job.id) },
      before,
    );
    assert.equal(after.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 2);
    assert.equal(
      await readFile(reference, 'utf8'),
      'Obsolete reference text must not control screening.',
    );
  } finally {
    after.close();
  }
});

test('cancelling the browser choice leaves a saved screening untouched and starts no worker', async () => {
  const f = await fixture(),
    c = f.configs[0],
    store = new QueueStore(f.databaseFile);
  const job = store.create(c, ['105', '122'], 'auto-vote');
  store.update(job.id, '105', 'completed', { voteRecord: { status: 'confirmed' } });
  const before = {
    job: store.job(job.id),
    settings: store.settings(job.id),
    items: store.items(job.id),
  };
  store.close();
  let choices = 0;
  await startScreening(
    { name: c.projectName, reviewUrl: c.reviewUrl },
    async () => assert.fail('No follow-up question after cancellation'),
    {
      databaseFile: f.databaseFile,
      chooseBrowserMode: async () => {
        choices++;
        return null;
      },
      load: async () => c,
      discover: async () => assert.fail('Do not discover studies'),
      run: async () => assert.fail('Do not open a browser or run a worker'),
      show: () => {},
    },
  );
  const after = new QueueStore(f.databaseFile);
  try {
    assert.equal(choices, 1);
    assert.deepEqual(
      { job: after.job(job.id), settings: after.settings(job.id), items: after.items(job.id) },
      before,
    );
  } finally {
    after.close();
  }
});

test('continuation stops if current settings cannot load or change during browser selection', async () => {
  const f = await fixture(),
    c = f.configs[0],
    store = new QueueStore(f.databaseFile);
  const job = store.create(c, ['1'], 'auto-vote');
  const before = store.items(job.id);
  store.close();
  const project = { name: c.projectName, reviewUrl: c.reviewUrl };
  const options = {
    databaseFile: f.databaseFile,
    show: () => {},
    run: async () => assert.fail('Must not run with outdated settings'),
    discover: async () => assert.fail('Must not discover'),
  };
  const question = async () => assert.fail('Must stop before prompting');
  await assert.rejects(
    startScreening(project, question, {
      ...options,
      load: async () => {
        throw new Error('Current settings are invalid');
      },
      chooseBrowserMode: async () => assert.fail('Must validate settings first'),
    }),
    /Current settings are invalid/,
  );
  let current = c;
  await assert.rejects(
    startScreening(project, question, {
      ...options,
      load: async () => current,
      chooseBrowserMode: async () => {
        current = { ...c, configHash: 'changed-while-choosing' };
        return 'headless';
      },
    }),
    /Project settings changed before continuation/,
  );
  const after = new QueueStore(f.databaseFile);
  try {
    assert.deepEqual(after.items(job.id), before);
    assert.deepEqual(after.settings(job.id), c);
  } finally {
    after.close();
  }
});

test('one browser choice applies to every resumed group without changing saved browser preferences', async () => {
  const f = await fixture(),
    c = f.configs[0],
    store = new QueueStore(f.databaseFile);
  const first = store.create({ ...c, headless: false }, ['1'], 'recommend-only');
  const second = store.create({ ...c, headless: true }, ['2'], 'recommend-only');
  store.close();
  let choices = 0;
  const runs = [],
    reviews = [];
  await startScreening({ name: c.projectName, reviewUrl: c.reviewUrl }, answers([]).question, {
    databaseFile: f.databaseFile,
    chooseBrowserMode: async () => {
      choices++;
      return 'headless';
    },
    load: async () => c,
    discover: async () => assert.fail('Use the existing studies'),
    show: () => {},
    reviewBatch: async (ids) => {
      assert.equal(runs.length, 2, 'Finish all resumed groups before opening review');
      reviews.push(ids);
      return true;
    },
    run: async (_script, args) => {
      runs.push(args);
      const records = new QueueStore(f.databaseFile);
      try {
        for (const item of records.items(args[2]))
          records.update(args[2], item.study_id, 'recommended', {});
      } finally {
        records.close();
      }
      return 0;
    },
  });
  assert.equal(choices, 1);
  assert.equal(runs.length, 2);
  assert.deepEqual(reviews, [runs.map((args) => args[2])]);
  assert.ok(runs.every((args) => args[3] === '--browser' && args[4] === 'headless'));
  const after = new QueueStore(f.databaseFile);
  try {
    assert.equal(after.settings(first.id).headless, false);
    assert.equal(after.settings(second.id).headless, true);
    assert.equal(after.settings(first.id).configHash, c.configHash);
  } finally {
    after.close();
  }
});

test('continuation keeps different saved voting modes separate, including legacy per-vote confirmation', async () => {
  for (const mode of ['recommend-only', 'auto-vote', 'confirm-each-vote']) {
    const f = await fixture(),
      c = f.configs[0],
      store = new QueueStore(f.databaseFile);
    for (const other of ['recommend-only', 'auto-vote', 'confirm-each-vote'])
      if (other !== mode) store.create(c, ['1'], other);
    store.create(f.configs[1], ['1'], mode);
    const outdated = store.create({ ...c, configHash: 'different-settings' }, ['2'], mode);
    const selected = store.create(c, ['3'], mode);
    store.db.prepare('UPDATE items SET updated_at=? WHERE job_id=?').run('2098-01-01', selected.id);
    store.db.prepare('UPDATE items SET updated_at=? WHERE job_id=?').run('2099-01-01', outdated.id);
    store.close();
    const runs = [];
    await startScreening({ name: 'Chosen', reviewUrl: c.reviewUrl }, answers(['']).question, {
      databaseFile: f.databaseFile,
      load: async () => c,
      chooseBrowserMode: async () => 'headless',
      discover: async () => assert.fail('Must not discover'),
      show: () => {},
      run: async (script, args) => {
        runs.push(args);
        const records = new QueueStore(f.databaseFile);
        try {
          records.update(selected.id, '3', 'completed', {});
        } finally {
          records.close();
        }
        return 0;
      },
    });
    assert.deepEqual(runs, [
      ['resume', '--job', selected.id, '--browser', 'headless', '--mode', 'review-all'],
    ]);
  }
});

test('continuing a legacy voting batch prepares remaining studies across a pause without voting', async () => {
  const f = await fixture(),
    c = f.configs[0],
    store = new QueueStore(f.databaseFile);
  const job = store.create(c, ['105', '127', '122', '90', '66'], 'auto-vote');
  store.update(job.id, '105', 'completed', { voteRecord: { status: 'confirmed' } });
  store.close();
  const extracted = [],
    requests = [],
    votes = [],
    starts = [];
  let pause = true;
  const browserChoices = ['headless', 'visible'];
  const selectedBrowsers = [];
  const study = (id) => ({
    ready: true,
    studyId: id,
    title: `Study ${id}`,
    abstract: 'Synthetic study.',
  });
  const result = (id) => ({
    parsed: { Decision: 'Include', ResponseText: 'Decision: Include' },
    record: { status: 'recommended', decision: 'Include', studyHash: studyHash(study(id)) },
  });
  const options = {
    databaseFile: f.databaseFile,
    load: async () => c,
    chooseBrowserMode: async () => {
      const mode = browserChoices.shift();
      selectedBrowsers.push(mode);
      return mode;
    },
    discover: async () => assert.fail('Must not discover'),
    show: (title, lines) => {
      starts.push(lines.find((line) => line.startsWith('Resuming at')));
    },
    run: async (script, args) => {
      assert.deepEqual(args.slice(0, 5), [
        'resume',
        '--job',
        job.id,
        '--browser',
        selectedBrowsers.at(-1),
      ]);
      const records = new QueueStore(f.databaseFile);
      try {
        records.enableBatchReview(job.id);
        await runQueue({
          store: records,
          job: records.job(job.id),
          config: records.settings(job.id),
          shouldStop: () => pause && extracted.length === 1,
          log: () => {},
          operations: {
            existingVote: async () => null,
            extract: async (id) => {
              extracted.push(id);
              return study(id);
            },
            cached: async (id) => (id === '127' ? result(id) : null),
            recommend: async (id) => {
              requests.push(id);
              return result(id);
            },
            vote: async (id) => {
              votes.push(id);
              return { record: { status: 'confirmed' } };
            },
          },
        });
      } finally {
        records.close();
      }
      return pause ? 130 : 0;
    },
  };
  const project = { name: 'Synthetic demo', reviewUrl: c.reviewUrl };
  await startScreening(project, answers(['']).question, options);
  assert.deepEqual(votes, []);
  pause = false;
  await startScreening(project, answers(['']).question, options);
  assert.deepEqual(starts, ['Resuming at study #127.', 'Resuming at study #127.']);
  assert.deepEqual(extracted, ['127', '122', '90', '66']);
  assert.deepEqual(requests, ['122', '90', '66']);
  assert.deepEqual(votes, []);
  assert.deepEqual(selectedBrowsers, ['headless', 'visible']);
  const after = new QueueStore(f.databaseFile);
  try {
    assert.deepEqual(after.counts(job.id), { completed: 1, recommended: 4 });
  } finally {
    after.close();
  }
});

test('new-project setup saves all three prompt sections and reopening the same review creates no duplicate', async () => {
  const f = await fixture(),
    previous = f.configs[0];
  const settingsFile = path.join(
    projectLocation(previous.reviewUrl, f.root),
    'Project settings.json',
  );
  const before = await readFile(settingsFile, 'utf8');
  const options = {
    show: () => {},
    read: (url) => readProject(url, f),
    readPrevious: async () => previous,
    prepare: (current, url) =>
      reviewDraft(current, url, { projectLocation: (address) => projectLocation(address, f.root) }),
    configure: (question, options) =>
      projectSettings(question, {
        ...options,
        show: () => {},
        edit: async (q, key) =>
          ({
            inclusion: 'Exact inclusion text.',
            exclusion: 'Exact exclusion text.',
            responseFormat: 'Decision: Include / Exclude / Maybe\nRationale: explanation',
          })[key],
        save: (draft) =>
          saveSettings(draft, {
            baseDir: path.dirname(f.databaseFile),
            loadCurrent: async () => previous,
            projectRoot: f.root,
            projectLocation: (address) => projectLocation(address, f.root),
            indexFile: path.join(f.root, 'projects.json'),
          }),
      }),
  };
  const project = await createProject(
    answers(['https://app.covidence.org/reviews/444', 'New project', '3', '4', '5', '7']).question,
    options,
  );
  assert.equal(project.name, 'New project');
  assert.equal(project.settings.promptSections.inclusion, 'Exact inclusion text.');
  assert.equal(project.settings.promptSections.exclusion, 'Exact exclusion text.');
  assert.equal(project.settings.openai.model, previous.openai.model);
  assert.equal((await listProjects(f)).length, 4);
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  assert.equal(
    (await createProject(answers([project.reviewUrl]).question, options)).reviewUrl,
    project.reviewUrl,
  );
  assert.equal((await listProjects(f)).length, 4);
  assert.equal(
    await createProject(
      answers(['https://app.covidence.org/reviews/555', 'Cancelled project', '0']).question,
      options,
    ),
    null,
  );
  await assert.rejects(
    readProject('https://app.covidence.org/reviews/555', f),
    (error) => error.code === 'ENOENT',
  );
});

test('unfinished work with missing settings cannot be silently abandoned for a new request', async () => {
  const f = await fixture(),
    store = new QueueStore(f.databaseFile);
  try {
    const job = store.create(f.configs[0], ['1'], 'recommend-only');
    store.db.prepare('DELETE FROM job_settings WHERE job_id=?').run(job.id);
    assert.throws(() => pendingScreenings(store, f.configs[0]), /settings are missing/);
  } finally {
    store.close();
  }
});
