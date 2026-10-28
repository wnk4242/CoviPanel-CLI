import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { loadProfile, decisionResponse } from './fixtures.js';
import { validateProfile } from '../Application/profiles.js';
import { editableSettings } from '../Application/prompt-sections.js';
import { QueueStore } from '../Application/queue-store.js';
import { runQueue } from '../Application/queue-runner.js';
import { runBrowserQueue } from '../Application/browser-queue.js';
import { queueOperations } from '../Application/queue-operations.js';
import {
  readApprovalBatch,
  saveBatchEdit,
  confirmBatch,
  cancelBatch,
  saveBatchWithoutSubmitting,
  reviewPendingBatch,
} from '../Application/batch-approval.js';
import { loadRecommendation, reparseRecommendation } from '../Application/recommendation.js';
import { pendingScreenings, listProjects, projectLocation } from '../Application/projects.js';
import { readUnfinished } from '../Application/unfinished-review.js';
import { backupProject, restoreProjectBackup } from '../Application/project-backups.js';
import { awaitingBatchConfirmation } from '../Application/review-decisions.js';
import { withRecords } from '../Application/records.js';
import { readProjectHistory } from '../Application/project-history.js';
import { exportProjectHistory } from '../Application/history-export.js';
import { spreadsheetLibrary } from '../Application/dependencies.js';
import { reviewBatch } from '../Application/batch-review.js';
import { createTerminal } from '../Application/terminal-input.js';
import { startScreening } from '../Application/screening-session.js';

const original = (decision) =>
  `Decision: ${decision}\nPopulation: children\nIntervention: symptoms\nCondition: treatment\nStudyDesign: experiment\nRationale: Original explanation.`;
async function fixture({ real = false } = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-approval-'));
  const file = path.join(folder, 'screening.sqlite');
  const profile = real ? 'standard' : 'demo';
  const settings = editableSettings(await loadProfile('demo', '1'));
  if (real) {
    settings.dataset = 'standard-review';
    settings.reviewUrl =
      'https://app.covidence.org/reviews/900001/review_studies/screen?filter=vote_required_from';
  }
  settings.promptSections = {
    inclusion: 'Synthetic eligibility.',
    exclusion: '',
    responseFormat: 'Six labeled fields.',
  };
  const config = await validateProfile(settings, profile, '1');
  const store = new QueueStore(file);
  const job = store.create(config, ['1', '2', '3'], 'review-all');
  const decisions = { 1: 'Exclude', 2: 'Include', 3: 'Maybe' };
  const calls = { api: [], vote: [], extract: [] };
  const operations = queueOperations({
    config,
    databasePath: file,
    client: {
      responses: {
        create: async (request) => {
          const id = JSON.parse(request.input).study.studyId;
          calls.api.push(id);
          return decisionResponse(decisions[id], original(decisions[id]));
        },
      },
    },
  });
  operations.extract = async (id) => {
    calls.extract.push(id);
    return {
      ready: true,
      studyId: id,
      title: `Study ${id}`,
      abstract: 'Synthetic abstract.',
      author: '',
      year: '',
    };
  };
  operations.vote = async (id, recommendation, checkpoint) => {
    calls.vote.push({
      id,
      decision: recommendation.record.decision,
      humanReview: recommendation.humanReview,
    });
    const record = {
      ...recommendation.record,
      attemptId: randomUUID(),
      recommendationRunId: recommendation.record.runId,
      humanReview: recommendation.humanReview,
      decisionSource: 'human-batch-review',
      status: 'confirmed',
      recordedVote: recommendation.record.expectedButton,
    };
    withRecords(file, (s) => s.saveVote(record));
    await checkpoint({ record });
    return { record };
  };
  const run = () => runQueue({ store, job, config, operations, log: () => {} });
  return { folder, file, store, job, config, calls, operations, run };
}

test('review-all prepares every decision, persists optional edits, then one confirmation submits the whole batch exactly once', async () => {
  for (const real of [false, true]) {
    const f = await fixture({ real });
    try {
      await f.run();
      assert.deepEqual(f.calls.api, ['1', '2', '3']);
      assert.deepEqual(f.calls.vote, []);
      assert.equal(awaitingBatchConfirmation(f.store.items(f.job.id), f.job.mode), true);
      let snapshot = readApprovalBatch(f.file, [f.job.id]);
      const originalRecords = f.store.db.prepare('SELECT * FROM recommendations').all();
      saveBatchEdit(f.file, snapshot.entries[2], {
        decision: 'Exclude',
        rationale: 'The study does not meet the inclusion criteria.',
      });
      assert.throws(
        () => confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config),
        /changed during review/,
      );
      await f.run();
      assert.equal(f.calls.vote.length, 0);
      assert.equal(f.calls.api.length, 3);
      snapshot = readApprovalBatch(f.file, [f.job.id]);
      const edited = snapshot.entries[2].draft;
      assert.equal(edited.decision, 'Exclude');
      assert.equal(
        edited.rationale,
        original('Maybe').replace(
          'Original explanation.',
          'The study does not meet the inclusion criteria.',
        ),
      );
      assert.deepEqual(f.store.db.prepare('SELECT * FROM recommendations').all(), originalRecords);
      const history = readProjectHistory(f.file, f.config.reviewUrl);
      assert.equal(history.rows[3][2], 'Exclude');
      assert.equal(
        history.rows[3][3],
        edited.rationale.replace('Decision: Maybe', 'Decision: Exclude'),
      );
      assert.equal(history.rows[1].length, 4);
      assert.throws(
        () =>
          confirmBatch(f.file, [f.job.id], snapshot.fingerprint, {
            ...f.config,
            configHash: 'changed',
          }),
        /settings changed/,
      );
      assert.ok(f.store.items(f.job.id).every((i) => !i.data.batchApproval));
      assert.equal(confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config).count, 3);
      assert.throws(
        () => saveBatchEdit(f.file, snapshot.entries[0], { decision: 'Include' }),
        /confirmed submissions/,
      );
      await f.run();
      await f.run();
      assert.deepEqual(
        f.calls.vote.map((v) => [v.id, v.decision]),
        [
          ['1', 'Exclude'],
          ['2', 'Include'],
          ['3', 'Exclude'],
        ],
      );
      assert.equal(new Set(f.calls.vote.map((v) => v.humanReview.confirmationId)).size, 1);
      assert.equal(f.calls.api.length, 3);
      assert.ok(f.store.items(f.job.id).every((i) => i.state === 'completed'));
      const result = await exportProjectHistory(f.file, f.config.reviewUrl, { folder: f.folder });
      const { Workbook } = await spreadsheetLibrary(),
        workbook = new Workbook();
      await workbook.xlsx.readFile(result.output);
      assert.equal(workbook.worksheets[0].getCell('C4').value, 'Exclude');
      assert.equal(workbook.worksheets[0].getCell('D4').value, history.rows[3][3]);
      assert.match(result.history.log, /Batch confirmed with C/);
      assert.match(result.history.log, /Original explanation/);
      assert.match(result.history.log, /The study does not meet/);
    } finally {
      f.store.close();
    }
  }
});

