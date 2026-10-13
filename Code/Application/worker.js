import { resetUnfinished, confirmManualReset } from './reset-unfinished.js';
import { verifyResetVote } from './reset-verification.js';
import { recoverBeforeClick } from './recovery.js';
import { reparseRecommendation } from './recommendation.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createTerminal } from './terminal-input.js';
import { stdin, stdout } from 'node:process';
import { browserLibrary } from './dependencies.js';
import {
  projectDir,
  profileDir,
  databasePath,
  dataDir,
  reviewFolder,
  activeProfile,
  projectLabel,
} from './config.js';
import { loadProfile, uuidPattern } from './profiles.js';
import { createOpenAIClient } from './openai.js';
import { QueueStore, parseIds, acquireWorkerLock } from './queue-store.js';
import { exportProjectHistory } from './history-export.js';
import { readProjectHistory, writeProjectLog } from './project-history.js';
import { withRecords } from './records.js';
import { runBrowserQueue } from './browser-queue.js';
import { queueOperations, existingVote } from './queue-operations.js';
import { openAuditForVerification } from './audit.js';
import { verifyRecordedVote } from './vote.js';
import { showScreen } from './terminal-screen.js';
import { browserOptions, openReviewBrowser } from './browser-mode.js';
import { finishedItem, requiresReview } from './states.js';
import { awaitingBatchConfirmation, preparedItem } from './review-decisions.js';
import { loadProject } from './projects.js';

function argumentsFor(args) {
  const [command, ...rest] = args;
  const allowed = {
    start: ['--ids', '--file', '--profile', '--mode', '--references', '--browser'],
    resume: ['--job', '--mode', '--browser'],
    status: ['--job'],
    recover: ['--job', '--study', '--reason'],
    reparse: ['--job', '--study'],
    skip: ['--job', '--study', '--reason'],
    'retry-api': ['--job', '--study', '--reason'],
    recheck: ['--job', '--study', '--browser'],
    reset: ['--job', '--study', '--browser'],
  };
  if (!allowed[command])
    throw new Error(
      'Commands: start, resume, status, recover, reparse, skip, retry-api, recheck, reset. Use the interactive launcher for guided screening.',
    );
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !allowed[command].includes(rest[i]) ||
      options[rest[i].slice(2)] !== undefined ||
      !rest[i + 1]
    )
      throw new Error('Invalid, duplicate, or incomplete arguments.');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (command === 'start') {
    if (Boolean(options.ids) === Boolean(options.file))
      throw new Error('Supply exactly one of --ids or --file.');
  } else if (!uuidPattern.test(options.job || '')) throw new Error('Supply --job <UUID>.');
  if (
    ['skip', 'retry-api', 'recheck', 'recover', 'reparse', 'reset'].includes(command) &&
    !/^#?[1-9]\d*$/.test(options.study || '')
  )
    throw new Error('Supply one --study ID.');
  if (options.study) options.study = options.study.replace(/^#/, '');
  if (['skip', 'retry-api', 'recover'].includes(command) && !options.reason?.trim())
    throw new Error('Supply --reason describing your review.');
  return { command, ...options };
}

