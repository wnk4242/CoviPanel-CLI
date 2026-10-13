import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdtemp } from 'node:fs/promises';
import { parsePromptResponse } from '../Application/prompt-response.js';
import { validateProfile } from '../Application/profiles.js';
import { editableSettings } from '../Application/prompt-sections.js';
import { buildRequest } from '../Application/openai.js';
import { loadRecommendation } from '../Application/recommendation.js';
import { QueueStore } from '../Application/queue-store.js';
import { queueOperations } from '../Application/queue-operations.js';
import { runQueue } from '../Application/queue-runner.js';
import { exportProjectHistory } from '../Application/history-export.js';
import { spreadsheetLibrary } from '../Application/dependencies.js';
import { editPromptSection } from '../Application/prompt-editor.js';
import { profileFile, decisionResponse } from './fixtures.js';
import { parseRecommendation } from '../Application/ai-parser.js';

const responseFormat = `Follow exactly this format. Put each field on a separate line. Do not use bullets, markdown, or bold text.
Decision: Include / Exclude / Maybe
Population: exact wording used in abstract
Intervention: exact terms used in abstract
Condition: exact wording used in abstract
StudyDesign: exact wording used in abstract
Rationale: brief explanation of the decision`;
const sixLines = `Decision: Include
Population: primary adult participants
Intervention: vitamin C
Condition: common cold
StudyDesign: quantitative questionnaire
Rationale: The study includes adult participants, treatment outcome and quantitative data.`;
const study = (id) => ({
  ready: true,
  studyId: id,
  title: 'Synthetic treatment outcome study',
  abstract:
    'A quantitative questionnaire measured common cold symptoms in primary adult participants taking vitamin C.',
});
const examples = [
  {
    text: sixLines,
    decision: 'Include',
    rationale: 'The study includes adult participants, treatment outcome and quantitative data.',
  },
  {
    text: 'Decision: Exclude\n\nThis is a review.\n\nIt does not report a primary experiment.',
    decision: 'Exclude',
    rationale: 'This is a review.\n\nIt does not report a primary experiment.',
  },
  {
    text: 'Decision: Maybe\n\n理由：治疗分组尚不明确。\n需要进一步核实。',
    decision: 'Maybe',
    rationale: '理由：治疗分组尚不明确。\n需要进一步核实。',
  },
  {
    text: 'Decision: Include\n\n| Field | Evidence |\n| --- | --- |\n| Population | adult participants |\n| Method | questionnaire |',
    decision: 'Include',
    rationale:
      '| Field | Evidence |\n| --- | --- |\n| Population | adult participants |\n| Method | questionnaire |',
  },
  {
    text: 'Decision: Exclude\nReason: A review.\nConfidence: High\nNotes: No primary data.',
    decision: 'Exclude',
    rationale: 'Reason: A review.\nConfidence: High\nNotes: No primary data.',
  },
  { text: 'Decision: Maybe', decision: 'Maybe', rationale: '' },
];
async function config() {
  const settings = editableSettings(JSON.parse(await readFile(profileFile('demo'), 'utf8')));
  settings.promptSections = {
    inclusion: 'Adults, treatment outcome and quantitative data.',
    exclusion: 'Reviews.',
    responseFormat,
  };
  return validateProfile(settings, 'demo', '1');
}

test('the exact six-line response instructions are sent unchanged and all six returned lines are retained', async () => {
  const c = await config(),
    request = buildRequest(c, study('1'));
  assert.equal(
    request.instructions,
    `Inclusion criteria:\n${c.promptSections.inclusion}\n\nExclusion criteria:\n${c.promptSections.exclusion}\n\nResponse format:\n${responseFormat}`,
  );
  assert.deepEqual(Object.keys(request).sort(), [
    'input',
    'instructions',
    'max_output_tokens',
    'model',
    'store',
    'text',
  ]);
  const parsed = parseRecommendation(decisionResponse('Include', sixLines), study('1'), c, request);
  assert.deepEqual(parsed, {
    Decision: 'Include',
    Rationale: sixLines,
    ResponseText: sixLines,
  });
  assert.equal(parsed.ResponseText.split('\n').length, 6);
  for (const line of sixLines.split('\n').slice(1, 5))
    assert.ok(study('1').abstract.includes(line.split(': ')[1]));
});

test('one decision line supports optional explanation fields, paragraphs, tables, languages and decision-only replies', () => {
  for (const example of examples) {
    const parsed = parsePromptResponse(example.text);
    assert.equal(parsed.Decision, example.decision);
    assert.equal(parsed.Rationale, example.rationale);
    assert.equal(parsed.ResponseText, example.text);
  }
  const reordered = 'Population: adult participants\nDecision: Include\nStudyDesign: questionnaire';
  assert.equal(
    parsePromptResponse(reordered).Rationale,
    'Population: adult participants\nStudyDesign: questionnaire',
  );
  const crlf = sixLines.replaceAll('\n', '\r\n');
  assert.equal(parsePromptResponse(crlf).ResponseText, crlf);
  const repeated =
    'Decision: Include\nRationale: Population qualifies.\nRationale: Method qualifies.';
  assert.equal(parsePromptResponse(repeated).Rationale, repeated.split('\n').slice(1).join('\n'));
});