test('preparation resumes without repeating saved answers; approval survives restart and uncertain submissions stop the batch', async () => {
  const f = await fixture();
  try {
    await runQueue({ ...f, shouldStop: () => f.calls.api.length === 1, log: () => {} });
    assert.equal(f.calls.vote.length, 0);
    assert.throws(() => readApprovalBatch(f.file, [f.job.id]), /Finish preparing/);
    await f.run();
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config);
    f.store.close();
    f.store = new QueueStore(f.file);
    let votes = 0;
    const operations = {
      ...f.operations,
      vote: async () => {
        votes++;
        return { record: { status: 'uncertain', error: 'Fixture uncertain result' } };
      },
    };
    await runQueue({ ...f, operations, log: () => {} });
    await runQueue({ ...f, operations, log: () => {} });
    assert.equal(votes, 1);
    assert.equal(f.store.item(f.job.id, '1').state, 'needs_review');
    assert.equal(f.store.item(f.job.id, '2').state, 'recommended');
    assert.equal(f.calls.api.length, 3);
  } finally {
    f.store.close();
  }
});

test('confirmed batches cannot replace the approved answer, change citations or bypass edited-decision integrity', async () => {
  for (const failure of ['citation', 'response', 'draft', 'partial']) {
    const f = await fixture();
    try {
      await f.run();
      const snapshot = readApprovalBatch(f.file, [f.job.id]);
      confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config);
      if (failure === 'citation')
        f.operations.extract = async (id) => ({
          ready: true,
          studyId: id,
          title: 'Changed',
          abstract: 'Changed',
        });
      if (failure === 'response') {
        const cached = f.operations.cached;
        f.operations.cached = async (...args) => {
          const r = await cached(...args);
          return { ...r, record: { ...r.record, runId: randomUUID() } };
        };
      }
      if (failure === 'draft' || failure === 'partial') {
        const item = f.store.item(f.job.id, '1');
        if (failure === 'draft') item.data.batchReview.decision = 'Include';
        else delete item.data.batchApproval;
        f.store.update(f.job.id, '1', 'recommended', item.data);
      }
      if (failure === 'partial') await assert.rejects(f.run(), /incomplete/);
      else await f.run();
      assert.equal(f.calls.vote.length, 0);
      assert.equal(f.calls.api.length, 3);
    } finally {
      f.store.close();
    }
  }
});

test('browser orchestration does not reopen a browser while a prepared batch waits for C', async () => {
  const f = await fixture();
  try {
    let opens = 0;
    const run = () =>
      runBrowserQueue({
        ...f,
        openBrowser: async () => {
          opens++;
          return { page: {}, close: async () => {} };
        },
        operationsForPage: () => f.operations,
        log: () => {},
      });
    await run();
    await run();
    assert.equal(opens, 1);
    assert.equal(f.calls.vote.length, 0);
  } finally {
    f.store.close();
  }
});

