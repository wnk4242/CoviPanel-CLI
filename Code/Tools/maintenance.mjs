import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectDir, programDir, dataDir, databasePath } from '../Application/config.js';
import { acquireWorkerLock } from '../Application/queue-store.js';
import { backupDatabase, restoreDatabase } from '../Application/backups.js';
import { createTerminal } from '../Application/terminal-input.js';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--from', '--to'].includes(args[i]) || !args[i + 1] || options[args[i]])
    throw new Error(
      'Usage: maintenance.mjs backup [--to file] | restore --from backup [--to new-file]',
    );
  options[args[i]] = path.resolve(projectDir, args[i + 1]);
}
if (
  !['backup', 'restore'].includes(command) ||
  (command === 'backup' && options['--from']) ||
  (command === 'restore' && !options['--from'])
)
  throw new Error('Choose backup or restore --from <backup file>.');
const release = await acquireWorkerLock(dataDir);
let terminal;
try {
  if (command === 'backup') {
    const destination =
      options['--to'] ||
      path.join(
        programDir,
        'Backups',
        `screening-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`,
      );
    const result = await backupDatabase(databasePath, destination);
    console.log(
      `Backup verified: ${result.file}\n${result.jobs} batches and ${result.claims} duplicate-vote claims. No browser or AI request.`,
    );
  } else {
    const destination = options['--to'] || databasePath;
    const active = path.resolve(destination) === path.resolve(databasePath);
    if (active) {
      if (!process.stdin.isTTY)
        throw new Error(
          'Restoring the active database requires an interactive terminal. Use --to for a new recovery file.',
        );
      terminal = createTerminal();
      if (
        (
          await terminal.question(
            'Restore this backup as the active screening database? A backup of the current database will be retained. Type RESTORE to proceed: ',
          )
        ).trim() !== 'RESTORE'
      )
        throw new Error('Restore cancelled.');
    }
    const result = await restoreDatabase(options['--from'], destination, { replace: active });
    console.log(
      `Restore verified: ${result.file}${result.previous ? `\nPrevious database preserved: ${result.previous}` : ''}\nCurrent project settings and login were not replaced. Restored batches retain their original settings. Do not replay votes made after the backup; reconcile them with Covidence History first.`,
    );
  }
} finally {
  terminal?.close();
  await release();
}
