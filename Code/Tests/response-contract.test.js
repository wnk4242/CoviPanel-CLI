import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { profileFile, decisionResponse } from './fixtures.js';
import { editableSettings, buildPrompt } from '../Application/prompt-sections.js';
import { validateProfile, hash, studyHash } from '../Application/profiles.js';
import { buildRequest } from '../Application/openai.js';
import { parseRecommendation } from '../Application/ai-parser.js';
import { decisionResponseFormat } from '../Application/response-contract.js';
import { loadRecommendation, reparseRecommendation } from '../Application/recommendation.js';
import { withRecords } from '../Application/records.js';
import { QueueStore } from '../Application/queue-store.js';
import { queueOperations } from '../Application/queue-operations.js';
import { runQueue } from '../Application/queue-runner.js';

const study = {
  ready: true,
  studyId: '127',
  title: 'Synthetic survey',
  abstract: 'A survey of complementary medicine use in children.',
};
const rawResponse = (text) => ({
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text }] }],
});
async function fixture(responseFormat = '') {
  const settings = editableSettings(JSON.parse(await readFile(profileFile('demo'), 'utf8')));
  settings.promptSections = {
    inclusion:
      'Must be an experimental study examining treatment effect of Vitamin C on common cold.',
    exclusion: 'Do not include review studies or narrative studies.',
    responseFormat,
  };
  const config = await validateProfile(settings, 'demo', study.studyId);
  const databasePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-contract-')),
    'screening.sqlite',
  );
  return { config, databasePath };
}

test('blank response format is valid and requests only a decision and user-facing reply beside the exact three prompt sections', async () => {
  const { config } = await fixture();
  const request = buildRequest(config, study);
  assert.equal(request.instructions, buildPrompt(config.promptSections));
  assert.ok(request.instructions.endsWith('Response format:\n'));
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.required, ['decision', 'response']);
  assert.deepEqual(Object.keys(request.text.format.schema.properties), ['decision', 'response']);
  assert.deepEqual(request.text.format.schema.properties.decision.enum, [
    'Include',
    'Exclude',
    'Maybe',
  ]);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.match(
    request.text.format.schema.properties.response.description,
    /no response format.*concise explanation/,
  );
  assert.deepEqual(Object.keys(JSON.parse(request.input)), ['study']);
  assert.deepEqual(buildRequest(config, study).text.format, decisionResponseFormat());
});

test('the separate decision supports arbitrary presentation without searching the reply for a voting label', async () => {
  const { config } = await fixture('Use my chosen format.');
  const request = buildRequest(config, study);
  for (const [decision, text] of [
    ['Exclude', 'This survey does not test vitamin C as a treatment for the common cold.'],
    ['Include', '  Eligible trial.\r\n\r\nFull explanation.  '],
    ['Maybe', '治疗分组尚不明确。'],
    ['Exclude', '| Finding | Detail |\n| --- | --- |\n| Design | Review |'],
    [
      'Include',
      '{"summary":"Eligible trial","details":["children"],"quoted text":"Decision: Exclude"}',
    ],
    ['Maybe', 'The response template offered Decision: Include / Exclude / Maybe.'],
    ['Exclude', 'Reasons to Include were considered, but the study does not meet the criteria.'],
    ['Maybe', ''],
  ]) {
    assert.deepEqual(
      parseRecommendation(decisionResponse(decision, text), study, config, request),
      {
        Decision: decision,
        Rationale: text,
        ResponseText: text,
      },
    );
  }
});