test('review viewer sorts Maybe, Yes, then No by AI decision and keeps order after edits', async () => {
  const f = await fixture();
  try {
    await f.run();
    const input = new PassThrough(),
      output = new PassThrough();
    const answers = ['yes', 'y'];
    output.on('data', (chunk) => {
      if (String(chunk).endsWith('[y/N]: '))
        setImmediate().then(() => input.write(`${answers.shift()}\n`));
    });
    let step = 0;
    const result = await reviewPendingBatch('Fixture', f.file, [f.job.id], {
      input,
      output,
      folder: f.folder,
      lock: async () => async () => {},
      load: async () => f.config,
      view: async (_name, lines, options) => {
        assert.equal(options.approval, true);
        assert.match(lines[0].join('\n'), /Study #3/);
        assert.match(lines[1].join('\n'), /Study #2/);
        assert.match(lines[2].join('\n'), /Study #1/);
        assert.match(lines[0].join('\n'), /Synthetic abstract/);
        if (step++ === 0) return { decisionIndex: 0, decision: 'Include' };
        assert.match(lines[0].join('\n'), /Your decision: Yes/);
        return { confirmed: true };
      },
    });
    assert.equal(result.count, 3);
    assert.deepEqual(answers, []);
    assert.equal(f.calls.vote.length, 0, 'Viewer only records approval; worker submits afterwards');
  } finally {
    f.store.close();
  }
});

test('decision, rationale and submission prompts require affirmative answers before changing saved state', async () => {
  const f = await fixture();
  try {
    await f.run();
    const originals = f.store.db.prepare('SELECT * FROM recommendations').all();
    const input = new PassThrough(),
      output = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = (raw) => (input.isRaw = raw);
    output.columns = 100;
    output.rows = 30;
    let text = '';
    output.on('data', (chunk) => (text += chunk));
    const waitFor = async (value) => {
      for (let i = 0; i < 2000 && !text.includes(value); i++) await setImmediate();
      assert.ok(text.includes(value), `Expected ${value}; got ${text}`);
      text = '';
    };
    const draft = () =>
      readApprovalBatch(f.file, [f.job.id]).entries.find((e) => e.studyId === '3').draft;
    const review = reviewPendingBatch('Fixture', f.file, [f.job.id], {
      input,
      output,
      folder: f.folder,
      lock: async () => async () => {},
      load: async () => f.config,
    });
    review.catch(() => {});
    await waitFor('C: confirm ALL');
    for (const [key, decision, label] of [
      ['m', 'Maybe', 'Maybe'],
      ['n', 'Exclude', 'No'],
      ['y', 'Include', 'Yes'],
    ]) {
      const before = draft();
      input.write(key);
      await waitFor(`to ${label}? [y/N]: `);
      assert.deepEqual(draft(), before);
      input.write('\r');
      await waitFor('C: confirm ALL');
      assert.deepEqual(draft(), before);
      input.write(key);
      await waitFor(`to ${label}? [y/N]: `);
      input.write('YES\r');
      await waitFor('C: confirm ALL');
      assert.equal(draft().decision, decision);
    }
    const beforeRationale = draft().rationale;
    for (const answer of ['n', 'y']) {
      input.write('e');
      await waitFor('New rationale (Enter keeps current wording): ');
      input.write('Confirmed replacement.\r');
      await waitFor('Save this rationale for study #3? [y/N]: ');
      assert.equal(draft().rationale, beforeRationale);
      input.write(`${answer}\r`);
      await waitFor('C: confirm ALL');
      assert.equal(
        draft().rationale,
        answer === 'n'
          ? beforeRationale
          : beforeRationale.replace('Original explanation.', 'Confirmed replacement.'),
      );
    }
    for (const answer of ['', 'n', 'anything else']) {
      input.write('c');
      await waitFor('Confirm ALL 3 decisions and submit votes to Covidence? [y/N]: ');
      assert.ok(f.store.items(f.job.id).every((item) => !item.data.batchApproval));
      input.write(`${answer}\r`);
      await waitFor('C: confirm ALL');
      assert.ok(f.store.items(f.job.id).every((item) => !item.data.batchApproval));
    }
    input.write('c');
    await waitFor('Confirm ALL 3 decisions and submit votes to Covidence? [y/N]: ');
    input.write('y\r');
    assert.equal((await review).count, 3);
    assert.ok(f.store.items(f.job.id).every((item) => item.data.batchApproval));
    assert.deepEqual(f.store.db.prepare('SELECT * FROM recommendations').all(), originals);
    assert.equal(f.calls.vote.length, 0);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), 0);
  } finally {
    f.store.close();
  }
});

test('C is the only batch-confirmation key; Enter, Esc and Ctrl+C save and exit without approval', async () => {
  for (const [keys, confirmed] of [
    ['c', true],
    ['C', true],
    ['\r', false],
    ['\x1b', false],
    ['\x03', false],
  ]) {
    const input = new PassThrough(),
      output = new PassThrough();
    input.isTTY = output.isTTY = true;
    output.columns = 80;
    output.rows = 12;
    let displayed = '';
    output.on('data', (chunk) => (displayed += chunk));
    input.setRawMode = (raw) => {
      input.isRaw = raw;
    };
    const pending = reviewBatch('Fixture', [['Local batch']], { input, output, approval: true });
    const screen = displayed.split('\x1b[H').at(-1).split('\r\n');
    assert.equal(screen.length, output.rows);
    assert.ok(screen.every((line) => line.length < output.columns));
    assert.ok(
      screen
        .join(' ')
        .includes(
          'C: confirm ALL and submit | S: save decisions without submitting | Y/N/M: change decision | E: change rationale | X: cancel batch | Left/Right: study | Up/Down: scroll | Esc: leave pending',
        ),
    );
    input.write(keys);
    const result = await pending;
    assert.equal(Boolean(result.confirmed), confirmed);
    await setImmediate();
    const terminal = createTerminal({ input, output });
    const answer = terminal.question('Next menu: ');
    input.write('1\r');
    assert.equal(await answer, '1');
    terminal.close();
  }
});

test('start screening has one mode, returns to saved review without new work, and submits only after C', async () => {
  for (const confirmed of [false, true]) {
    const f = await fixture();
    try {
      await f.run();
      const calls = [],
        prompts = [];
      await startScreening(
        { name: 'Fixture', reviewUrl: f.config.reviewUrl },
        async (p) => {
          prompts.push(p);
          return '';
        },
        {
          databaseFile: f.file,
          load: async () => f.config,
          show: () => {},
          chooseBrowserMode: async () => 'headless',
          discover: async () => assert.fail('Use saved review'),
          run: async () => {
            calls.push('submit');
            await f.run();
            return 0;
          },
          reviewBatch: async () => {
            calls.push('review');
            if (!confirmed) return true;
            const snapshot = readApprovalBatch(f.file, [f.job.id]);
            return confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config);
          },
        },
      );
      assert.deepEqual(calls, confirmed ? ['review', 'submit'] : ['review']);
      assert.equal(f.calls.vote.length, confirmed ? 3 : 0);
      assert.ok(prompts.every((p) => !p.includes('Choose 1 or 2')));
    } finally {
      f.store.close();
    }
  }
});

test('overlapping unfinished batches are reviewed separately so duplicate study IDs cannot deadlock confirmation', async () => {
  const f = await fixture();
  try {
    await f.run();
    const duplicate = f.store.create(f.config, ['1'], 'review-all');
    f.store.update(duplicate.id, '1', 'recommended', f.store.item(f.job.id, '1').data);
    f.store.db
      .prepare('UPDATE items SET updated_at=? WHERE job_id=?')
      .run('2099-01-01', duplicate.id);
    const viewed = [];
    await startScreening(
      { name: 'Fixture', reviewUrl: f.config.reviewUrl },
      async () => assert.fail('No extra confirmation'),
      {
        databaseFile: f.file,
        load: async () => f.config,
        show: () => {},
        chooseBrowserMode: async () => 'headless',
        discover: async () => assert.fail('Use saved work'),
        run: async () => assert.fail('Already prepared'),
        reviewBatch: async (ids) => {
          viewed.push(...ids);
          return true;
        },
      },
    );
    assert.deepEqual(viewed, [duplicate.id]);
    assert.equal(f.calls.vote.length, 0);
    assert.equal(f.store.items(f.job.id).length, 3);
  } finally {
    f.store.close();
  }
});

