import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function readClipboard() {
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-STA',
      '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-Clipboard -Raw',
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return stdout.replace(/\r?\n$/, '');
}

// Legacy Windows consoles can deliver Ctrl+V to Node instead of pasting text.
// Read the clipboard only for that explicit keystroke and only while a prompt is active.
export function createTerminal({
  input = process.stdin,
  output = process.stdout,
  platform = process.platform,
  clipboard = readClipboard,
} = {}) {
  const terminal = createInterface({ input, output });
  const ask = terminal.question.bind(terminal);
  let prompt = 0,
    active = 0,
    pasting = false;
  terminal.question = async (...args) => {
    const token = ++prompt;
    active = token;
    try {
      return await ask(...args);
    } finally {
      if (active === token) active = 0;
    }
  };
  const paste = async (_text, key) => {
    if (!active || pasting || !key?.ctrl || key.name !== 'v') return;
    const token = active;
    pasting = true;
    try {
      const value = await clipboard();
      if (active === token && !terminal.closed)
        terminal.write(
          String(value)
            .replace(/[\r\n\t]+/g, ' ')
            // eslint-disable-next-line no-control-regex -- Strip terminal control characters from display/pasted text.
            .replace(/[\x00-\x1f\x7f-\x9f]/g, ''),
        );
    } catch {
      if (active === token && !terminal.closed) {
        output.write('\nCould not read the clipboard. Try right-click to paste.\n');
        terminal.prompt(true);
      }
    } finally {
      pasting = false;
    }
  };
  if (platform === 'win32') input.on('keypress', paste);
  terminal.once('close', () => {
    active = 0;
    input.off('keypress', paste);
  });
  return terminal;
}