test('a screening with no response-format instructions completes and reuses its unlabeled reply', async () => {
  const f = await fixture(),
    store = new QueueStore(f.databasePath);
  const reply = 'This survey does not test vitamin C treatment for the common cold.';
  let calls = 0;
  try {
    const operations = queueOperations({
      ...f,
      client: {
        responses: {
          create: async () => {
            calls++;
            return decisionResponse('Exclude', reply);
          },
        },
      },
    });
    operations.extract = async () => study;
    operations.vote = async (_id, recommendation) => {
      assert.equal(recommendation.record.expectedButton, 'No');
      assert.equal(recommendation.parsed.ResponseText, reply);
      return { record: { status: 'confirmed' } };
    };
    const messages = [];
    const preview = store.create(f.config, ['127'], 'recommend-only');
    const recommended = await runQueue({
      store,
      job: preview,
      config: f.config,
      operations,
      log: (message) => messages.push(message),
    });
    assert.equal(recommended[0].state, 'recommended');
    assert.ok(messages.includes(reply));
    const job = store.create(f.config, ['127'], 'auto-vote');
    const result = await runQueue({ store, job, config: f.config, operations, log: () => {} });
    assert.equal(result[0].state, 'completed');
    assert.equal(result[0].data.reusedRecommendation, true);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('invalid internal decisions and malformed wrappers never fall back to interpreting display text', async () => {
  const { config } = await fixture();
  const request = buildRequest(config, study);
  const text = 'Decision: Include\nRationale: Eligible trial.';
  const invalid = [
    text,
    '{"Decision":"Include","Rationale":"Eligible trial."}',
    '{"decision":"Include","response":',
    '{"decision":"Include","decision":"Exclude","response":"Review."}',
    '{"decision":"Include","decis\\u0069on":"Exclude","response":"Review."}',
    '{"decision":"Include","response":"First","response":"Second"}',
    JSON.stringify({ response: text }),
    JSON.stringify({ decision: 'Include' }),
    JSON.stringify({ decision: 'Include', response: text, extra: true }),
    'null',
    '[]',
    'true',
    '12',
    '"Include"',
  ];
  for (const decision of ['Yes', 'include', ' Include ', 'toString', null, true, ['Include'], {}])
    invalid.push(JSON.stringify({ decision, response: text }));
  for (const response of [null, true, 1, [], {}])
    invalid.push(JSON.stringify({ decision: 'Include', response }));
  for (const raw of invalid)
    assert.throws(() => parseRecommendation(rawResponse(raw), study, config, request), raw);
});

test('the original request determines the parser, and refusal or truncation still cannot supply a vote', async () => {
  const { config } = await fixture();
  const request = buildRequest(config, study);
  const completed = decisionResponse('Exclude', 'A survey.');
  for (const response of [
    { ...completed, status: 'incomplete' },
    { ...completed, incomplete_details: { reason: 'max_output_tokens' } },
    { ...completed, error: { message: 'Failed' } },
    { ...completed, output: [] },
    { ...completed, output: [...completed.output, ...completed.output] },
    { ...completed, output: [{ content: [{ type: 'refusal', refusal: 'Refused' }] }] },
  ])
    assert.throws(() => parseRecommendation(response, study, config, request));
  assert.throws(() => parseRecommendation(completed, study, config), /original API request/);
  assert.throws(
    () => parseRecommendation(completed, study, config, { text: { format: { type: 'text' } } }),
    /Unknown saved/,
  );
  assert.equal(
    parseRecommendation(completed, study, config, {}).ResponseText,
    completed.output[0].content[0].text,
  );
});

// Reproduce an actual pre-wrapper request rather than sending old-style output
// through the new API contract. Saved payloads are immutable in production.
function saveHistoricalResponse(f, interrupted) {
  const request = buildRequest(f.config, study);
  delete request.text;
  const response = rawResponse(
    'I excluded this study because it does not evaluate Vitamin C as a treatment for the common cold.',
  );
  const parsed = {
    Decision: 'Exclude',
    Rationale: response.output[0].content[0].text,
    ResponseText: response.output[0].content[0].text,
  };
  const record = {
    runId: randomUUID(),
    dataset: f.config.dataset,
    profile: f.config.profile,
    reviewUrl: f.config.reviewUrl,
    reviewId: f.config.reviewId,
    studyId: study.studyId,
    model: f.config.openai.model,
    criteriaVersion: f.config.criteriaVersion,
    configHash: f.config.configHash,
    studyHash: studyHash(study),
    requestHash: hash(request),
    status: interrupted ? 'error' : 'recommended',
    decision: interrupted ? null : 'Exclude',
    expectedButton: interrupted ? null : 'No',
    rationale: interrupted ? null : parsed.Rationale,
    parserVersion: '1.1.6',
    title: study.title,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };
  withRecords(f.databasePath, (records) =>
    records.transaction(() => {
      records.saveRecommendation({ record, study, parsed: interrupted ? null : parsed });
      records.savePayload(record.runId, { request, response, requestVersion: '1.1.2' });
    }),
  );
  return { record, parsed };
}

for (const interrupted of [false, true]) {
  test(`a ${interrupted ? 'previously interrupted' : 'validated'} pre-wrapper reply is reused while later studies receive the new contract`, async () => {
    const f = await fixture('Give a one-sentence rationale about your decision.');
    const historical = saveHistoricalResponse(f, interrupted);
    const before = withRecords(f.databasePath, (records) =>
      records.payload(historical.record.runId),
    );
    const restored = interrupted
      ? await reparseRecommendation(f.databasePath, f.config, historical.record.runId)
      : await loadRecommendation(f.databasePath, f.config, historical.record.runId);
    assert.deepEqual(restored.parsed, historical.parsed);
    const store = new QueueStore(f.databasePath),
      requests = [],
      votes = [];
    try {
      const job = store.create(f.config, ['105', '127', '122'], 'auto-vote');
      store.update(job.id, '105', 'completed', { voteRecord: { status: 'confirmed' } });
      const operations = queueOperations({
        ...f,
        client: {
          responses: {
            create: async (request) => {
              const id = JSON.parse(request.input).study.studyId;
              requests.push(id);
              assert.deepEqual(request.text.format, decisionResponseFormat());
              assert.equal(request.instructions, buildPrompt(f.config.promptSections));
              return decisionResponse('Include', 'An eligible randomized trial.');
            },
          },
        },
      });
      operations.extract = async (id) => ({ ...study, studyId: id });
      operations.vote = async (id, recommendation) => {
        votes.push([id, recommendation.record.expectedButton]);
        return { record: { status: 'confirmed' } };
      };
      const items = await runQueue({ store, job, config: f.config, operations, log: () => {} });
      assert.ok(items.every((item) => item.state === 'completed'));
      assert.deepEqual(requests, ['122']);
      assert.deepEqual(votes, [
        ['127', 'No'],
        ['122', 'Yes'],
      ]);
      assert.equal(items[1].data.reusedRecommendation, true);
      assert.deepEqual(
        withRecords(f.databasePath, (records) => records.payload(historical.record.runId)),
        before,
      );
      const newPayload = withRecords(f.databasePath, (records) =>
        records.payload(items[2].data.recommendationRecord.runId),
      );
      assert.equal(newPayload.requestVersion, '1.1.3');
      await runQueue({ store, job, config: f.config, operations, log: () => {} });
      assert.equal(requests.length, 1);
      assert.equal(votes.length, 2);
    } finally {
      store.close();
    }
  });
}