test('cancel deletes responses and edits without backup, preserves Today, and a new batch makes fresh requests', async () => {
  const f = await fixture();
  try {
    await f.run();
    let snapshot = readApprovalBatch(f.file, [f.job.id]);
    saveBatchEdit(f.file, snapshot.entries[0], { rationale: 'Human draft kept in audit.' });
    snapshot = readApprovalBatch(f.file, [f.job.id]);
    const tables = [
      'items',
      'events',
      'recommendations',
      'recommendation_payloads',
      'parse_attempts',
    ];
    const settingsBefore = f.store.db.prepare('SELECT * FROM job_settings').all();
    withRecords(f.file, (s) =>
      s.projectEvent(randomUUID(), f.config.reviewUrl, 'history_rationales_edited', {
        edits: [{ runId: snapshot.entries[0].draft.runId, rationale: 'Legacy edit to delete.' }],
      }),
    );
    const root = path.join(f.folder, 'Projects');
    const folder = projectLocation(f.config.reviewUrl, root);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(f.config));
    const [projectBefore] = await listProjects({ root, databaseFile: f.file });
    assert.equal(projectBefore.historyTotal, 3);
    assert.equal(projectBefore.unfinished, 3);
    assert.deepEqual(cancelBatch(f.file, [f.job.id], snapshot.fingerprint), {
      cancelled: true,
      count: 3,
    });
    assert.deepEqual(
      tables.map((t) => f.store.db.prepare(`SELECT * FROM ${t}`).all()),
      tables.map(() => []),
    );
    assert.deepEqual(f.store.db.prepare('SELECT * FROM job_settings').all(), settingsBefore);
    const cancellationLog = f.store.db.prepare('SELECT * FROM project_events').all();
    assert.equal(cancellationLog.length, 1);
    assert.equal(cancellationLog[0].kind, 'batch_cancelled');
    assert.doesNotMatch(
      JSON.stringify(cancellationLog),
      /Original explanation|Human draft|Legacy edit|Synthetic abstract/,
    );
    assert.ok(!(await readdir(folder)).includes('Backups'));
    assert.ok(!(await readdir(f.folder)).includes('Backups'));
    assert.deepEqual(f.store.counts(f.job.id), {});
    assert.deepEqual(pendingScreenings(f.store, f.config), []);
    assert.deepEqual(readUnfinished(f.file, f.config.reviewUrl), []);
    assert.deepEqual(readApprovalBatch(f.file, [f.job.id]).entries, []);
    assert.throws(() => f.store.update(f.job.id, '1', 'recommended', {}), /not found/);
    assert.throws(
      () => confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config),
      /changed/,
    );
    await f.run();
    await runBrowserQueue({
      ...f,
      openBrowser: () => assert.fail('Cancelled work cannot open a browser'),
    });
    assert.equal(f.calls.api.length, 3);
    const first = snapshot.entries[0].recommendation;
    assert.equal(await f.operations.cached('1', first.study, first.record.runId), null);
    await assert.rejects(loadRecommendation(f.file, f.config, first.record.runId), /not found/);
    await assert.rejects(
      reparseRecommendation(f.file, { ...f.config, studyId: '1' }, first.record.runId),
      /not found/,
    );
    const result = await exportProjectHistory(f.file, f.config.reviewUrl, { folder });
    assert.equal(result.history.rows.length, 1);
    assert.match(result.history.log, /Batch decisions cancelled before submission/);
    assert.doesNotMatch(
      result.history.log,
      /Human draft kept in audit|Original explanation|Legacy edit/,
    );
    assert.match(result.history.log, /deleted without a backup/);
    assert.equal(result.history.usage.requests, 3);
    const { Workbook } = await spreadsheetLibrary(),
      workbook = new Workbook();
    await workbook.xlsx.readFile(result.output);
    assert.equal(workbook.worksheets[0].rowCount, 1);
    const [projectAfter] = await listProjects({ root, databaseFile: f.file });
    assert.equal(projectAfter.historyTotal, 0);
    assert.equal(projectAfter.unfinished, 0);
    assert.equal(projectAfter.localScreened.today, projectBefore.localScreened.today);
    f.store.close();
    f.store = new QueueStore(f.file);
    const next = f.store.create(f.config, ['1', '2', '3'], 'review-all');
    await runQueue({ ...f, job: next, log: () => {} });
    assert.deepEqual(f.calls.api, ['1', '2', '3', '1', '2', '3']);
    assert.deepEqual(f.calls.vote, []);
    assert.equal(readApprovalBatch(f.file, [next.id]).entries.length, 3);
    assert.equal(readProjectHistory(f.file, f.config.reviewUrl).rows.length, 4);
    const [projectAgain] = await listProjects({ root, databaseFile: f.file });
    assert.equal(projectAgain.historyTotal, 3);
    assert.equal(projectAgain.localScreened.today, projectBefore.localScreened.today);
  } finally {
    f.store.close();
  }
});

