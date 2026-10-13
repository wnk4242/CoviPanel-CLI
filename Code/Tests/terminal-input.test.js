import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createTerminal } from '../Application/terminal-input.js';

function fixture(clipboard) {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  output.isTTY = true;
  output.columns = 100;
  output.resume();
  return { input, terminal: createTerminal({ input, output, platform: 'win32', clipboard }) };
}
const paste = (input) => input.emit('keypress', '\x16', { ctrl: true, name: 'v' });

test('Ctrl+V pastes into the active prompt without auto-submitting or reading the clipboard at other times', async () => {
  let reads = 0;
  const { input, terminal } = fixture(async () => {
    reads++;
    return 'https://app.covidence.org/reviews/900001\r\n';
  });
  try {
    paste(input);
    assert.equal(reads, 0);
    const answer = terminal.question('Address: ');
    paste(input);
    await setImmediate();
    assert.equal(terminal.line.trim(), 'https://app.covidence.org/reviews/900001');
    assert.equal(reads, 1);
    input.write('\r');
    assert.equal((await answer).trim(), 'https://app.covidence.org/reviews/900001');
    const typed = terminal.question('Next: ');
    input.write('https://demo.covidence.org/reviews/160736\r');
    assert.equal(await typed, 'https://demo.covidence.org/reviews/160736');
    assert.equal(reads, 1);
  } finally {
    terminal.close();
  }
  assert.equal(input.listenerCount('keypress'), 0);
});

test('a slow clipboard response cannot paste into a later prompt', async () => {
  let resolveClipboard;
  const { input, terminal } = fixture(
    () =>
      new Promise((resolve) => {
        resolveClipboard = resolve;
      }),
  );
  try {
    const first = terminal.question('First: ');
    paste(input);
    input.write('\r');
    await first;
    const second = terminal.question('Second: ');
    resolveClipboard('stale text');
    await setImmediate();
    assert.equal(terminal.line, '');
    input.write('\r');
    await second;
  } finally {
    terminal.close();
  }
});
