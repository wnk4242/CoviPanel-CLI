import path from 'node:path';
import { projectDir, databasePath, projectsDir } from '../Application/config.js';
import { backupProject, restoreProjectBackup } from '../Application/project-backups.js';
import { createTerminal } from '../Application/terminal-input.js';

const [command, ...args] = process.argv.slice(2);
const allowed =
  command === 'backup'
    ? ['--review', '--to']
    : command === 'restore'
      ? ['--from', '--database', '--projects']
      : [];
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.includes(args[i]) || !args[i + 1] || options[args[i]])
    throw new Error('Invalid project maintenance arguments.');
  options[args[i]] = args[i + 1];
}
if (command === 'backup' && options['--review']) {
  const result = await backupProject(options['--review'], {
    destination: options['--to'] ? path.resolve(projectDir, options['--to']) : undefined,
  });
  console.log(`Project backup verified: ${result.file}`);
} else if (command === 'restore' && options['--from']) {
  if (Boolean(options['--database']) !== Boolean(options['--projects']))
    throw new Error('For a separate recovery location, supply both --database and --projects.');
  const databaseFile = options['--database']
    ? path.resolve(projectDir, options['--database'])
    : databasePath;
  const root = options['--projects']
    ? path.resolve(projectDir, options['--projects'])
    : projectsDir;
  if (databaseFile === databasePath || root === projectsDir) {
    if (!process.stdin.isTTY)
      throw new Error(
        'Use an interactive terminal to restore into the current program, or supply --database and --projects for separate recovery files.',
      );
    const terminal = createTerminal();
    try {
      if (
        (
          await terminal.question(
            'Restore the selected project backup? Existing conflicting records will be preserved and the restore stopped. Type RESTORE: ',
          )
        ).trim() !== 'RESTORE'
      )
        throw new Error('Restore cancelled.');
    } finally {
      terminal.close();
    }
  }
  const result = await restoreProjectBackup(path.resolve(projectDir, options['--from']), {
    databaseFile,
    root,
  });
  console.log(
    `Project restored: ${result.reviewUrl}\nSettings: ${result.settingsFile}\nOther projects were preserved. Check Covidence History for votes made after the backup before continuing.`,
  );
} else
  throw new Error(
    'Usage: project-maintenance.mjs backup --review <URL> [--to file] | restore --from <file> [--database file --projects folder]',
  );
