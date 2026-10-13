import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { profileFile, decisionResponse } from './fixtures.js';
import { editableSettings, buildPrompt, promptTextLimit } from '../Application/prompt-sections.js';
import { editPromptSection } from '../Application/prompt-editor.js';
import { projectSettings, saveSettings } from '../Application/settings.js';
import { validateProfile } from '../Application/profiles.js';
import { buildRequest } from '../Application/openai.js';
import { parseRecommendation } from '../Application/ai-parser.js';
import {
  recommend,
  reparseRecommendation,
  loadRecommendation,
} from '../Application/recommendation.js';
import { QueueStore } from '../Application/queue-store.js';
import { queueOperations } from '../Application/queue-operations.js';
import { runQueue } from '../Application/queue-runner.js';
import { withRecords } from '../Application/records.js';
import { readProjectHistory } from '../Application/project-history.js';

const sections = {
  inclusion: 'Population: Adult participants.\n\nVitamin C treatment in a randomized trial.',
  exclusion: 'Reviews.\r\nQualitative-only studies.',
  responseFormat:
    'Follow exactly this format. No markdown.\nDecision: Include / Exclude / Maybe\nPopulation: exact abstract wording\nIntervention: exact abstract wording\nCondition: exact abstract wording\nStudyDesign: exact abstract wording\nRationale: brief explanation',
};
const study = {
  ready: true,
  studyId: '1',
  title: 'Synthetic treatment study',
  abstract: 'Adult participants completed a survey of symptom burden.',
};
const reply =
  'Decision: Include\nPopulation: Adult participants\nIntervention: vitamin C\nCondition: common cold\nStudyDesign: survey\nRationale: The three eligibility requirements are met.';
const response = (text = reply) => ({
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text }] }],
});
async function draftSettings() {
  const legacy = JSON.parse(await readFile(profileFile('demo'), 'utf8'));
  return { ...editableSettings(legacy), promptSections: { ...sections } };
}
async function config() {
  return validateProfile(await draftSettings(), 'demo', '1');
}

test('the entire instruction prompt is exactly the three user sections, even for title-only citations', async () => {
  const c = await config();
  const expected =
    'Inclusion criteria:\n' +
    sections.inclusion +
    '\n\nExclusion criteria:\n' +
    sections.exclusion +
    '\n\nResponse format:\n' +
    sections.responseFormat;
  assert.equal(buildPrompt(sections), expected);
  for (const source of [study, { ...study, abstract: '', abstractStatus: 'not_available' }]) {
    const request = buildRequest(c, source);
    assert.equal(request.instructions, expected);
    assert.deepEqual(Object.keys(request).sort(), [
      'input',
      'instructions',
      'max_output_tokens',
      'model',
      'store',
      'text',
    ]);
    const input = JSON.parse(request.input);
    assert.deepEqual(Object.keys(input), ['study']);
    assert.equal(input.study.abstract, source.abstract);
    for (const forbidden of [
      'interpretation',
      'evidenceChoices',
      'Not reported in abstract',
      'required JSON',
    ])
      assert.ok(!JSON.stringify(request).includes(forbidden), forbidden);
  }
});