test('cancellation refuses changed, approved, completed, claimed or possibly submitted batches atomically', async () => {
  for (const failure of [
    'edit',
    'approval',
    'completed',
    'claim',
    'uncertain',
    'confirmed',
    'reference',
    'other-approval',
  ]) {
    const f = await fixture();
    try {
      await f.run();
      const snapshot = readApprovalBatch(f.file, [f.job.id]);
      const item = f.store.item(f.job.id, '2');
      if (failure === 'edit') saveBatchEdit(f.file, snapshot.entries[0], { decision: 'Include' });
      if (failure === 'approval') confirmBatch(f.file, [f.job.id], snapshot.fingerprint, f.config);
      if (failure === 'completed') f.store.update(f.job.id, '2', 'completed', item.data);
      if (failure === 'claim')
        f.store.db
          .prepare('INSERT INTO vote_claims VALUES (?,?)')
          .run(`demo.covidence.org-${f.config.reviewId}-2`, randomUUID());
      if (['uncertain', 'confirmed'].includes(failure))
        withRecords(f.file, (s) =>
          s.saveVote({
            attemptId: randomUUID(),
            reviewUrl: f.config.reviewUrl,
            studyId: '2',
            status: failure,
          }),
        );
      if (failure === 'reference')
        f.store.update(f.job.id, '2', 'recommended', { ...item.data, voteRef: 'vote:missing' });
      if (failure === 'other-approval') {
        const other = f.store.create(f.config, ['2'], 'review-all');
        f.store.update(other.id, '2', 'recommended', {
          ...item.data,
          batchApproval: { id: 'other' },
        });
      }
      const before = f.store.db.prepare('SELECT * FROM items').all();
      assert.throws(
        () => cancelBatch(f.file, [f.job.id], snapshot.fingerprint),
        /changed|confirmed|vote attempt/,
      );
      assert.deepEqual(f.store.db.prepare('SELECT * FROM items').all(), before);
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) n FROM project_events WHERE kind='batch_cancelled'")
          .get().n,
        0,
      );
      assert.equal(f.calls.api.length, 3);
      assert.equal(f.calls.vote.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('cancel retires older matching replies and overlapping entries while preserving unrelated settings and projects', async () => {
  const f = await fixture();
  try {
    await f.run();
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    const saved = snapshot.entries[0].recommendation;
    const olderId = randomUUID(),
      otherSettingsId = randomUUID(),
      otherProjectId = randomUUID();
    withRecords(f.file, (s) => {
      s.saveRecommendation({ ...saved, record: { ...saved.record, runId: olderId } });
      s.saveRecommendation({
        ...saved,
        record: { ...saved.record, runId: otherSettingsId, configHash: 'other-settings' },
      });
      s.saveRecommendation({
        ...saved,
        record: {
          ...saved.record,
          runId: otherProjectId,
          reviewUrl: 'https://demo.covidence.org/reviews/999',
        },
      });
    });
    const overlap = f.store.create(f.config, ['1', '4'], 'review-all');
    f.store.update(overlap.id, '1', 'recommended', f.store.item(f.job.id, '1').data);
    cancelBatch(f.file, [f.job.id], snapshot.fingerprint);
    const ids = withRecords(f.file, (s) => s.recommendationIds(f.config, '1'));
    assert.deepEqual(ids, []);
    assert.deepEqual(
      withRecords(f.file, (s) => s.recommendationAttempts(f.config, '1')),
      [],
    );
    assert.deepEqual(
      withRecords(f.file, (s) =>
        s.recommendationIds({ ...f.config, configHash: 'other-settings' }, '1'),
      ),
      [otherSettingsId],
    );
    assert.deepEqual(
      withRecords(f.file, (s) =>
        s.recommendationIds(
          { ...f.config, reviewUrl: 'https://demo.covidence.org/reviews/999' },
          '1',
        ),
      ),
      [otherProjectId],
    );
    assert.throws(() => f.store.item(overlap.id, '1'), /not found/);
    assert.equal(f.store.item(overlap.id, '4').state, 'pending');
    assert.deepEqual(
      pendingScreenings(f.store, f.config).flatMap((w) => w.remaining.map((i) => i.study_id)),
      ['4'],
    );
    const fresh = f.store.create(f.config, ['1'], 'review-all');
    await runQueue({ ...f, job: fresh, log: () => {} });
    assert.deepEqual(f.calls.api, ['1', '2', '3', '1']);
    assert.equal(f.store.item(fresh.id, '1').state, 'recommended');
  } finally {
    f.store.close();
  }
});

test('cancellation blocks stale restore in either direction; response-free cancellation history remains restorable', async () => {
  const f = await fixture();
  try {
    await f.run();
    const root = path.join(f.folder, 'Projects');
    const folder = projectLocation(f.config.reviewUrl, root);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(f.config));
    const options = { root, databaseFile: f.file };
    const before = await backupProject(f.config.reviewUrl, options);
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    cancelBatch(f.file, [f.job.id], snapshot.fingerprint);
    const after = await backupProject(f.config.reviewUrl, options);
    await assert.rejects(restoreProjectBackup(before.file, options), /cancelled batch/);
    assert.deepEqual(f.store.counts(f.job.id), {});
    const restored = {
      root: path.join(f.folder, 'Restored'),
      databaseFile: path.join(f.folder, 'restored.sqlite'),
    };
    await restoreProjectBackup(before.file, restored);
    await assert.rejects(restoreProjectBackup(after.file, restored), /cancelled batch/);
    const clean = {
      root: path.join(f.folder, 'Clean'),
      databaseFile: path.join(f.folder, 'clean.sqlite'),
    };
    await restoreProjectBackup(after.file, clean);
    await assert.rejects(restoreProjectBackup(before.file, clean), /cancelled batch/);
    const store = new QueueStore(clean.databaseFile);
    try {
      assert.deepEqual(store.counts(f.job.id), {});
      assert.deepEqual(pendingScreenings(store, f.config), []);
      assert.equal(readProjectHistory(clean.databaseFile, f.config.reviewUrl).rows.length, 1);
      assert.deepEqual(
        withRecords(clean.databaseFile, (s) => s.recommendationIds(f.config, '1')),
        [],
      );
    } finally {
      store.close();
    }
  } finally {
    f.store.close();
  }
});

test('X asks before cancellation; blank, No and invalid answers keep the batch, and Yes returns without approval', async () => {
  const f = await fixture();
  try {
    await f.run();
    const input = new PassThrough(),
      output = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = (raw) => (input.isRaw = raw);
    output.columns = 80;
    output.rows = 15;
    let text = '',
      locks = 0;
    output.on('data', (chunk) => (text += chunk));
    const waitFor = async (value) => {
      for (let i = 0; i < 3000 && !text.includes(value); i++) await setImmediate();
      assert.ok(text.includes(value), `Expected ${value}; got ${text}`);
      text = '';
    };
    const pending = reviewPendingBatch('Fixture', f.file, [f.job.id], {
      input,
      output,
      folder: f.folder,
      lock: async () => {
        locks++;
        return async () => {};
      },
      load: () =>
        assert.fail('Cancellation does not need an API/browser or current settings reload'),
    });
    pending.catch(() => {});
    await waitFor('cancel batch');
    for (const answer of ['', 'No', 'not yes']) {
      input.write('x');
      await waitFor('can be screened again. [y/N]: ');
      assert.deepEqual(f.store.counts(f.job.id), { recommended: 3 });
      input.write(`${answer}\r`);
      await waitFor('cancel batch');
      assert.deepEqual(f.store.counts(f.job.id), { recommended: 3 });
      assert.equal(locks, 0);
    }
    input.write('X');
    await waitFor('can be screened again. [y/N]: ');
    input.write('YES\r');
    assert.deepEqual(await pending, { cancelled: true, count: 3 });
    assert.equal(locks, 1);
    assert.deepEqual(f.store.counts(f.job.id), {});
    assert.ok(f.store.items(f.job.id).every((i) => !i.data.batchApproval));
    assert.equal(f.calls.vote.length, 0);
    assert.equal(f.calls.api.length, 3);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), 0);
    const terminal = createTerminal({ input, output });
    const answer = terminal.question('Next menu: ');
    input.write('1\r');
    assert.equal(await answer, '1');
    terminal.close();
  } finally {
    f.store.close();
  }
});