const baseDir = dataDir;
let store, release, browserSession, terminal, job, config;
let stopping = false;
const stop = () => {
  stopping = true;
  console.log('\nStop requested. Finishing the current checkpoint; no next study will start.');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const args = argumentsFor(process.argv.slice(2));
  const browserMode = args.browser || 'visible';
  browserOptions(browserMode);
  release = await acquireWorkerLock(baseDir);
  store = new QueueStore(path.join(baseDir, 'screening.sqlite'));
  if (args.command === 'start') {
    const ids = parseIds(args.ids || (await readFile(path.resolve(projectDir, args.file), 'utf8')));
    config = await loadProfile(args.profile || activeProfile(), ids[0]);
    let references = {};
    if (args.references) {
      references = JSON.parse(await readFile(path.resolve(projectDir, args.references), 'utf8'));
      if (
        !references ||
        Array.isArray(references) ||
        typeof references !== 'object' ||
        Object.entries(references).some(
          ([id, value]) => !ids.includes(id) || !['Include', 'Exclude', 'Maybe'].includes(value),
        )
      )
        throw new Error('Reference JSON must map queued study IDs to Include, Exclude, or Maybe.');
    }
    if (args.mode && args.mode !== 'review-all')
      throw new Error(
        'Command-line v1.0 screening uses review-all: recommend, confirm, then submit.',
      );
    job = store.create(config, ids, 'review-all', references);
  } else job = store.job(args.job);
  if (args.command === 'resume' && args.mode) {
    if (args.mode !== 'review-all')
      throw new Error('Command-line v1.0 screening supports only review-all mode.');
  }
  const label = projectLabel(job.review_url);
  console.log(label);
  const exportReport = async ({ quiet = false } = {}) => {
    await exportProjectHistory(databasePath, job.review_url);
    if (!quiet)
      console.log(
        `Decisions and rationales saved in ${path.basename(reviewFolder(job.review_url))}: Decision History.xlsx and Screening Log.txt.`,
      );
  };
  const printStatus = () => {
    const items = store.items(job.id),
      counts = {};
    for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1;
    showScreen(
      'CoviPanel | Screening status',
      [
        label,
        '',
        ...Object.entries(counts).flatMap(([state, count]) => [
          `${state}: ${count}`,
          items
            .filter((item) => item.state === state)
            .map((item) => `#${item.study_id}`)
            .join(', '),
        ]),
        ...items
          .filter((i) => i.data.error)
          .slice(0, 3)
          .map((i) => `Study #${i.study_id}: ${i.data.error}`),
      ],
      '',
    );
    console.log('');
  };
  if (args.command === 'status') {
    printStatus();
    await exportReport();
  } else {
    config ||=
      store.settings(job.id) || (await loadProfile(job.profile, store.items(job.id)[0].study_id));
    if (config.configHash !== job.config_hash)
      throw new Error(
        'Review criteria/settings changed since this job was created. Create a new job.',
      );
    if (['start', 'resume'].includes(args.command)) {
      const current = await loadProject(job.review_url);
      if (current.configHash !== job.config_hash)
        throw new Error(
          'Project settings changed. This older batch is retained for audit; start screening with current settings.',
        );
      if (job.mode !== 'review-all') job = store.enableBatchReview(job.id);
    }
    if (['skip', 'retry-api', 'recover', 'reparse'].includes(args.command)) {
      store.recover(job.id);
      const item = store.item(job.id, args.study);
      if (!requiresReview(item.state))
        throw new Error('Only an error or needs_review item can be reviewed this way.');
      if (args.command === 'skip')
        store.update(job.id, args.study, 'skipped', { ...item.data, reviewReason: args.reason });
      else if (args.command === 'recover')
        recoverBeforeClick(store, job, config, args.study, args.reason);
      else if (args.command === 'reparse') {
        const runId = item.data.recommendationRecord?.runId || item.data.previousRecommendationId;
        const recommendation = await reparseRecommendation(
          databasePath,
          { ...config, studyId: args.study },
          runId,
        );
        store.update(job.id, args.study, 'recommended', {
          ...item.data,
          recommendationRecord: recommendation.record,
          recommendationRef: recommendation.ref,
          stage: 'recommended',
          error: null,
          reviewReason: 'Reprocessed a saved AI response locally; no API call.',
        });
      } else {
        if (item.data.voteRecord || (await existingVote(config, args.study)))
          throw new Error(
            'A vote attempt exists. Use recover for pre-click attempts or recheck for possible submissions; retry-api cannot clear it.',
          );
        if (!stdin.isTTY)
          throw new Error(
            'Interactive confirmation is required to repeat a possibly billable request.',
          );
        terminal = createTerminal({ input: stdin, output: stdout });
        const phrase = `RETRY API ${args.study}`;
        if (
          (
            await terminal.question(
              `A prior request may already have been billed. Type "${phrase}" to reset this item, or anything else to cancel: `,
            )
          ).trim() === phrase
        ) {
          const previousRecommendationId =
            item.data.recommendationRecord?.runId || item.data.previousRecommendationId;
          store.update(job.id, args.study, 'pending', {
            referenceDecision: item.data.referenceDecision,
            reviewReason: args.reason,
            previousRecommendationId,
            retryApprovedRecommendationId: previousRecommendationId,
          });
        }
      }
      printStatus();
      await exportReport();
    } else if (
      args.command === 'resume' &&
      (store.items(job.id).every((item) => finishedItem(item, job.mode)) ||
        awaitingBatchConfirmation(store.items(job.id), job.mode))
    ) {
      const awaitingReview = awaitingBatchConfirmation(store.items(job.id), job.mode);
      if (!awaitingReview) printStatus();
      await exportReport({ quiet: awaitingReview });
    } else {
      if (!stdin.isTTY)
        throw new Error(
          'Run this worker in an interactive terminal for login and vote confirmations.',
        );
      terminal = createTerminal({ input: stdin, output: stdout });
      if (args.command === 'reset')
        showScreen(
          'CoviPanel | Check and reset',
          [
            `Review: ${config.reviewId}`,
            `Browser: ${browserMode}`,
            `Checking study #${args.study}`,
            '',
            'Opening Covidence for a read-only vote check. No screening or vote will start.',
          ],
          '',
        );
      const openBrowser = () =>
        openReviewBrowser({
          chromium: browserLibrary().chromium,
          profileDir,
          config,
          mode: browserMode,
          question: (q) => terminal.question(q),
          managedShutdown: true,
          onEvent: (event) =>
            withRecords(databasePath, (records) =>
              records.projectEvent(randomUUID(), job.review_url, 'browser_lifecycle', {
                jobId: job.id,
                ...event,
                message: `Browser event: ${event.kind.replaceAll('_', ' ')}.`,
              }),
            ),
        });
      terminal.setPrompt('');
      terminal.on('SIGINT', () => {
        stop();
        terminal.close();
      });
      if (args.command === 'reset') {
        const result = await resetUnfinished({
          store,
          job,
          studyId: args.study,
          config,
          folder: reviewFolder(job.review_url),
          shouldStop: () => stopping,
          verify: async (_page, settings, evidence) => {
            browserSession = await openBrowser();
            return verifyResetVote(browserSession.page, settings, evidence);
          },
          confirmManual: ({ studyId }) => confirmManualReset(studyId, (q) => terminal.question(q)),
        });
        console.log(result.message);
        if (result.outcome === 'kept') process.exitCode = 1;
        await exportReport();
        // Keep the concrete reset result visible instead of replacing it with a status screen.
      } else if (args.command === 'recheck') {
        browserSession = await openBrowser();
        const page = browserSession.page;
        const item = store.items(job.id).find((row) => row.study_id === args.study);
        if (!item) throw new Error('Study is not in this queue.');
        const prior = await existingVote(config, args.study);
        if (!prior) throw new Error('No submission claim exists for this study.');
        const audit = await openAuditForVerification(databasePath, prior.record.attemptId);
        try {
          const r = audit.record;
          const result = await verifyRecordedVote(
            page,
            { ...config, studyId: args.study },
            r,
            r.beforeHistory,
            r.verificationUrls,
          );
          const voteComparison = result.recordedVote
            ? result.recordedVote === r.expectedButton
              ? 'match'
              : 'mismatch'
            : 'unverifiable';
          const voteRecord = await audit.save({
            ...result,
            voteComparison,
            status:
              voteComparison === 'match'
                ? 'confirmed'
                : voteComparison === 'mismatch'
                  ? 'mismatch'
                  : 'uncertain',
          });
          store.update(
            job.id,
            args.study,
            voteRecord.status === 'confirmed' ? 'completed' : 'needs_review',
            {
              ...item.data,
              voteRecord,
              voteRef: audit.ref,
              error: voteRecord.error || voteRecord.reason || null,
            },
          );
        } finally {
          await audit.close();
        }
      } else if (!stopping) {
        // Client creation is lazy: a fully cached queue needs no API credential/request.
        let client;
        const lazyClient = {
          responses: {
            create: (...params) => {
              client ||= createOpenAIClient();
              return client.responses.create(...params);
            },
          },
        };
        const totalItems = Object.values(store.counts(job.id)).reduce((a, b) => a + b, 0);
        const operationsForPage = (page) =>
          queueOperations({
            page,
            config,
            client: lazyClient,
            shouldStop: () => stopping,
            confirm: async (record, recommendation) => {
              const item = store.item(job.id, record.studyId);
              const current = await loadProject(job.review_url);
              if (current.configHash !== job.config_hash)
                throw new Error('Project settings changed before voting.');
              return (
                job.mode === 'review-all' &&
                !stopping &&
                Boolean(recommendation.humanReview?.confirmationId) &&
                recommendation.humanReview.confirmationId === item.data.batchApproval?.id
              );
            },
          });
        await runBrowserQueue({
          store,
          job,
          config,
          openBrowser,
          operationsForPage,
          shouldStop: () => stopping,
          log: (message) => {
            const items = store.items(job.id);
            const submitting = items.some((item) => item.data.batchApproval);
            const done = items.filter((item) =>
              submitting ? finishedItem(item, job.mode) : preparedItem(item, job.mode),
            ).length;
            showScreen(
              'CoviPanel | Screening',
              [
                `${done} of ${totalItems} ${submitting ? 'submitted / finished' : 'prepared'}`,
                submitting
                  ? 'Submitting your confirmed decisions'
                  : 'Preparing recommendations; no votes submitted',
                '',
                ...message.split(/\r?\n/),
              ],
              'Ctrl+C to stop. Completed votes will not be repeated.',
            );
          },
        });
      }
      if (args.command !== 'reset') {
        const awaitingReview = awaitingBatchConfirmation(store.items(job.id), job.mode);
        if (!awaitingReview) printStatus();
        await exportReport({ quiet: awaitingReview });
      }
      if (store.items(job.id).some((item) => requiresReview(item.state))) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`[Worker] ${error.message}`);
  process.exitCode = 1;
  if (job && store)
    try {
      withRecords(databasePath, (records) =>
        records.projectEvent(randomUUID(), job.review_url, 'worker_error', {
          error: error.message,
        }),
      );
      await writeProjectLog(readProjectHistory(databasePath, job.review_url));
    } catch {
      console.error('Could not update the screening log; existing saved records are retained.');
    }
} finally {
  try {
    terminal?.close();
    await browserSession?.close();
  } finally {
    try {
      store?.close();
    } finally {
      await release?.();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}
