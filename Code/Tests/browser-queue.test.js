import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { profileFile, decisionResponse } from './fixtures.js';
import { editableSettings } from '../Application/prompt-sections.js';
import { validateProfile } from '../Application/profiles.js';
import { QueueStore } from '../Application/queue-store.js';
import { queueOperations } from '../Application/queue-operations.js';
import { createAudit } from '../Application/audit.js';
import { withRecords } from '../Application/records.js';
import {
  runBrowserQueue,
  resumeBrowserInterruption,
  browserDisconnected,
} from '../Application/browser-queue.js';
import { observeBrowser, openReviewBrowser } from '../Application/browser-mode.js';

const closed = 'locator.waitFor: Target page, context or browser has been closed';
const study = (id) => ({
  ready: true,
  studyId: id,
  title: `Study ${id}`,
  abstract: 'Synthetic study.',
});

async function fixture(ids = ['127', '122', '90']) {
  const settings = editableSettings(JSON.parse(await readFile(profileFile('demo'), 'utf8')));
  settings.promptSections = {
    inclusion: 'Vitamin C treatment trials.',
    exclusion: 'Reviews.',
    responseFormat: 'Give a one-sentence rationale about your decision.',
  };
  const config = await validateProfile(settings, 'demo', '122');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'covipanel-browser-queue-'));
  const databasePath = path.join(directory, 'screening.sqlite'),
    store = new QueueStore(databasePath);
  const job = store.create(config, ids, 'auto-vote');
  if (ids.includes('127'))
    store.update(job.id, '127', 'completed', { voteRecord: { status: 'confirmed' } });
  const calls = { api: [], votes: [], opens: 0, closes: 0 };
  const client = {
    responses: {
      create: async (request) => {
        const id = JSON.parse(request.input).study.studyId;
        calls.api.push(id);
        return decisionResponse('Exclude', 'The study does not meet the criteria.');
      },
    },
  };
  const operationsForPage = () => {
    const operations = queueOperations({ config, databasePath, client });
    operations.extract = async (id) => study(id);
    operations.vote = async (id) => {
      calls.votes.push(id);
      return { record: { status: 'confirmed' } };
    };
    return operations;
  };
  const openBrowser = async () => ({
    page: { attempt: ++calls.opens },
    close: async () => {
      calls.closes++;
    },
  });
  return {
    store,
    job,
    config,
    databasePath,
    directory,
    client,
    calls,
    operationsForPage,
    openBrowser,
    log: () => {},
  };
}

test('a disconnection before a click reopens once, reuses GPT output and advances past completed studies', async () => {
  const f = await fixture();
  try {
    const operationsForPage = (page) => {
      const operations = f.operationsForPage(page);
      if (page.attempt === 1)
        operations.vote = async (id, recommendation, onCheckpoint) => {
          const audit = await createAudit(
            f.databasePath,
            { ...f.config, studyId: id, decision: 'Exclude', expectedButton: 'No' },
            onCheckpoint,
          );
          await audit.save({ status: 'blocked_before_click', error: closed });
          await audit.releaseWithoutClick();
          return audit;
        };
      return operations;
    };
    const items = await runBrowserQueue({ ...f, operationsForPage });
    assert.deepEqual(
      items.map((item) => item.state),
      ['completed', 'completed', 'completed'],
    );
    assert.deepEqual(f.calls, { api: ['122', '90'], votes: ['122', '90'], opens: 2, closes: 2 });
    assert.equal(items[1].data.reusedRecommendation, true);
    const oldVote = JSON.parse(f.store.db.prepare('SELECT record FROM votes').get().record);
    assert.equal(oldVote.status, 'cancelled');
    assert.equal(oldVote.error, closed);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM vote_claims').get().n, 0);
  } finally {
    f.store.close();
  }
});

test('a previously saved browser interruption resumes automatically using its retained answer', async () => {
  const f = await fixture(['122']);
  try {
    const response = await f
      .operationsForPage()
      .recommend('122', study('122'), null, async () => {});
    f.store.update(f.job.id, '122', 'error', {
      stage: 'extracting',
      error: closed,
      recommendationRecord: response.record,
    });
    const result = await runBrowserQueue(f);
    assert.equal(result[0].state, 'completed');
    assert.equal(result[0].data.reusedRecommendation, true);
    assert.deepEqual(f.calls, { api: ['122'], votes: ['122'], opens: 1, closes: 1 });
  } finally {
    f.store.close();
  }
});

test('repeated disconnections stop after one restart and preserve the next pending study', async () => {
  const f = await fixture(['122', '90']);
  try {
    const result = await runBrowserQueue({
      ...f,
      operationsForPage: () => ({
        ...f.operationsForPage(),
        extract: async () => {
          throw new Error(closed);
        },
      }),
    });
    assert.deepEqual(
      result.map((item) => item.state),
      ['error', 'pending'],
    );
    assert.deepEqual(f.calls, { api: [], votes: [], opens: 2, closes: 2 });
  } finally {
    f.store.close();
  }
});

test('startup browser disconnection retries once, including a nested headless access error', async () => {
  const f = await fixture(['122']);
  let launches = 0;
  try {
    await runBrowserQueue({
      ...f,
      openBrowser: async () => {
        launches++;
        if (launches === 1)
          throw new Error('Could not access the screening page.', { cause: new Error(closed) });
        return f.openBrowser();
      },
    });
    assert.equal(launches, 2);
    assert.equal(f.store.item(f.job.id, '122').state, 'completed');
  } finally {
    f.store.close();
  }
});

