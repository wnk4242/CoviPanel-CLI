import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { loadProfile } from './fixtures.js';
import { studyHash } from '../Application/profiles.js';
import { readApprovalBatch, saveBatchWithoutSubmitting } from '../Application/batch-approval.js';
import { submissionCounts, reconcileSavedDecisions } from '../Application/saved-decisions.js';
import { readProjectHistory } from '../Application/project-history.js';
import { listProjects, projectLocation } from '../Application/projects.js';
import { syncCovidenceProgress } from '../Application/covidence-progress.js';

async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-saved-counts-'));
  const file = path.join(folder, 'screening.sqlite'),
    config = await loadProfile('demo', '1');
  const store = new QueueStore(file),
    job = store.create(config, ['1', '2', '3'], 'review-all');
  for (const id of ['1', '2', '3']) {
    const study = { studyId: id, title: 'Study ' + id, abstract: 'Synthetic abstract.' };
    const record = {
      runId: 'run-' + id,
      reviewUrl: config.reviewUrl,
      configHash: config.configHash,
      dataset: config.dataset,
      studyId: id,
      title: study.title,
      studyHash: studyHash(study),
      status: 'recommended',
      decision: 'Include',
      rationale: 'Original rationale.',
      deviceId: 'laptop',
      createdAt: new Date().toISOString(),
    };
    withRecords(file, (s) =>
      s.saveRecommendation({
        record,
        study,
        parsed: { Decision: 'Include', Rationale: record.rationale },
      }),
    );
    store.update(job.id, id, 'recommended', { recommendationRecord: record });
  }
  const snapshot = readApprovalBatch(file, [job.id]);
  saveBatchWithoutSubmitting(file, [job.id], snapshot.fingerprint, config);
  return { folder, file, config, store, job };
}
const evidence = (config, id, outcome = 'voted') => ({
  outcome,
  reviewUrl: config.reviewUrl,
  studyId: id,
  title: 'Study ' + id,
  reviewerIdentity: { name: 'Fixture' },
  recordedVote: outcome === 'voted' ? 'No' : undefined,
  checkedAt: new Date().toISOString(),
  url: config.reviewUrl,
  historyRows: outcome === 'voted' ? ['No vote\nby Fixture'] : [],
});

test('manual votes reduce unique pending counts, preserve AI decisions, and never acquire today/device attribution', async () => {
  const f = await fixture();
  try {
    const count = () => submissionCounts(f.store.db, f.config.reviewUrl, { deviceId: 'laptop' });
    assert.deepEqual(count(), { submittedToday: 0, screenedNotSubmitted: 3 });
    const before = f.store.db.prepare('SELECT * FROM recommendations').all(),
      rows = readProjectHistory(f.file, f.config.reviewUrl).rows;
    const result = await reconcileSavedDecisions(f.store.db, {}, f.config.reviewUrl, {
      reviewer: 'Fixture',
      verify: async (_page, config) =>
        evidence(
          config,
          config.studyId,
          config.studyId === '1' ? 'voted' : config.studyId === '2' ? 'not_voted' : 'uncertain',
        ),
    });
    assert.deepEqual(result, { checked: 3, voted: 1, uncertain: 1 });
    assert.deepEqual(count(), { submittedToday: 0, screenedNotSubmitted: 2 });
    assert.deepEqual(f.store.db.prepare('SELECT * FROM recommendations').all(), before);
    assert.deepEqual(readProjectHistory(f.file, f.config.reviewUrl).rows, rows);
    assert.match(readProjectHistory(f.file, f.config.reviewUrl).log, /manual vote No verified/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM votes').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM vote_claims').get().n, 0);
    assert.equal(f.store.item(f.job.id, '1').data.savedVoteCheck.clickedAt, undefined);
    const second = await reconcileSavedDecisions(f.store.db, {}, f.config.reviewUrl, {
      reviewer: 'Fixture',
      verify: async (_page, config) => {
        assert.notEqual(config.studyId, '1');
        return evidence(config, config.studyId);
      },
    });
    assert.equal(second.voted, 2);
    assert.deepEqual(count(), { submittedToday: 0, screenedNotSubmitted: 0 });
    assert.equal(
      (
        await reconcileSavedDecisions(f.store.db, {}, f.config.reviewUrl, {
          verify: () => assert.fail('Already reconciled'),
        })
      ).checked,
      0,
    );
    const root = path.join(f.folder, 'Projects'),
      folder = projectLocation(f.config.reviewUrl, root);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(f.config));
    const project = (await listProjects({ databaseFile: f.file, root, deviceId: 'laptop' }))[0];
    assert.equal(project.submittedToday, 0);
    assert.equal(project.screenedNotSubmitted, 0);
    assert.equal(project.unfinished, 0);
    assert.equal(project.historyTotal, 3);
  } finally {
    f.store.close();
  }
});

