import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenText } from '../Application/terminal-screen.js';

test('long study text fits the viewport and leaves the action on the last line', () => {
  const lines = screenText(
    'Study 1 of 10',
    ['Long title '.repeat(40), 'Rationale: ' + 'reason '.repeat(200)],
    'Ctrl+C to stop',
    60,
    20,
  ).split('\n');
  assert.equal(lines.length, 20);
  assert.ok(lines.every((l) => l.length <= 59));
  assert.equal(lines.at(-1), 'Ctrl+C to stop');
  assert.ok(lines.includes('Full details are saved in the decision history.'));
  assert.ok(!screenText('Test', ['bad\x1b[2Jtext'], '', 50, 10).includes('\x1b'));
});
