// Local-only native Windows terminal smoke check; no live project, browser or API.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { historySearchFixture } from '../Tests/Fixtures/history-search.js';
import { searchProjectHistory } from '../Application/study-search.js';
import { editableHistory } from '../Application/history-editor.js';
import { withRecords } from '../Application/records.js';
import { createTerminal } from '../Application/terminal-input.js';

assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'A real terminal is required.');
const fixture = await historySearchFixture();
await setTimeout(50);
await searchProjectHistory(fixture.project, fixture.file);
assert.equal(editableHistory(fixture.file, fixture.target).decision, 'Maybe');
assert.equal(editableHistory(fixture.file, fixture.target).explanation, 'Edited native note.');
assert.deepEqual(
  withRecords(fixture.file, (s) => s.recommendation(fixture.record.runId)).record,
  fixture.record,
);
assert.equal(
  withRecords(fixture.file, (s) => s.db.prepare('SELECT COUNT(*) n FROM votes').get().n),
  0,
);
await setTimeout(50);
const terminal = createTerminal();
assert.equal(await terminal.question('Project menu: choose 1 then one Enter: '), '1');
terminal.close();
console.log(
  'PASS: native study search, confirmed decision/rationale edits, retained AI response, zero votes, and first menu selection with one Enter.',
);