test('all three sections affect cached decisions and approval; legacy snapshots stay unchanged', async () => {
  const converted = editableSettings({
    criteria: {
      inclusion: ['User inclusion'],
      exclusion: ['User exclusion'],
      interpretation: ['Old added interpretation'],
    },
  });
  assert.equal(converted.promptSections.inclusion, 'User inclusion');
  assert.ok(!JSON.stringify(converted).includes('Old added interpretation'));
  const draft = await draftSettings();
  const original = await config();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-three-save-'));
  const file = path.join(dir, 'settings.json');
  const legacy = await validateProfile(
    JSON.parse(await readFile(profileFile('demo'), 'utf8')),
    'demo',
    '1',
  );
  const store = new QueueStore(path.join(dir, 'screening.sqlite'));
  try {
    const job = store.create(legacy, ['1'], 'recommend-only');
    await saveSettings(draft, { file, baseDir: dir, loadCurrent: async () => legacy });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.promptSections, sections);
    for (const key of ['criteria', 'promptFile', 'responseFormat', 'responseInstructions'])
      assert.equal(saved[key], undefined);
    assert.deepEqual(store.settings(job.id), legacy);
    for (const key of Object.keys(sections)) {
      const changed = { ...sections, [key]: sections[key] + '\nChanged.' };
      assert.notEqual(
        (await validateProfile({ ...draft, promptSections: changed }, 'demo', '1')).configHash,
        original.configHash,
      );
      await assert.rejects(
        validateProfile({ ...saved, promptSections: changed }, 'demo', '1'),
        /since approval/,
      );
    }
    await assert.rejects(validateProfile({ ...draft, criteria: {} }, 'demo', '1'), /legacy prompt/);
    assert.throws(() => buildPrompt({ ...sections, interpretation: 'extra' }), /exactly three/);
    assert.ok(buildPrompt({ ...sections, responseFormat: '' }).endsWith('Response format:\n'));
    assert.throws(
      () => buildPrompt({ ...sections, inclusion: 'a'.repeat(promptTextLimit + 1) }),
      /characters/,
    );
  } finally {
    store.close();
  }
});

test('Notepad editing preserves long multiline text, blank lines and Unicode, with keep, cancel and clear', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'covipanel-edit-test-'));
  const long = '诊所 / treatment outcome\r\n\r\n'.repeat(800);
  let opened;
  const edit = async (key, text, changed, answer = '') =>
    editPromptSection(async () => answer, key, text, {
      tempRoot,
      show: () => {},
      open: async (file) => {
        opened = file;
        assert.equal(await readFile(file, 'utf8'), text);
        if (changed !== undefined) await writeFile(file, changed);
      },
    });
  assert.equal(await edit('inclusion', 'original', long), long);
  assert.equal(
    await edit('responseFormat', sections.responseFormat, undefined),
    sections.responseFormat,
  );
  assert.equal(await edit('inclusion', 'original', 'replacement', '/cancel'), null);
  assert.equal(await edit('exclusion', 'old exclusion', ''), '');
  assert.equal(await edit('responseFormat', 'old format', ''), '');
  await assert.rejects(edit('inclusion', 'original', ''), /cannot be empty/);
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('Unicode 诊所\r\nNext line', 'utf16le'),
  ]);
  assert.equal(await edit('inclusion', 'original', utf16), 'Unicode 诊所\r\nNext line');
  assert.ok(opened.startsWith(tempRoot + path.sep));
  assert.deepEqual(await readdir(tempRoot), []);
});