test('start after cancellation discovers a new batch and submits nothing when its review is cancelled', async () => {
  const f = await fixture();
  try {
    await f.run();
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    cancelBatch(f.file, [f.job.id], snapshot.fingerprint);
    const calls = [];
    await startScreening(
      { name: 'Fixture', reviewUrl: f.config.reviewUrl },
      async (prompt) => {
        assert.equal(prompt, 'Start screening? [Y/n]: ');
        return 'y';
      },
      {
        databaseFile: f.file,
        load: async () => f.config,
        show: () => {},
        chooseBrowserMode: async () => 'headless',
        discover: async () => {
          calls.push('discover');
          return { result: { studies: [{ studyId: '1' }] } };
        },
        run: async (_script, args) => {
          calls.push('prepare');
          await runQueue({ ...f, job: f.store.job(args[2]), log: () => {} });
          return 0;
        },
        reviewBatch: async (ids) => {
          calls.push('cancel');
          const next = readApprovalBatch(f.file, ids);
          return cancelBatch(f.file, ids, next.fingerprint);
        },
      },
    );
    assert.deepEqual(calls, ['discover', 'prepare', 'cancel']);
    assert.deepEqual(f.calls.api, ['1', '2', '3', '1']);
    assert.deepEqual(f.calls.vote, []);
  } finally {
    f.store.close();
  }
});

test('an export failure after cancellation returns to the project with cancellation safely committed', async () => {
  const f = await fixture();
  try {
    await f.run();
    const blockedFolder = path.join(f.folder, 'not-a-folder');
    await writeFile(blockedFolder, 'Local fixture forces export failure.');
    const input = new PassThrough(),
      output = new PassThrough();
    let text = '',
      views = 0;
    output.on('data', (chunk) => {
      text += chunk;
      if (String(chunk).endsWith('[y/N]: ')) setImmediate().then(() => input.write('y\n'));
      if (String(chunk).endsWith('Press Enter to return to this project. '))
        setImmediate().then(() => input.write('\n'));
    });
    const result = await reviewPendingBatch('Fixture', f.file, [f.job.id], {
      input,
      output,
      folder: blockedFolder,
      lock: async () => async () => {},
      view: async () => {
        views++;
        return { cancelRequested: true };
      },
    });
    assert.deepEqual(result, { cancelled: true, count: 3 });
    assert.equal(views, 1);
    assert.match(text, /Batch cancelled locally; Excel was not updated/);
    assert.deepEqual(pendingScreenings(f.store, f.config), []);
    assert.equal(f.calls.vote.length, 0);
    assert.equal(f.calls.api.length, 3);
  } finally {
    f.store.close();
  }
});

test('cancellation preserves separate imported history in the standard spreadsheet layout', async () => {
  const f = await fixture({ real: true });
  try {
    await f.run();
    const key = 'https://app.covidence.org/reviews/900001';
    withRecords(f.file, (s) =>
      s.projectEvent(randomUUID(), key, 'history_workbook_imported', {
        rows: [['1', 'Imported study', 'Maybe', 'Imported explanation.']],
      }),
    );
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    cancelBatch(f.file, [f.job.id], snapshot.fingerprint);
    const history = readProjectHistory(f.file, f.config.reviewUrl);
    assert.equal(history.rows.length, 2);
    assert.deepEqual(history.rows[1], ['1', 'Imported study', 'Maybe', 'Imported explanation.']);
    assert.equal(history.rows[0].length, 4);
    const root = path.join(f.folder, 'Projects'),
      folder = projectLocation(f.config.reviewUrl, root);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(f.config));
    const [project] = await listProjects({ root, databaseFile: f.file });
    assert.equal(project.historyTotal, 1);
    assert.equal(project.unfinished, 0);
  } finally {
    f.store.close();
  }
});

test('a storage failure rolls back cancellation without losing any response or draft', async () => {
  const f = await fixture();
  try {
    await f.run();
    const first = readApprovalBatch(f.file, [f.job.id]);
    saveBatchEdit(f.file, first.entries[0], { rationale: 'Keep this if cancellation fails.' });
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    const tables = [
      'items',
      'events',
      'recommendations',
      'recommendation_payloads',
      'parse_attempts',
      'project_events',
    ];
    const before = tables.map((t) => f.store.db.prepare(`SELECT * FROM ${t}`).all());
    f.store.db.exec(
      "CREATE TRIGGER fail_cancellation BEFORE INSERT ON project_events WHEN NEW.kind='batch_cancelled' BEGIN SELECT RAISE(ABORT, 'Fixture storage failure'); END",
    );
    assert.throws(
      () => cancelBatch(f.file, [f.job.id], snapshot.fingerprint),
      /Fixture storage failure/,
    );
    assert.deepEqual(
      tables.map((t) => f.store.db.prepare(`SELECT * FROM ${t}`).all()),
      before,
    );
    assert.equal(readApprovalBatch(f.file, [f.job.id]).fingerprint, snapshot.fingerprint);
    assert.equal(f.calls.vote.length, 0);
  } finally {
    f.store.close();
  }
});

