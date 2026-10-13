import path from 'node:path';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectDir } from './config.js';
import { acquireWorkerLock } from './queue-store.js';
import { showScreen } from './terminal-screen.js';

const run = promisify(execFile);
const caches = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
];

// Never follow a junction/symlink, including in an ancestor of an allowed file.
async function ordinaryPath(root, relative) {
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink() || (await realpath(current)) !== current)
      throw new Error('A cleanup path is linked elsewhere. No cleanup was started.');
  }
  return current;
}

export async function previewCleanup(root) {
  root = await realpath(root);
  const files = [];
  async function collect(relative, category) {
    const file = await ordinaryPath(root, relative);
    if (!file) return;
    const info = await lstat(file);
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort())
        await collect(path.join(relative, name), category);
    } else if (info.isFile()) {
      files.push({
        relative,
        category,
        bytes: info.size,
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
        ino: info.ino,
      });
    } else throw new Error('An unsupported cleanup file was found. No cleanup was started.');
  }
  for (const base of ['Setups/Browser Login', 'Setups/Browser Login/Default'])
    for (const name of caches)
      await collect(path.normalize(`${base}/${name}`), name === 'Cache' ? 'pages' : 'code');
  const debug = await ordinaryPath(root, path.normalize('Setups/debug.log'));
  if (debug && (await lstat(debug)).isFile())
    await collect(path.normalize('Setups/debug.log'), 'debug');
  return { root, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function applyCleanup(preview) {
  const current = await previewCleanup(preview.root);
  if (JSON.stringify(current) !== JSON.stringify(preview))
    throw new Error(
      'The disposable files changed during the preview. Open cleanup again; nothing was removed.',
    );
  let bytes = 0,
    count = 0;
  for (const item of current.files) {
    const file = await ordinaryPath(current.root, item.relative);
    if (!file) throw new Error('A disposable file changed. Open cleanup again.');
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.size !== item.bytes ||
      info.mtimeMs !== item.mtime ||
      info.ctimeMs !== item.ctime ||
      info.ino !== item.ino
    )
      throw new Error('A disposable file changed. Open cleanup again.');
    // Delete only the previewed file, never a directory or a newly created file.
    try {
      await unlink(file);
    } catch (error) {
      throw new Error(
        `Cleanup stopped after freeing ${cleanupSize(bytes)}. Some disposable files could not be removed; close the browser and try again. Screening records, login and backups were kept.`,
        { cause: error },
      );
    }
    bytes += item.bytes;
    count++;
  }
  return { bytes, count };
}

export async function assertBrowserClosed(
  root,
  { platform = process.platform, execute = run } = {},
) {
  const profile = path.join(root, 'Setups', 'Browser Login').replaceAll('\\', '/').toLowerCase();
  let commands;
  try {
    const options = { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 };
    if (platform === 'win32') {
      const script =
        "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chromium.exe' OR Name='headless_shell.exe' OR Name='msedge.exe'\" | ForEach-Object { $_.CommandLine })";
      const { stdout } = await execute(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        options,
      );
      commands = JSON.parse(stdout.trim());
      if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string'))
        throw new Error('Unreadable browser process');
    } else {
      const { stdout } = await execute('ps', ['-ax', '-o', 'command='], options);
      commands = stdout.split('\n');
    }
  } catch {
    throw new Error(
      'Could not confirm that the browser is closed. No files were removed. Close CoviPanel browser windows and try again.',
    );
  }
  if (commands.some((command) => command.replaceAll('\\', '/').toLowerCase().includes(profile)))
    throw new Error(
      'This copy’s browser is still running. Close it before cleaning; no files were removed.',
    );
}

export const cleanupSize = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;

export async function showCleanup(
  question,
  { root = projectDir, show = showScreen, browserCheck = assertBrowserClosed } = {},
) {
  root = await realpath(root);
  const releases = [];
  try {
    await ordinaryPath(root, path.normalize('Setups/State/Maintenance'));
    // Sync takes the same outer lock for its entire run; the worker lock also
    // excludes screening, count refresh, exports and the login browser.
    releases.push(await acquireWorkerLock(path.join(root, 'Setups', 'State', 'Maintenance')));
    releases.push(await acquireWorkerLock(path.join(root, 'Setups', 'State')));
    await browserCheck(root);
    const preview = await previewCleanup(root);
    const size = (category) =>
      cleanupSize(
        preview.files
          .filter((file) => file.category === category)
          .reduce((sum, file) => sum + file.bytes, 0),
      );
    show(
      'CoviPanel | Clean temporary files',
      [
        `Space you can free: ${cleanupSize(preview.bytes)}`,
        '',
        'Will remove:',
        `- Downloaded website cache (${size('pages')}).`,
        `- Website code and graphics cache (${size('code')}).`,
        `- Disposable debug log (${size('debug')}).`,
        '',
        'Will keep:',
        '- All screening records, AI responses and your edits.',
        '- Project settings, spreadsheets and screening logs.',
        '- Your saved browser login, cookies and session data.',
        '- Your latest recovery backup and all other backups.',
        '- Program files and installed libraries.',
        '',
        'Caches rebuild as you use Covidence, including headless mode.',
        `Only this copy on ${path.parse(root).root} will be cleaned.`,
      ],
      preview.files.length
        ? 'Type y or yes to confirm. Enter or No cancels.'
        : 'No disposable files found.',
    );
    if (!preview.files.length) {
      await question('Press Enter to return to the main menu. ');
      return { cancelled: true };
    }
    const answer = (await question('Clean these files? [y/N]: ')).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) return { cancelled: true };
    await browserCheck(root);
    const result = await applyCleanup(preview);
    show(
      'CoviPanel | Cleanup completed',
      [
        `Removed ${result.count} disposable ${result.count === 1 ? 'file' : 'files'}; freed ${cleanupSize(result.bytes)}.`,
        '- Screening records, settings and exports were kept.',
        '- Saved login and all backups were kept.',
        '- Browser caches will rebuild when needed.',
      ],
      '',
    );
    await question('Press Enter to return to the main menu. ');
    return result;
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