test('settings exposes three direct editors, saves their exact contents and has no response presets', async () => {
  const draft = await draftSettings();
  const inputs = ['3', '4', '5', '7'];
  const edited = [];
  let saved;
  const screens = [];
  await projectSettings(
    async () => {
      assert.ok(inputs.length);
      return inputs.shift();
    },
    {
      readCurrent: async () => draft,
      show: (_title, lines) => screens.push(lines.join('\n')),
      edit: async (_question, key, current) => {
        edited.push(key);
        return current + '\nUser edit';
      },
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
  );
  assert.deepEqual(edited, ['inclusion', 'exclusion', 'responseFormat']);
  for (const key of edited) assert.equal(saved.promptSections[key], sections[key] + '\nUser edit');
  assert.ok(
    screens.every(
      (screen) =>
        !/interpretation|Concise rationale|Detailed rationale|standard population|Additional screening/i.test(
          screen,
        ),
    ),
  );
  assert.ok(screens[0].includes('7. Save and continue'));
  assert.equal(inputs.length, 0);
});

test('historical custom responses retain the exact GPT text and accept either labeled lines or unambiguous JSON', () => {
  const c = { promptSections: sections };
  const parsed = parseRecommendation(response(), study, c, {});
  assert.equal(parsed.ResponseText, reply);
  assert.equal(parsed.Decision, 'Include');
  assert.equal(parsed.Evidence, undefined);
  for (const text of [
    'Decision: Maybe\nRationale: Include is mentioned in the source, but information is missing.',
    '{"Decision":"Exclude","Rationale":"A review.","Custom field":["extra"]}',
    reply + '\nRationale: Another detail.',
    'Decision: Exclude\nRationale:',
    '{"Decision":"Include","Rationale":false}',
  ])
    assert.equal(parseRecommendation(response(text), study, c, {}).ResponseText, text);
  for (const text of [
    reply + '\nDecision: Exclude',
    reply.replace('Decision: Include', 'Decision: Include / Exclude / Maybe'),
    'Include\nRationale: A study.',
    'Decision: Yes\nRationale: A study.',
    '{"Decision":"Include","Decision":"Exclude","Rationale":"Duplicate"}',
    '{"Decision":"Include","Decis\\u0069on":"Exclude","Rationale":"Duplicate"}',
  ])
    assert.throws(() => parseRecommendation(response(text), study, c, {}), text);
  assert.throws(() => parseRecommendation({ ...response(), status: 'incomplete' }, study, c));
});

test('formatted replies survive saved-response recovery, reuse, log export and reject parsed-data tampering', async () => {
  const c = await config();
  const databasePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-free-response-')),
    'screening.sqlite',
  );
  let calls = 0;
  const client = {
    responses: {
      create: async () => {
        calls++;
        return decisionResponse('Include', reply);
      },
    },
  };
  const result = await recommend({
    config: c,
    databasePath,
    client,
    extractStudy: async () => study,
    onCheckpoint: async ({ record }) => {
      if (record.status === 'response_saved') throw new Error('Synthetic interruption');
    },
  });
  assert.equal(result.record.status, 'error');
  const repaired = await reparseRecommendation(databasePath, c, result.record.runId);
  assert.equal(repaired.parsed.ResponseText, reply);
  const store = new QueueStore(databasePath);
  try {
    const operations = queueOperations({ config: c, databasePath, client });
    operations.extract = async () => study;
    operations.vote = async () => assert.fail('No live votes');
    const job = store.create(c, ['1'], 'recommend-only');
    const messages = [];
    await runQueue({ store, job, config: c, operations, log: (text) => messages.push(text) });
    assert.equal(calls, 1);
    assert.ok(messages.includes(reply));
    const history = readProjectHistory(databasePath, c.reviewUrl);
    assert.ok(history.log.includes(reply));
    assert.ok(history.log.includes(sections.responseFormat));
    assert.ok(!history.log.includes('Interpretation:'));
    assert.deepEqual(history.rows[0], ['Study number', 'Title', 'Decision', 'Rationale']);
    withRecords(databasePath, (records) =>
      records.saveRecommendation({
        ...repaired,
        parsed: { ...repaired.parsed, ResponseText: reply + '\nTampered' },
      }),
    );
    await assert.rejects(
      loadRecommendation(databasePath, c, repaired.record.runId),
      /original GPT reply/,
    );
  } finally {
    store.close();
  }
});

test('a missing internal decision object stops an automatic queue before voting and retains the original reply', async () => {
  const c = await config();
  const databasePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-ambiguous-response-')),
    'screening.sqlite',
  );
  const bad = reply + '\nDecision: Exclude';
  const client = { responses: { create: async () => response(bad) } };
  const store = new QueueStore(databasePath);
  try {
    const operations = queueOperations({ config: c, databasePath, client });
    operations.extract = async () => study;
    operations.vote = async () => assert.fail('Ambiguous output must not vote');
    const job = store.create(c, ['1'], 'auto-vote');
    const rows = await runQueue({ store, job, config: c, operations, log: () => {} });
    assert.equal(rows[0].state, 'error');
    const payload = withRecords(databasePath, (records) =>
      records.payload(rows[0].data.recommendationRecord.runId),
    );
    assert.equal(payload.response.output[0].content[0].text, bad);
  } finally {
    store.close();
  }
});
