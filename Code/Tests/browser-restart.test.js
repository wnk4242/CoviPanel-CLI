import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { browserLibrary } from '../Application/dependencies.js';
import { profileFile, decisionResponse } from './fixtures.js';
import { editableSettings } from '../Application/prompt-sections.js';
import { validateProfile } from '../Application/profiles.js';
import { QueueStore } from '../Application/queue-store.js';
import { queueOperations } from '../Application/queue-operations.js';
import { runBrowserQueue } from '../Application/browser-queue.js';
import { openReviewBrowser } from '../Application/browser-mode.js';
import { withRecords } from '../Application/records.js';

const { chromium } = browserLibrary();

test('a real Chromium closure during GPT processing resumes with one saved answer and one locally verified click', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'covipanel-real-browser-restart-'));
  const settings = editableSettings(JSON.parse(await readFile(profileFile('demo'), 'utf8')));
  settings.promptSections = {
    inclusion: 'Synthetic trial criteria.',
    exclusion: '',
    responseFormat: 'One sentence.',
  };
  const config = await validateProfile(settings, 'demo', '122');
  config.timeoutMs = 8000;
  const databasePath = path.join(directory, 'screening.sqlite');
  const store = new QueueStore(databasePath),
    job = store.create(config, ['127', '122'], 'auto-vote');
  store.update(job.id, '127', 'completed', { voteRecord: { status: 'confirmed' } });
  let calls = 0,
    clicks = 0,
    launches = 0,
    voted = null,
    activePage;
  const events = [];
  const isolatedBrowser = {
    launchPersistentContext: async (profile, options) => {
      launches++;
      const context = await chromium.launchPersistentContext(profile, options);
      await context.exposeBinding('recordFixtureVote', (_source, value) => {
        clicks++;
        voted = value;
      });
      // All browser requests are fulfilled locally; no Covidence connection.
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html>
        <input placeholder="Search studies"><div data-testclass="study" data-testid="Study #122 Study 122">
        <p>#122</p><h3>Study 122</h3><section>Abstract: Synthetic study.</section><button id="history">History</button>
        ${voted ? `<p>You voted ${voted}</p>` : ['Yes', 'No', 'Maybe'].map((value) => `<button data-pendo-key="vote-button">${value}</button>`).join('')}</div>
        <script>
        document.getElementById('history').onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-label','History');d.innerHTML='<h2>History</h2><h3>Study 122</h3><ol>${voted ? `<li>You voted ${voted}</li>` : ''}</ol><button>Done</button>';d.querySelector('button').onclick=()=>d.remove();document.body.append(d);};
        document.querySelectorAll('[data-pendo-key="vote-button"]').forEach(b=>b.onclick=async()=>{await window.recordFixtureVote(b.textContent);document.querySelector('[data-testclass="study"]').remove();});
        </script>`,
        }),
      );
      return context;
    },
  };
  const client = {
    responses: {
      create: async () => {
        calls++;
        // Reproduce the observed failure: browser vanishes while GPT is answering,
        // then a valid answer arrives before the first attempted browser action.
        await activePage.context().close();
        return decisionResponse('Exclude', 'The study does not meet the synthetic criteria.');
      },
    },
  };
  try {
    const items = await runBrowserQueue({
      store,
      job,
      config,
      openBrowser: async () => {
        const session = await openReviewBrowser({
          chromium: isolatedBrowser,
          profileDir: path.join(directory, 'Browser'),
          config,
          mode: 'headless',
          managedShutdown: true,
          question: () => assert.fail('No login on isolated fixture'),
          onEvent: (event) => events.push(event.kind),
        });
        activePage = session.page;
        return session;
      },
      operationsForPage: (page) =>
        queueOperations({
          page,
          config,
          databasePath,
          client,
          confirm: async () => true,
          shouldStop: () => false,
        }),
      log: () => {},
    });
    assert.deepEqual(
      items.map((item) => item.state),
      ['completed', 'completed'],
    );
    assert.equal(launches, 2);
    assert.equal(calls, 1);
    assert.equal(clicks, 1);
    assert.equal(items[1].data.reusedRecommendation, true);
    assert.equal(items[1].data.voteRecord.recordedVote, 'No');
    assert.equal(items[1].data.voteRecord.status, 'confirmed');
    assert.ok(events.includes('page_closed'));
    const votes = store.db
      .prepare('SELECT record FROM votes ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.record));
    assert.deepEqual(
      votes.map((v) => v.status),
      ['cancelled', 'confirmed'],
    );
    assert.equal(
      withRecords(databasePath, (records) => records.existingVote(config, '122')).record.status,
      'confirmed',
    );
  } finally {
    store.close();
  }
});