test('save-only retains original responses and edits, exports demo and standard reviews, and never resumes or submits', async () => {
  for (const real of [false, true]) {
    const f = await fixture({ real });
    try {
      await f.run();
      const originals = f.store.db.prepare('SELECT * FROM recommendations').all();
      const payloads = f.store.db.prepare('SELECT * FROM recommendation_payloads').all();
      let snapshot = readApprovalBatch(f.file, [f.job.id]);
      saveBatchEdit(f.file, snapshot.entries[0], {
        decision: 'Maybe',
        rationale: 'Need the full text.',
      });
      snapshot = readApprovalBatch(f.file, [f.job.id]);
      assert.deepEqual(
        saveBatchWithoutSubmitting(f.file, [f.job.id], snapshot.fingerprint, f.config),
        { savedOnly: true, count: 3 },
      );
      assert.ok(
        f.store.items(f.job.id).every((item) => item.state === 'saved' && !item.data.batchApproval),
      );
      assert.deepEqual(f.store.db.prepare('SELECT * FROM recommendations').all(), originals);
      assert.deepEqual(f.store.db.prepare('SELECT * FROM recommendation_payloads').all(), payloads);
      assert.deepEqual(pendingScreenings(f.store, f.config), []);
      assert.equal(awaitingBatchConfirmation(f.store.items(f.job.id), f.job.mode), false);
      assert.deepEqual(readApprovalBatch(f.file, [f.job.id]).entries, []);
      await f.run();
      await runBrowserQueue({
        ...f,
        openBrowser: () => assert.fail('Saved batch must not open a browser'),
        log: () => {},
      });
      assert.equal(f.calls.api.length, 3);
      assert.equal(f.calls.vote.length, 0);
      assert.throws(
        () => f.store.create(f.config, ['1', '4'], 'review-all'),
        /saved without submission/,
      );
      assert.throws(
        () => f.store.create({ ...f.config, configHash: 'new-settings' }, ['1'], 'review-all'),
        /saved without submission/,
      );
      const exported = await exportProjectHistory(f.file, f.config.reviewUrl, { folder: f.folder });
      const { Workbook } = await spreadsheetLibrary(),
        workbook = new Workbook();
      await workbook.xlsx.readFile(exported.output);
      assert.equal(workbook.worksheets[0].getCell('C2').value, 'Maybe');
      assert.equal(workbook.worksheets[0].columnCount, 4);
      assert.match(String(workbook.worksheets[0].getCell('D2').value), /Need the full text/);
      assert.deepEqual(
        workbook.worksheets.map((s) => s.name),
        ['Decision history', 'Saved-only'],
      );
      assert.deepEqual(
        workbook
          .getWorksheet('Saved-only')
          .getRows(1, 4)
          .map((row) => row.values.slice(1)),
        exported.history.rows,
      );
      assert.equal(workbook.getWorksheet('Saved-only').columnCount, 4);
      assert.equal(
        (await exportProjectHistory(f.file, f.config.reviewUrl, { folder: f.folder })).changed,
        false,
      );
      assert.match(exported.history.log, /Saved without submission; excluded from new batches/);
      assert.match(exported.history.log, /Original explanation/);
      let discovered = 0;
      await startScreening({ name: 'Fixture', reviewUrl: f.config.reviewUrl }, async () => '', {
        databaseFile: f.file,
        load: async () => f.config,
        show: () => {},
        chooseBrowserMode: async () => 'headless',
        discover: async () => {
          discovered++;
          return { result: { studies: [] } };
        },
        run: () => assert.fail('No queued work'),
        reviewBatch: () => assert.fail('Saved previews must not return'),
      });
      assert.equal(discovered, 1);
      const root = path.join(f.folder, 'Projects'),
        folder = projectLocation(f.config.reviewUrl, root);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'Project settings.json'), JSON.stringify(f.config));
      const backup = await backupProject(f.config.reviewUrl, { databaseFile: f.file, root });
      const restored = path.join(f.folder, 'restored.sqlite');
      await restoreProjectBackup(backup.file, {
        databaseFile: restored,
        root: path.join(f.folder, 'Restored'),
      });
      const copy = new QueueStore(restored);
      try {
        assert.equal(copy.item(f.job.id, '1').state, 'saved');
        assert.deepEqual(pendingScreenings(copy, f.config), []);
        assert.throws(() => copy.create(f.config, ['1'], 'review-all'), /saved without submission/);
      } finally {
        copy.close();
      }
    } finally {
      f.store.close();
    }
  }
});

test('save-only rejects stale edits, settings changes, vote claims and confirmed overlapping batches atomically', async () => {
  for (const failure of ['edit', 'settings', 'claim', 'approval', 'vote']) {
    const f = await fixture();
    try {
      await f.run();
      const snapshot = readApprovalBatch(f.file, [f.job.id]);
      if (failure === 'edit') saveBatchEdit(f.file, snapshot.entries[0], { decision: 'Maybe' });
      if (failure === 'claim')
        f.store.db
          .prepare('INSERT INTO vote_claims VALUES (?,?)')
          .run(`demo.covidence.org-${f.config.reviewId}-1`, 'uncertain');
      if (failure === 'approval') {
        const other = f.store.create(f.config, ['1'], 'review-all');
        f.store.update(other.id, '1', 'recommended', {
          ...f.store.item(f.job.id, '1').data,
          batchApproval: { id: 'other' },
        });
      }
      if (failure === 'vote')
        withRecords(f.file, (s) =>
          s.saveVote({
            attemptId: 'uncertain',
            reviewUrl: f.config.reviewUrl,
            studyId: '1',
            status: 'uncertain',
          }),
        );
      const before = f.store.db.prepare('SELECT * FROM items').all();
      assert.throws(
        () =>
          saveBatchWithoutSubmitting(
            f.file,
            [f.job.id],
            snapshot.fingerprint,
            failure === 'settings' ? { ...f.config, configHash: 'changed' } : f.config,
          ),
        /changed|vote attempt|confirmed/,
      );
      assert.deepEqual(f.store.db.prepare('SELECT * FROM items').all(), before);
    } finally {
      f.store.close();
    }
  }
});

test('saved-only studies in an older overlapping queue cannot make another AI request or vote', async () => {
  const f = await fixture();
  try {
    await f.run();
    const older = f.store.create(f.config, ['1', '4'], 'review-all');
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    saveBatchWithoutSubmitting(f.file, [f.job.id], snapshot.fingerprint, f.config);
    assert.deepEqual(
      pendingScreenings(f.store, f.config).flatMap((w) => w.remaining.map((i) => i.study_id)),
      ['4'],
    );
    await runQueue({
      ...f,
      job: older,
      shouldStop: () => f.store.item(older.id, '1').state === 'skipped',
      log: () => {},
    });
    assert.equal(f.store.item(older.id, '1').state, 'skipped');
    assert.equal(f.calls.api.length, 3);
    assert.equal(f.calls.vote.length, 0);
  } finally {
    f.store.close();
  }
});

