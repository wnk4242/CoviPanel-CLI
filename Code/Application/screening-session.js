import path from 'node:path';
import { databasePath } from './config.js';
import { QueueStore, acquireWorkerLock } from './queue-store.js';
import { runDiscovery } from './discover.js';
import { showScreen } from './terminal-screen.js';
import { finishedItem } from './states.js';
import { loadProject, pendingScreenings } from './projects.js';
import { awaitingBatchConfirmation } from './review-decisions.js';

export async function startScreening(
  project,
  question,
  {
    databaseFile = databasePath,
    load = loadProject,
    discover = runDiscovery,
    show = showScreen,
    chooseBrowserMode,
    run,
    reviewBatch = async () => false,
  } = {},
) {
  const config = await load(project.reviewUrl);
  let pending;
  const store = new QueueStore(databaseFile);
  try {
    pending = pendingScreenings(store, project);
  } finally {
    store.close();
  }
  const outdated = pending.filter((work) => work.config.configHash !== config.configHash);
  pending = pending.filter((work) => work.config.configHash === config.configHash);
  const settingsNotice = [
    'Using the current criteria and AI settings saved in Project settings.json.',
    ...(outdated.length
      ? [
          'Unfinished work with older settings is retained in history and will not be resumed here.',
          'Previous decisions are not changed. Only responses matching the current settings can be reused.',
        ]
      : []),
  ];
  const finish = async (jobIds, browserMode) => {
    const prepared = new QueueStore(databaseFile);
    try {
      if (
        !jobIds.length ||
        jobIds.some((id) => {
          const items = prepared.items(id),
            mode = prepared.job(id).mode;
          return (
            !awaitingBatchConfirmation(items, mode) &&
            items.some((item) => !finishedItem(item, mode))
          );
        })
      )
        return false;
    } finally {
      prepared.close();
    }
    const result = await reviewBatch(jobIds);
    if (!result?.confirmed) return Boolean(result);
    for (const id of jobIds) {
      const current = await load(project.reviewUrl);
      if (current.configHash !== config.configHash)
        throw new Error(
          'Project settings changed before submission. Saved batch approval is retained; no further votes submitted.',
        );
      const code = await run('Code/Application/worker.js', [
        'resume',
        '--job',
        id,
        '--browser',
        browserMode,
      ]);
      const check = new QueueStore(databaseFile);
      let complete;
      try {
        complete = check.items(id).every((item) => finishedItem(item, 'review-all'));
      } finally {
        check.close();
      }
      if (code !== 0 || !complete) {
        await question(
          'Submission paused. Progress and confirmation are saved. Press Enter to return to this project. ',
        );
        return true;
      }
    }
    await question('Batch submission finished. Press Enter to return to this project. ');
    return true;
  };
  if (pending.length) {
    // Resume only work that matches the current saved project settings.
    // Keep historical settings and responses intact for audit and recovery.
    pending.reverse().sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    const first = pending[0];
    const selectedStudies = new Set();
    const group = pending.filter((work) => {
      if (
        work.config.configHash !== first.config.configHash ||
        work.job.mode !== first.job.mode ||
        work.remaining.some((item) => selectedStudies.has(item.study_id))
      )
        return false;
      for (const item of work.remaining) selectedStudies.add(item.study_id);
      return true;
    });
    const browserMode = await chooseBrowserMode();
    if (!browserMode) return;
    show(
      `CoviPanel | ${project.name}`,
      [
        `${group.reduce((n, work) => n + work.remaining.length, 0)} unfinished screening entries found.`,
        'No votes will be submitted until you press C in batch review.',
        `Browser: ${browserMode}`,
        `Resuming at study #${first.remaining[0].study_id}.`,
        ...settingsNotice,
        'Recommendations first, then batch review. C confirms all decisions and starts submission.',
        'Previously confirmed batches resume their remaining submissions.',
      ],
      '',
    );
    let workerFailed = false,
      unfinished = false;
    const completedBatches = [];
    for (const work of group) {
      const current = await load(project.reviewUrl);
      if (current.configHash !== config.configHash)
        throw new Error('Project settings changed before continuation. Start screening again.');
      const before = new QueueStore(databaseFile);
      let ready;
      try {
        ready = awaitingBatchConfirmation(before.items(work.job.id), before.job(work.job.id).mode);
      } finally {
        before.close();
      }
      const code = ready
        ? 0
        : await run('Code/Application/worker.js', [
            'resume',
            '--job',
            work.job.id,
            '--browser',
            browserMode,
            ...(work.job.mode !== 'review-all' ? ['--mode', 'review-all'] : []),
          ]);
      const check = new QueueStore(databaseFile);
      try {
        const items = check.items(work.job.id);
        unfinished =
          !awaitingBatchConfirmation(items, check.job(work.job.id).mode) &&
          items.some((item) => !finishedItem(item, check.job(work.job.id).mode));
      } finally {
        check.close();
      }
      workerFailed = code !== 0;
      if (workerFailed || unfinished) break; // Includes a user-requested Ctrl+C stop.
      completedBatches.push(work.job.id);
    }
    // The worker already exports its checkpoints. Keep its result visible and
    // avoid rereading and rebuilding the entire history in the launcher.
    if (workerFailed || unfinished || !(await finish(completedBatches, browserMode)))
      await question(
        workerFailed
          ? 'Screening paused. The reason is shown above. Press Enter to return to this project. '
          : 'Progress saved. Press Enter to return to this project. ',
      );
    return;
  }
  const browserMode = await chooseBrowserMode();
  if (!browserMode) return;
  const mode = 'review-all';
  const { result } = await discover(question, console.log, {
    browserMode,
    config,
  });
  if (!result.studies.length) {
    await question('Press Enter to return to this project. ');
    return;
  }
  show(
    `CoviPanel | ${project.name}`,
    [
      `Review: ${config.reviewId}`,
      `Studies: ${result.studies.length}`,
      'No votes will be submitted until you press C in batch review.',
    ],
    '',
  );
  if (!['', 'y', 'yes'].includes((await question('Start screening? [Y/n]: ')).toLowerCase()))
    return;
  const release = await acquireWorkerLock(path.dirname(databaseFile));
  let queue, job;
  try {
    const current = await load(project.reviewUrl);
    if (current.configHash !== config.configHash)
      throw new Error('Project settings changed after discovery. Start screening again.');
    queue = new QueueStore(databaseFile);
    job = queue.create(
      { ...config, headless: browserMode === 'headless' },
      result.studies.map((study) => study.studyId),
      mode,
    );
  } finally {
    queue?.close();
    await release();
  }
  const code = await run('Code/Application/worker.js', [
    'resume',
    '--job',
    job.id,
    '--browser',
    browserMode,
  ]);
  if (code === 0 && (await finish([job.id], browserMode))) return;
  await question(
    code !== 0
      ? 'Screening paused. The reason is shown above. Press Enter to return to this project. '
      : 'Progress saved. Press Enter to return to this project. ',
  );
}
