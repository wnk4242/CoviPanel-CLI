import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCompletedBatch, reviewBatch } from '../Application/batch-review.js';
import { QueueStore } from '../Application/queue-store.js';
import { withRecords } from '../Application/records.js';
import { createTerminal } from '../Application/terminal-input.js';
import { startScreening } from '../Application/screening-session.js';
import { runMainMenu } from '../Application/project-menu.js';
import { loadProfile } from './fixtures.js';

async function fixture() {
  const file = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-batch-review-')),
    'screening.sqlite',
  );
  const config = await loadProfile('demo', '1');
  const store = new QueueStore(file);
  return { file, config, store };
}

test('batch review uses the batch attempt, preserves full replies and reads without changing records', async () => {
  const { file, config, store } = await fixture();
  try {
    const job = store.create(config, ['2', '1', '3'], 'recommend-only');
    const original = {
      runId: 'original',
      dataset: config.dataset,
      reviewUrl: config.reviewUrl,
      studyId: '2',
      configHash: config.configHash,
      status: 'recommended',
      title: 'Original title',
      decision: 'Include',
    };
    const fullReply =
      'Population: children\nIntervention: symptoms\nCondition: treatment\nStudyDesign: experiment\nRationale: original explanation';
    withRecords(file, (records) => {
      records.saveRecommendation({
        record: original,
        parsed: { Decision: 'Include', ResponseText: fullReply },
      });
      records.saveRecommendation({
        record: { ...original, runId: 'later', decision: 'Exclude' },
        parsed: { Rationale: 'A later response must not appear' },
      });
      records.saveRecommendation({
        record: { ...original, runId: 'legacy', studyId: '1', decision: 'Maybe' },
        parsed: {
          Decision: 'Maybe',
          Population: 'adults',
          Intervention: 'vitamin C',
          Condition: 'placebo',
          StudyDesign: 'survey',
          Rationale: 'Uncertain eligibility',
        },
      });
    });
    store.update(job.id, '2', 'recommended', { recommendationRecord: original });
    store.update(job.id, '1', 'recommended', { recommendationRef: 'recommendation:legacy' });
    store.update(job.id, '3', 'skipped', { reviewReason: 'Locally skipped' });
    const before = store.db.prepare('SELECT * FROM items').all();
    const events = store.db.prepare('SELECT * FROM events').all();
    const studies = readCompletedBatch(file, job.id);
    assert.match(studies[0].join('\n'), /Study #2.*recommended/);
    assert.match(studies[0].join('\n'), /AI decision: Include/);
    assert.ok(studies[0].join('\n').includes(fullReply));
    assert.doesNotMatch(studies.flat().join('\n'), /later response/);
    assert.match(studies[1].join('\n'), /AI decision: Maybe/);
    assert.match(studies[1].join('\n'), /StudyDesign: survey\nRationale: Uncertain eligibility/);
    assert.match(studies[2].join('\n'), /No saved rationale/);
    assert.match(studies[2].join('\n'), /Locally skipped/);
    assert.deepEqual(store.db.prepare('SELECT * FROM items').all(), before);
    assert.deepEqual(store.db.prepare('SELECT * FROM events').all(), events);
  } finally {
    store.close();
  }
});

test('only finished batches open; actual recorded votes remain distinct from AI decisions', async () => {
  const { file, config, store } = await fixture();
  try {
    const job = store.create(config, ['1'], 'auto-vote');
    store.update(job.id, '1', 'recommended', {
      recommendationRecord: { decision: 'Include', rationale: 'Saved explanation' },
    });
    assert.deepEqual(readCompletedBatch(file, job.id), []);
    withRecords(file, (records) =>
      records.saveVote({ attemptId: 'vote', status: 'confirmed', recordedVote: 'No' }),
    );
    store.update(job.id, '1', 'completed', {
      ...store.item(job.id, '1').data,
      voteRecord: { attemptId: 'vote', status: 'prepared' },
    });
    const text = readCompletedBatch(file, job.id)[0].join('\n');
    assert.match(text, /AI decision: Include/);
    assert.match(text, /Covidence vote: No \| confirmed/);
    assert.match(text, /Saved explanation/);
  } finally {
    store.close();
  }
});

function terminalFixture() {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => {
    input.isRaw = raw;
  };
  output.columns = 80;
  output.rows = 12;
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  return { input, output, screen: () => text.split('\x1b[H').at(-1) };
}

test('returning from batch review keeps the project selected and opens browser choice again', async () => {
  const f = terminalFixture();
  let terminal, currentScreen, viewed;
  const question = (prompt) => {
    terminal ||= createTerminal(f);
    return terminal.question(prompt);
  };
  const project = { name: 'Fixture', reviewUrl: 'https://app.covidence.org/reviews/900001' };
  let starts = 0;
  const menu = runMainMenu(
    question,
    {
      list: async () => [project],
      create: async () => assert.fail('Must not return to new-project setup'),
      start: async (selected) => {
        assert.equal(selected, project);
        currentScreen = 'Browser mode';
        const browser = await question('1. Visible browser; 2. Headless: ');
        assert.equal(browser, starts === 0 ? '1' : '2');
        starts++;
        // The launcher closes its line prompt before a finished batch viewer.
        terminal.close();
        terminal = null;
        currentScreen = 'Batch review';
        viewed = reviewBatch(project.name, [['Finished local fixture batch']], f);
        await viewed;
      },
    },
    { show: (title) => (currentScreen = title) },
  );
  const send = async (keys) => {
    f.input.write(keys);
    await setImmediate();
  };
  // Observe failures even if an assertion stops the keyboard driver early.
  menu.catch(() => {});
  try {
    await send('2\r');
    await send('1\r');
    await send('1\r');
    assert.equal(currentScreen, 'Browser mode');
    await send('1\r');
    assert.equal(currentScreen, 'Batch review');
    await send('\r');
    await viewed;
    await setImmediate();
    assert.equal(currentScreen, 'CoviPanel | Fixture');
    // A CRLF can reach the raw viewer and recreated line prompt separately.
    await send('\n');
    assert.equal(currentScreen, 'CoviPanel | Fixture');
    await send('1\r');
    assert.equal(currentScreen, 'Browser mode');
    await send('2\r');
    assert.equal(starts, 2);
    f.input.emit('keypress', '', { name: 'escape' });
    await viewed;
    await setImmediate();
    assert.equal(currentScreen, 'CoviPanel | Fixture');
    await send('\r');
    assert.equal(currentScreen, 'CoviPanel | Fixture');
    await send('0\r');
    assert.match(currentScreen, /Screening$/);
    await send('0\r');
    await menu;
  } finally {
    terminal?.close();
  }
});

test('viewer waits for native input to stop before restoring keyboard mode', async () => {
  for (const paused of [false, true]) {
    const f = terminalFixture();
    if (paused) f.input.pause();
    let reading = true;
    const restores = [];
    // process.stdin stops its native read one nextTick after a pause event.
    f.input.on('pause', () => {
      process.nextTick(() => {
        if (f.input.isPaused()) reading = false;
      });
    });
    f.input.setRawMode = (raw) => {
      if (!raw) restores.push({ reading });
      f.input.isRaw = raw;
    };
    const pending = reviewBatch('Fixture', [['Finished batch']], f);
    await setImmediate();
    f.input.write('\r');
    assert.equal(await pending, true);
    assert.deepEqual(restores, [{ reading: false }]);
    assert.equal(f.input.isPaused(), paused);
    assert.equal(f.input.listenerCount('keypress'), 0);
    const terminal = createTerminal(f);
    try {
      const answer = terminal.question('Project choice: ');
      f.input.write('1\r');
      assert.equal(await answer, '1');
    } finally {
      terminal.close();
    }
  }
});

test('real arrow sequences navigate, scroll the full rationale, resize and restore the next prompt', async () => {
  const f = terminalFixture();
  // Match the launcher closing its prompt before entering the viewer.
  createTerminal(f).close();
  const pending = reviewBatch(
    'Fixture',
    [
      ['First study', ...Array.from({ length: 24 }, (_, i) => `Rationale line ${i + 1}`)],
      ['Second study', 'Decision: Maybe'],
    ],
    f,
  );
  assert.equal(f.input.isRaw, true);
  assert.match(f.screen(), /Study 1\/2/);
  assert.match(f.screen(), /Enter\/Esc: back/);
  f.input.write('\x1b[D');
  assert.match(f.screen(), /Study 1\/2/);
  f.input.write('\x1b[C');
  assert.match(f.screen(), /Study 2\/2/);
  assert.match(f.screen(), /Decision: Maybe/);
  f.input.write('\x1b[C');
  assert.match(f.screen(), /Study 2\/2/);
  f.input.write('\x1b[D');
  for (let i = 0; i < 30; i++) f.input.write('\x1b[B');
  assert.match(f.screen(), /Rationale line 24/);
  f.output.rows = 16;
  f.output.emit('resize');
  assert.match(f.screen(), /Rationale line 24/);
  assert.equal(f.screen().split('\r\n').length, 16);
  f.input.write('\x1b[A');
  assert.doesNotMatch(f.screen(), /Rationale line 24/);
  f.input.write('\x1b[C\x1b[D');
  assert.match(f.screen(), /First study/);
  f.input.write('\r');
  assert.equal(await pending, true);
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.listenerCount('keypress'), 0);
  assert.equal(f.output.listenerCount('resize'), 0);
  const terminal = createTerminal(f);
  try {
    const answer = terminal.question('Next: ');
    f.input.write('ready\r');
    assert.equal(await answer, 'ready');
  } finally {
    terminal.close();
  }
});