test('offline, wrong-study, stale and wrong-account checks retain all saved-only counts', async () => {
  for (const kind of ['offline', 'study', 'account', 'time', 'url']) {
    const f = await fixture();
    try {
      const result = await reconcileSavedDecisions(f.store.db, {}, f.config.reviewUrl, {
        reviewer: 'Fixture',
        verify: async (_page, config) => {
          if (kind === 'offline') throw new Error('Offline');
          const r = evidence(config, config.studyId);
          if (kind === 'study') r.studyId = '999';
          if (kind === 'account') r.reviewerIdentity.name = 'Other';
          if (kind === 'time') r.checkedAt = '2020-01-01T00:00:00Z';
          if (kind === 'url') r.url = 'https://example.com/reviews/999';
          return r;
        },
      });
      assert.equal(result.uncertain, 3);
      assert.deepEqual(submissionCounts(f.store.db, f.config.reviewUrl, { deviceId: 'laptop' }), {
        submittedToday: 0,
        screenedNotSubmitted: 3,
      });
    } finally {
      f.store.close();
    }
  }
});

test('submission today uses confirmed AI click dates on this device; imported/manual/uncertain records do not add today', async () => {
  const f = await fixture();
  try {
    const now = new Date(2026, 9, 9, 12),
      today = new Date(2026, 9, 9, 0, 1).toISOString(),
      yesterday = new Date(2026, 9, 8, 23, 59).toISOString();
    const save = (attemptId, studyId, patch = {}) =>
      withRecords(f.file, (s) =>
        s.saveVote({
          attemptId,
          studyId,
          reviewUrl: f.config.reviewUrl,
          status: 'confirmed',
          recordedVote: 'Yes',
          recommendationRunId: 'run-' + studyId,
          deviceId: 'laptop',
          clickedAt: today,
          ...patch,
        }),
      );
    save('vote-1', '1');
    save('vote-1-copy', '1');
    save('vote-2', '2', { clickedAt: yesterday, updatedAt: today });
    save('manual-3', '3', {
      clickedAt: undefined,
      deviceId: undefined,
      verificationOnly: true,
      updatedAt: today,
    });
    save('uncertain', '4', { status: 'uncertain' });
    save('other-device', '5', { deviceId: 'other' });
    save('test-input', '6', { recommendationRunId: null });
    save('other-review', '7', { reviewUrl: 'https://demo.covidence.org/reviews/999' });
    assert.deepEqual(
      submissionCounts(f.store.db, f.config.reviewUrl, { now, deviceId: 'laptop' }),
      { submittedToday: 1, screenedNotSubmitted: 0 },
    );
    assert.equal(
      submissionCounts(f.store.db, f.config.reviewUrl, { now, deviceId: 'new-laptop' })
        .submittedToday,
      0,
    );
    assert.equal(
      submissionCounts(f.store.db, f.config.reviewUrl, { now, deviceId: 'other' }).submittedToday,
      1,
    );
    assert.equal(
      submissionCounts(f.store.db, f.config.reviewUrl, {
        now: new Date(2026, 9, 8, 12),
        deviceId: 'laptop',
      }).submittedToday,
      1,
    );
  } finally {
    f.store.close();
  }
});