test('missing page controls and API failures do not trigger a browser restart or repeat a request', async () => {
  for (const failure of ['controls', 'api']) {
    const f = await fixture(['122']);
    try {
      if (failure === 'api')
        f.client.responses.create = async () => {
          f.calls.api.push('122');
          throw new Error('API unavailable');
        };
      const operationsForPage = () => {
        const operations = f.operationsForPage();
        if (failure === 'controls')
          operations.extract = async () => {
            throw new Error('Search studies field is ambiguous.');
          };
        return operations;
      };
      await runBrowserQueue({ ...f, operationsForPage });
      assert.equal(f.calls.opens, 1);
      assert.equal(f.calls.closes, 1);
      assert.deepEqual(f.calls.votes, []);
      await runBrowserQueue({ ...f, operationsForPage });
      assert.equal(f.calls.opens, 1);
      assert.equal(f.calls.api.length, failure === 'api' ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});

for (const status of ['click_intent', 'click_returned', 'uncertain', 'confirmed', 'mismatch']) {
  test(`a ${status} canonical vote cannot be reset by a browser-closed error`, async () => {
    const f = await fixture(['122']);
    try {
      const audit = await createAudit(f.databasePath, { ...f.config, studyId: '122' });
      const stale = { ...audit.record };
      await audit.save({ status, error: closed });
      f.store.update(f.job.id, '122', 'needs_review', {
        stage: 'voting',
        error: closed,
        voteRecord: stale,
      });
      assert.throws(
        () => resumeBrowserInterruption(f.store, f.job, f.config, f.store.item(f.job.id, '122')),
        /Submission may have started/,
      );
      assert.equal(
        withRecords(f.databasePath, (records) => records.existingVote(f.config, '122')).record
          .status,
        status,
      );
      assert.equal(f.store.item(f.job.id, '122').state, 'needs_review');
    } finally {
      f.store.close();
    }
  });
}

test('a disconnected browser after a possible submission is never automatically reopened or clicked again', async () => {
  const f = await fixture(['122', '90']);
  try {
    const operationsForPage = () => {
      const operations = f.operationsForPage();
      operations.vote = async (id, recommendation, checkpoint) => {
        const audit = await createAudit(f.databasePath, { ...f.config, studyId: id }, checkpoint);
        await audit.save({ status: 'uncertain', error: closed });
        return audit;
      };
      return operations;
    };
    const items = await runBrowserQueue({ ...f, operationsForPage });
    assert.deepEqual(
      items.map((item) => item.state),
      ['needs_review', 'pending'],
    );
    assert.equal(f.calls.opens, 1);
    assert.ok(withRecords(f.databasePath, (records) => records.existingVote(f.config, '122')));
  } finally {
    f.store.close();
  }
});

test('a requested stop does not reopen the browser or vote after the saved GPT answer arrives', async () => {
  const f = await fixture(['122']);
  let stopped = false;
  const create = f.client.responses.create;
  f.client.responses.create = async (...args) => {
    const result = await create(...args);
    stopped = true;
    return result;
  };
  try {
    const items = await runBrowserQueue({ ...f, shouldStop: () => stopped });
    assert.equal(items[0].state, 'recommended');
    assert.deepEqual(f.calls, { api: ['122'], votes: [], opens: 1, closes: 1 });
  } finally {
    f.store.close();
  }
});

test('browser lifecycle diagnostics distinguish crashes and closes and ignore intentional cleanup', async () => {
  const page = new EventEmitter(),
    browser = new EventEmitter(),
    context = new EventEmitter();
  context.pages = () => [page];
  context.browser = () => browser;
  context.close = async () => {
    page.emit('close');
    context.emit('close');
    browser.emit('disconnected');
  };
  const events = [],
    close = observeBrowser(context, (event) => events.push(event.kind));
  page.emit('crash');
  page.emit('close');
  browser.emit('disconnected');
  assert.deepEqual(events, ['page_crashed', 'page_closed', 'browser_disconnected']);
  await close();
  assert.equal(events.length, 3);
  assert.equal(page.listenerCount('crash'), 0);
  assert.equal(browser.listenerCount('disconnected'), 0);
});

test('worker browser launch delegates termination signals to the checkpoint controller', async () => {
  const config = { reviewUrl: 'https://demo.covidence.org/reviews/111', timeoutMs: 100 };
  let options;
  const context = {
    pages: () => [
      {
        setDefaultTimeout: () => {},
        goto: async () => {},
        url: () => config.reviewUrl,
        getByPlaceholder: () => ({ waitFor: async () => {} }),
      },
    ],
    close: async () => {},
  };
  const session = await openReviewBrowser({
    chromium: {
      launchPersistentContext: async (_profile, value) => {
        options = value;
        return context;
      },
    },
    profileDir: 'fixture',
    config,
    mode: 'visible',
    managedShutdown: true,
  });
  assert.deepEqual(options, { headless: false, handleSIGINT: false, handleSIGTERM: false });
  await session.close();
  assert.equal(browserDisconnected('Search studies field is ambiguous.'), false);
});
