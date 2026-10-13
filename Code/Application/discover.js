import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTerminal } from './terminal-input.js';
import { browserLibrary } from './dependencies.js';
import { projectDir, profileDir, dataDir, databasePath, activeProfile } from './config.js';
import { loadProfile } from './profiles.js';
import { existingVote } from './queue-operations.js';
import { savedDecisionIds } from './saved-decisions.js';
import { acquireWorkerLock, QueueStore } from './queue-store.js';
import { withRecords } from './records.js';
import { readProjectHistory, writeProjectLog } from './project-history.js';
import { discoverUnscreened } from './discovery.js';
import { showScreen } from './terminal-screen.js';
import { browserOptions, openReviewBrowser } from './browser-mode.js';

const defaultRuntime = {
  activeProfile,
  acquireWorkerLock,
  browserLibrary,
  browserOptions,
  dataDir,
  databasePath,
  discoverUnscreened,
  existingVote,
  loadProfile,
  openReviewBrowser,
  profileDir,
  QueueStore,
  randomUUID,
  savedDecisionIds,
  readProjectHistory,
  showScreen,
  withRecords,
  writeProjectLog,
};

export async function runDiscovery(
  question,
  log = console.log,
  { browserMode = 'visible', config: selectedConfig, runtime = defaultRuntime } = {},
) {
  const { chromium } = runtime.browserLibrary();
  runtime.browserOptions(browserMode);
  const config = selectedConfig || (await runtime.loadProfile(runtime.activeProfile(), '1'));
  const release = await runtime.acquireWorkerLock(runtime.dataDir);
  let context;
  try {
    runtime.showScreen(
      'CoviPanel | Detect studies',
      [
        `Browser: ${browserMode}`,
        browserMode === 'headless'
          ? 'Checking the saved login in the background…'
          : 'Opening Chromium for login and screening.',
      ],
      '',
    );
    const opened = await runtime.openReviewBrowser({
      chromium,
      profileDir: runtime.profileDir,
      config,
      mode: browserMode,
      question,
    });
    context = opened.context;
    const page = opened.page;
    const savedStore = new runtime.QueueStore(runtime.databasePath);
    let saved;
    try {
      saved = runtime.savedDecisionIds(savedStore.db, config.reviewUrl);
    } finally {
      savedStore.close();
    }
    const result = await runtime.discoverUnscreened(page, config, {
      savedDecision: (id) => saved.has(id),
      existingVote: (id) => runtime.existingVote(config, id),
      log,
      chooseCount: async (total) => {
        const max = Math.min(total, 10000);
        while (true) {
          runtime.showScreen(
            'CoviPanel | Studies to screen',
            [
              `${total.toLocaleString('en-US')} studies are awaiting your vote.`,
              `Up to ${max.toLocaleString('en-US')} studies at a time.`,
            ],
            '',
          );
          const input = (
            await question(
              `How many do you want to screen? 1–${max.toLocaleString('en-US')} (Enter cancels): `,
            )
          ).trim();
          if (!input) return null;
          if (/^\d+$/.test(input) && Number(input) >= 1 && Number(input) <= max)
            return Number(input);
          log(`Enter a whole number from 1 to ${max}. The current batch limit is 10,000.`);
        }
      },
    });
    runtime.withRecords(runtime.databasePath, (records) =>
      records.projectEvent(
        runtime.randomUUID(),
        config.reviewUrl,
        'discovery',
        result,
        result.discoveredAt,
      ),
    );
    await runtime.writeProjectLog(
      runtime.readProjectHistory(runtime.databasePath, config.reviewUrl),
    );
    if (result.cancelled) {
      log('Cancelled. No screening job created.');
      return { config, result };
    }
    if (
      !result.studies.length &&
      result.blocked.some((entry) => entry.reason?.includes('saved without submission'))
    )
      log(
        'No new studies available. Decisions saved without submission are excluded from new batches.',
      );
    if (result.total === 0) {
      log('No studies are awaiting your vote.');
      return { config, result };
    }
    return { config, result };
  } catch (error) {
    const store = new runtime.QueueStore(runtime.databasePath);
    store.close();
    runtime.withRecords(runtime.databasePath, (records) =>
      records.projectEvent(runtime.randomUUID(), config.reviewUrl, 'discovery_error', {
        error: error.message,
      }),
    );
    await runtime.writeProjectLog(
      runtime.readProjectHistory(runtime.databasePath, config.reviewUrl),
    );
    throw error;
  } finally {
    await context?.close();
    await release();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.join(projectDir, 'Code', 'Application', 'discover.js')
) {
  const terminal = createTerminal();
  try {
    if (!process.stdin.isTTY) throw new Error('Run discovery in an interactive terminal.');
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--browser'))
      throw new Error('Usage: npm run discover -- --browser visible|headless');
    await runDiscovery((q) => terminal.question(q), console.log, {
      browserMode: args[1] || 'visible',
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    terminal.close();
  }
}