test('S requires an affirmative save-only choice; Enter and No keep the batch pending', async () => {
  const f = await fixture();
  try {
    await f.run();
    const input = new PassThrough(),
      output = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = (raw) => (input.isRaw = raw);
    output.columns = 100;
    output.rows = 30;
    let text = '';
    output.on('data', (chunk) => (text += chunk));
    const waitFor = async (s) => {
      for (let i = 0; i < 2000 && !text.includes(s); i++) await setImmediate();
      assert.ok(text.includes(s), text);
      text = '';
    };
    const review = reviewPendingBatch('Fixture', f.file, [f.job.id], {
      input,
      output,
      folder: f.folder,
      lock: async () => async () => {},
      load: async () => f.config,
    });
    review.catch(() => {});
    await waitFor('S: save decisions');
    for (const answer of ['', 'n']) {
      input.write('s');
      await waitFor('These previews will not return in new batches. [y/N]: ');
      input.write(answer + '\r');
      await waitFor('S: save decisions');
      assert.equal(pendingScreenings(f.store, f.config).length, 1);
    }
    input.write('s');
    await waitFor('These previews will not return in new batches. [y/N]: ');
    input.write('yes\r');
    assert.deepEqual(await review, { savedOnly: true, count: 3 });
    assert.deepEqual(pendingScreenings(f.store, f.config), []);
    assert.equal(f.calls.vote.length, 0);
    assert.equal(input.isRaw, false);
    const terminal = createTerminal({ input, output });
    const answer = terminal.question('Next menu: ');
    input.write('1\r');
    assert.equal(await answer, '1');
    terminal.close();
  } finally {
    f.store.close();
  }
});

test('save-only export failure preserves all decisions and returns to the project without replaying previews', async () => {
  const f = await fixture();
  try {
    await f.run();
    const blockedFolder = path.join(f.folder, 'not-a-folder');
    await writeFile(blockedFolder, 'Local fixture forces export failure.');
    const input = new PassThrough(),
      output = new PassThrough();
    let text = '',
      views = 0;
    output.on('data', (chunk) => {
      text += chunk;
      if (String(chunk).endsWith('[y/N]: ')) setImmediate().then(() => input.write('y\n'));
      if (String(chunk).endsWith('Press Enter to return to this project. '))
        setImmediate().then(() => input.write('\n'));
    });
    const result = await reviewPendingBatch('Fixture', f.file, [f.job.id], {
      input,
      output,
      folder: blockedFolder,
      lock: async () => async () => {},
      load: async () => f.config,
      view: async () => {
        views++;
        return { saveOnlyRequested: true };
      },
    });
    assert.deepEqual(result, { savedOnly: true, count: 3 });
    assert.equal(views, 1);
    assert.match(text, /Decisions saved locally without submission; Excel was not updated/);
    assert.deepEqual(pendingScreenings(f.store, f.config), []);
    assert.equal(readProjectHistory(f.file, f.config.reviewUrl).rows.length, 4);
    assert.equal(f.calls.vote.length, 0);
  } finally {
    f.store.close();
  }
});

test('save-only storage failure rolls back every item and its audit event', async () => {
  const f = await fixture();
  try {
    await f.run();
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    const tables = ['items', 'events', 'recommendations', 'recommendation_payloads'];
    const before = tables.map((name) => f.store.db.prepare('SELECT * FROM ' + name).all());
    f.store.db.exec(
      "CREATE TRIGGER fail_save BEFORE UPDATE ON items WHEN NEW.state='saved' AND NEW.study_id='2' BEGIN SELECT RAISE(ABORT, 'Fixture save failure'); END",
    );
    assert.throws(
      () => saveBatchWithoutSubmitting(f.file, [f.job.id], snapshot.fingerprint, f.config),
      /Fixture save failure/,
    );
    assert.deepEqual(
      tables.map((name) => f.store.db.prepare('SELECT * FROM ' + name).all()),
      before,
    );
    assert.equal(readApprovalBatch(f.file, [f.job.id]).fingerprint, snapshot.fingerprint);
  } finally {
    f.store.close();
  }
});

test('a prepared overlapping batch only previews and approves studies not already saved-only', async () => {
  const f = await fixture();
  try {
    await f.run();
    const other = f.store.create(f.config, ['1', '4'], 'review-all');
    const first = f.store.item(f.job.id, '1');
    f.store.update(other.id, '1', 'recommended', first.data);
    const originalEntry = readApprovalBatch(f.file, [f.job.id]).entries[2];
    const study = { ...originalEntry.recommendation.study, studyId: '4', title: 'Study 4' };
    const { studyHash } = await import('../Application/profiles.js');
    const record = {
      ...originalEntry.recommendation.record,
      runId: randomUUID(),
      studyId: '4',
      title: study.title,
      studyHash: studyHash(study),
    };
    withRecords(f.file, (s) =>
      s.saveRecommendation({ record, study, parsed: originalEntry.recommendation.parsed }),
    );
    f.store.update(other.id, '4', 'recommended', { recommendationRecord: record });
    const snapshot = readApprovalBatch(f.file, [f.job.id]);
    saveBatchWithoutSubmitting(f.file, [f.job.id], snapshot.fingerprint, f.config);
    const remaining = readApprovalBatch(f.file, [other.id]);
    assert.deepEqual(
      remaining.entries.map((e) => e.studyId),
      ['4'],
    );
    confirmBatch(f.file, [other.id], remaining.fingerprint, f.config);
    await runQueue({
      ...f,
      job: other,
      operations: {
        ...f.operations,
        extract: async (id) => {
          assert.equal(id, '4');
          return { ...study, ready: true };
        },
        cached: async () => ({ record, study, parsed: originalEntry.recommendation.parsed }),
      },
      log: () => {},
    });
    assert.equal(f.store.item(other.id, '1').state, 'skipped');
    assert.equal(f.store.item(other.id, '4').state, 'completed');
    assert.deepEqual(
      f.calls.vote.map((v) => v.id),
      ['4'],
    );
  } finally {
    f.store.close();
  }
});