test('refresh counts reads only the summary even with saved-only decisions, retaining local evidence', async (t) => {
  const f = await fixture();
  const { browserLibrary } = await import('../Application/dependencies.js');
  const browser = await browserLibrary().chromium.launch({ headless: true });
  t.after(() => browser.close());
  try {
    const before = f.store.db.prepare('SELECT * FROM items').all();
    const sourceUrl = new URL(f.config.reviewUrl).origin + '/reviews/' + f.config.reviewId;
    const page = await browser.newPage();
    const requests = [];
    let clicks = 0;
    await page.exposeFunction('historyFixture', () => clicks++);
    await page.route('**/*', (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        contentType: 'text/html',
        body: `<button aria-label="Profile menu"><span role="img" aria-label="Fixture"></span></button>
          <button aria-expanded="true" aria-controls="progress">Title and abstract screening</button>
          <div id="progress">You've screened 15 studies so far</div>
          <a href="${f.config.reviewUrl}">Screen references 3</a>
          <button onclick="historyFixture()">History</button>`,
      });
    });
    const project = { reviewUrl: f.config.reviewUrl, folder: f.folder };
    const result = await syncCovidenceProgress([project], {
      databaseFile: f.file,
      browserProfile: f.folder,
      lock: async () => async () => {},
      launch: async () => ({
        pages: () => [page],
        close: async () => {},
      }),
    });
    assert.deepEqual([...result.values()], [{ synced: true }]);
    assert.deepEqual(requests, [sourceUrl]);
    assert.equal(clicks, 0);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM items').all(), before);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM project_events WHERE kind='saved_decision_vote_checked'")
        .get().n,
      0,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM votes').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM vote_claims').get().n, 0);
    assert.deepEqual(submissionCounts(f.store.db, f.config.reviewUrl, { deviceId: 'laptop' }), {
      submittedToday: 0,
      screenedNotSubmitted: 3,
    });
  } finally {
    f.store.close();
  }
});

test('saved-only reconciliation reads real History dialogs on local browser fixtures for Yes, No and Maybe without voting', async (t) => {
  const f = await fixture();
  const { browserLibrary } = await import('../Application/dependencies.js');
  const browser = await browserLibrary().chromium.launch({ headless: true });
  t.after(() => browser.close());
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    let clicks = 0;
    await page.exposeFunction('voteFixture', () => clicks++);
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
      <button aria-label="Profile menu"><span role="img" aria-label="Fixture"></span></button>
      <a href="${f.config.reviewUrl}">Screen references 3</a><input placeholder="Search studies"><main></main>
      <script>
      let id='1';
      function show(){document.querySelector('main').innerHTML='<div data-testclass="study" data-testid="Study #'+id+'"><p>#'+id+'</p><h3>Study '+id+'</h3><button id="history">History</button>'+['Yes','No','Maybe'].map(v=>'<button data-pendo-key="vote-button" onclick="voteFixture()">'+v+'</button>').join('')+'</div>';
      document.querySelector('#history').onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-label','History');d.innerHTML='<h2>History</h2><h3>Study '+id+'</h3><ol><li>'+({1:'Yes',2:'No',3:'Maybe'}[id])+' vote<br>by Fixture<br>1 Oct 2026</li></ol><button>Done</button>';d.querySelector('button').onclick=()=>d.remove();document.body.append(d);};}
      document.querySelector('input').onkeydown=e=>{if(e.key==='Enter'){id=e.target.value.replace('#','');show();}};show();
      </script>`,
      }),
    );
    await page.goto(f.config.reviewUrl);
    const result = await reconcileSavedDecisions(f.store.db, page, f.config.reviewUrl, {
      reviewer: 'Fixture',
    });
    assert.deepEqual(result, { checked: 3, voted: 3, uncertain: 0 });
    assert.equal(clicks, 0);
    assert.deepEqual(
      ['1', '2', '3'].map((id) => f.store.item(f.job.id, id).data.savedVoteCheck.recordedVote),
      ['Yes', 'No', 'Maybe'],
    );
    assert.deepEqual(submissionCounts(f.store.db, f.config.reviewUrl, { deviceId: 'laptop' }), {
      submittedToday: 0,
      screenedNotSubmitted: 0,
    });
    assert.match(readProjectHistory(f.file, f.config.reviewUrl).log, /3 submitted and verified/);
  } finally {
    f.store.close();
  }
});