test('JSON retains existing rationale extraction and accepts other explanation fields without prescribing a schema', () => {
  const cases = [
    [
      '{"Decision":"Include","Rationale":"Original explanation.","Population":"Students"}',
      'Original explanation.',
    ],
    [
      '{"Decision":"Maybe","说明":"教育阶段不明确","Details":["Check setting"]}',
      '{\n  "说明": "教育阶段不明确",\n  "Details": [\n    "Check setting"\n  ]\n}',
    ],
    ['{"Decision":"Exclude"}', ''],
  ];
  for (const [text, rationale] of cases) {
    const parsed = parsePromptResponse(text);
    assert.equal(parsed.Rationale, rationale);
    assert.equal(parsed.ResponseText, text);
  }
});

test('decision capitalization and surrounding whitespace do not change the vote', () => {
  for (const text of [
    'decision: include',
    'Decision:  INCLUDE ',
    '{"decision":"include"}',
    '{"Decision":" include "}',
  ]) {
    assert.equal(parsePromptResponse(text).Decision, 'Include');
    assert.equal(parsePromptResponse(text).ResponseText, text);
  }
  assert.throws(
    () => parsePromptResponse('{"Decision":"Include","decision":"Exclude"}'),
    /Duplicate Decision/,
  );
});

test('compact decisions accept missing explanations and extra rationale labels', () => {
  for (const text of ['Excluded:', 'Excluded: ...', 'Excluded: reason.\nRationale: More detail.']) {
    const result = parsePromptResponse(text);
    assert.equal(result.Decision, 'Exclude');
    assert.equal(result.ResponseText, text);
  }
  assert.equal(parsePromptResponse('Excluded:').Rationale, '');
});

test('duplicate explanation fields retain the reply without blocking a clear JSON decision', () => {
  const text = '{"Decision":"Exclude","Rationale":"First note","Rationale":"Second note"}';
  const result = parsePromptResponse(text);
  assert.equal(result.Decision, 'Exclude');
  assert.equal(result.Rationale, 'Second note');
  assert.equal(result.ResponseText, text);
});

test('flexible presentation never supplies a missing, invalid or conflicting decision', () => {
  for (const text of [
    'Population: adult participants\nRationale: Include this study.',
    'Decision: Include / Exclude / Maybe\nReason: unclear.',
    'Decision: Yes\nReason: eligible.',
    'Decision: Include because the sample qualifies.',
    'Decision: Include\nDecision: Exclude',
    'Decision: Include\nDecision: Include',
    'Decision: Include\nExcluded: conflicting.',
    '{"Decision":"Include","Decision":"Exclude","Notes":"Duplicate"}',
    '{"Decision":"Include","Decis\\u0069on":"Exclude"}',
    '{"Decision":false,"Reason":"A study"}',
    '{"Reason":"Include the study"}',
  ])
    assert.throws(() => parsePromptResponse(text), text);
});

test('flexible responses survive screening, history export and cached reuse without additional API calls', async () => {
  const c = await config(),
    dir = await mkdtemp(path.join(os.tmpdir(), 'covipanel-flexible-roundtrip-'));
  const databasePath = path.join(dir, 'screening.sqlite'),
    store = new QueueStore(databasePath);
  const ids = examples.map((_, i) => String(i + 1));
  let calls = 0;
  const client = {
    responses: {
      create: async (request) => {
        calls++;
        const id = JSON.parse(request.input).study.studyId;
        const example = examples[Number(id) - 1];
        return decisionResponse(example.decision, example.text);
      },
    },
  };
  const operations = queueOperations({ config: c, databasePath, client });
  operations.extract = async (id) => study(id);
  operations.vote = async () => assert.fail('No votes in recommendations-only tests');
  try {
    const job = store.create(c, ids, 'recommend-only');
    const messages = [];
    const result = await runQueue({
      store,
      job,
      config: c,
      operations,
      log: (message) => messages.push(message),
    });
    assert.ok(result.every((item) => item.state === 'recommended'));
    assert.equal(calls, examples.length);
    const original = result[0].data.recommendationRecord.runId;
    const saved = await loadRecommendation(databasePath, c, original);
    assert.deepEqual((await loadRecommendation(databasePath, c, original)).parsed, saved.parsed);
    for (const example of examples) assert.ok(messages.includes(example.text));
    const exported = await exportProjectHistory(databasePath, c.reviewUrl, {
      folder: path.join(dir, 'Outputs'),
    });
    const { Workbook } = await spreadsheetLibrary(),
      workbook = new Workbook();
    await workbook.xlsx.readFile(exported.output);
    for (const [index, example] of examples.entries()) {
      assert.ok(exported.history.log.includes(example.text));
      const row = workbook.worksheets[0].getRow(index + 2);
      assert.equal(row.getCell(3).value, example.decision);
      assert.equal(row.getCell(4).value ?? '', example.text);
    }
    assert.equal(workbook.worksheets[0].columnCount, 4);
    const again = store.create(c, ids, 'recommend-only');
    const reused = await runQueue({ store, job: again, config: c, operations, log: () => {} });
    assert.ok(
      reused.every((item) => item.state === 'recommended' && item.data.reusedRecommendation),
    );
    assert.equal(calls, examples.length);
  } finally {
    store.close();
  }
});

test('the response editor explains optional presentation without changing saved prompt wording', async () => {
  const screens = [];
  const result = await editPromptSection(async () => '', 'responseFormat', responseFormat, {
    show: (title, lines) => screens.push(lines.join('\n')),
    open: async (file) => assert.equal(await readFile(file, 'utf8'), responseFormat),
  });
  assert.equal(result, responseFormat);
  assert.ok(screens[0].includes('No Decision: or Rationale: field is required'));
  assert.ok(screens[0].includes('Leave this empty'));
});