test('exit and unavailable-terminal paths do not hang or leave raw keyboard listeners', async () => {
  for (const key of ['escape', 'c']) {
    const f = terminalFixture();
    const pending = reviewBatch('Fixture', [['Only study']], f);
    f.input.emit('keypress', '', { name: key, ctrl: key === 'c' });
    assert.equal(await pending, true);
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('keypress'), 0);
  }
  const f = terminalFixture();
  assert.equal(await reviewBatch('Empty', [], f), false);
  f.input.isTTY = false;
  assert.equal(await reviewBatch('Pipe', [['study']], f), false);
});

test('new and resumed successful batches open review; failures and unfinished work keep their status prompt', async () => {
  for (const resumed of [false, true]) {
    for (const outcome of ['finished', 'paused', 'failed']) {
      const { file, config, store } = await fixture();
      if (resumed) store.create(config, ['1'], 'recommend-only');
      store.close();
      const prompts = [],
        reviewed = [];
      const answers = resumed ? [''] : ['y', ''];
      await startScreening(
        { name: 'Fixture', reviewUrl: config.reviewUrl },
        async (prompt) => {
          prompts.push(prompt);
          return answers.shift();
        },
        {
          databaseFile: file,
          load: async () => config,
          show: () => {},
          chooseBrowserMode: async () => 'headless',
          discover: async () => ({ result: { studies: [{ studyId: '1' }] } }),
          run: async (_script, args) => {
            if (outcome === 'finished') {
              const queue = new QueueStore(file);
              try {
                queue.update(args[2], '1', 'recommended', {});
              } finally {
                queue.close();
              }
            }
            return outcome === 'failed' ? 1 : 0;
          },
          reviewBatch: async (ids) => {
            reviewed.push(...ids);
            return true;
          },
        },
      );
      assert.equal(reviewed.length, outcome === 'finished' ? 1 : 0);
      const returnPrompts = prompts.filter((p) => p.includes('return to this project'));
      assert.equal(returnPrompts.length, outcome === 'finished' ? 0 : 1);
      if (outcome === 'failed') assert.match(returnPrompts[0], /reason is shown above/);
    }
  }
});
