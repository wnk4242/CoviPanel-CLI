import { initializeSettings, assertSupportedNode } from './setup.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createTerminal } from './terminal-input.js';
import { spawn } from 'node:child_process';
import { projectDir, programDir, databasePath, dataDir } from './config.js';
import { showScreen } from './terminal-screen.js';
import { runMainMenu } from './project-menu.js';

let terminal;
const question = async (text) => {
  terminal ||= createTerminal();
  return (await terminal.question(text)).trim();
};
async function run(script, args = []) {
  terminal?.close();
  terminal = null;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectDir, script), ...args], {
      cwd: programDir,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
async function exportHistory(project) {
  const { acquireWorkerLock } = await import('./queue-store.js');
  const { exportProjectHistory } = await import('./history-export.js');
  const release = await acquireWorkerLock(dataDir);
  let result;
  try {
    result = await exportProjectHistory(databasePath, project.reviewUrl);
  } finally {
    await release();
  }
  showScreen(
    `CoviPanel | ${project.name}`,
    [
      'Decision History.xlsx and Screening Log.txt saved.',
      result.output,
      `${result.history.studies.length} studies in the project history.`,
    ],
    '',
  );
  await question('Press Enter to return to this project. ');
}
async function chooseBrowserMode() {
  showScreen(
    'CoviPanel | Browser mode',
    [
      '1. Visible browser — see Chromium; log in if needed',
      '2. Headless — no browser window; reuse saved login',
    ],
    '',
  );
  const choice = await question('Choose 1 or 2 (Enter cancels): ');
  return choice === '1' ? 'visible' : choice === '2' ? 'headless' : null;
}
async function editProject(project) {
  const { projectSettings } = await import('./settings.js');
  const { readProject } = await import('./projects.js');
  await projectSettings(question, {
    readCurrent: async () => (await readProject(project.reviewUrl)).settings,
    lockedReview: project.reviewUrl,
  });
  return readProject(project.reviewUrl);
}
async function openProject(project) {
  await mkdir(project.folder, { recursive: true });
  console.log(project.folder);
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [project.folder], {
      shell: false,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => console.log('Open the project folder using the path above.'));
    child.unref();
  }
  await question('Press Enter to return to this project. ');
}
try {
  assertSupportedNode();
  if (!process.stdin.isTTY)
    throw new Error('Open Start CoviPanel.cmd to use the interactive launcher.');
  await initializeSettings();
  await runMainMenu(question, {
    cleanup: async () => {
      const { showCleanup } = await import('./cleanup.js');
      await showCleanup(question);
    },
    create: async () => {
      const { createProject } = await import('./project-setup.js');
      return createProject(question);
    },
    list: async () => {
      const { listProjects } = await import('./projects.js');
      const projects = await listProjects();
      if (!projects.length) return projects;
      showScreen('CoviPanel | Saved screenings', ['Refreshing your Covidence totals…'], '');
      const { syncCovidenceProgress } = await import('./covidence-progress.js');
      const { reviewKey } = await import('./project-history.js');
      const results = await syncCovidenceProgress(projects);
      return (await listProjects()).map((project) => ({
        ...project,
        syncError: results.get(reviewKey(project.reviewUrl))?.error,
      }));
    },
    start: async (project) => {
      const { startScreening } = await import('./screening-session.js');
      return startScreening(project, question, {
        chooseBrowserMode,
        run,
        reviewBatch: async (jobIds) => {
          const { reviewCompletedBatches } = await import('./rationale-editor.js');
          const { QueueStore, acquireWorkerLock } = await import('./queue-store.js');
          const { awaitingBatchConfirmation } = await import('./review-decisions.js');
          const { reviewPendingBatch } = await import('./batch-approval.js');
          const { loadProject } = await import('./projects.js');
          const store = new QueueStore(databasePath);
          let pending;
          try {
            pending = jobIds.filter((id) =>
              awaitingBatchConfirmation(store.items(id), store.job(id).mode),
            );
          } finally {
            store.close();
          }
          terminal?.close();
          terminal = null;
          if (pending.length)
            return reviewPendingBatch(project.name, databasePath, pending, {
              folder: project.folder,
              lock: () => acquireWorkerLock(dataDir),
              load: loadProject,
            });
          return reviewCompletedBatches(project.name, databasePath, jobIds, {
            folder: project.folder,
            lock: () => acquireWorkerLock(dataDir),
          });
        },
      });
    },
    settings: editProject,
    search: async (project) => {
      const { searchProjectHistory } = await import('./study-search.js');
      const { acquireWorkerLock } = await import('./queue-store.js');
      terminal?.close();
      terminal = null;
      await searchProjectHistory(project, databasePath, {
        lock: () => acquireWorkerLock(dataDir),
      });
    },
    unfinished: async (project) => {
      const { reviewUnfinished } = await import('./unfinished-review.js');
      await reviewUnfinished(project, question, {
        run,
        chooseBrowserMode,
        view: async (lines) => {
          const { reviewBatch } = await import('./batch-review.js');
          terminal?.close();
          terminal = null;
          await reviewBatch(project.name, [lines], { statusLabel: 'Unfinished study' });
        },
      });
    },
    delete: async (project) => {
      const { deleteProject } = await import('./project-backups.js');
      return deleteProject(project.reviewUrl);
    },
    export: exportHistory,
    open: openProject,
    backup: async (project) => {
      const { backupProject } = await import('./project-backups.js');
      const result = await backupProject(project.reviewUrl);
      showScreen(
        `CoviPanel | ${project.name}`,
        [
          'Project backup created and verified.',
          result.file,
          `${result.jobs} saved screening groups; ${result.claims} duplicate-vote claims.`,
          'Includes this project’s settings and saved screening records.',
        ],
        '',
      );
      await question('Press Enter to return to this project. ');
    },
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  terminal?.close();
}
