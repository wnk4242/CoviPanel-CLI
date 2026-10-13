import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { parsePromptResponse } from '../Application/prompt-response.js';
import { parseRecommendation } from '../Application/ai-parser.js';
import { validateProfile } from '../Application/profiles.js';
import { editableSettings } from '../Application/prompt-sections.js';
import { buildRequest } from '../Application/openai.js';
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
import { profileFile, decisionResponse } from './fixtures.js';

const reply =
  'Excluded: this fictional survey does not test vitamin C treatment for the common cold.';
const sentenceReply =
  'I excluded this study because it evaluates an unrelated treatment rather than vitamin C for the common cold.';
const study = {
  ready: true,
  studyId: '1',
  title: 'Synthetic survey',
  abstract: 'A survey of complementary medicine use in children.',
};
const response = (text) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});
async function fixture() {
  const settings = editableSettings(JSON.parse(await readFile(profileFile('demo'), 'utf8')));
  settings.promptSections = {
    inclusion:
      'Must be an experimental study examining treatment effect of Vitamin C on common cold.',
    exclusion: 'Do not include review studies or narrative studies.',
    responseFormat: 'Give a one-sentence rationale about your decision.',
  };
  const config = await validateProfile(settings, 'demo', '1');
  const databasePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-compact-response-')),
    'screening.sqlite',
  );
  return { config, databasePath };
}

test('explicit compact decisions preserve GPT wording and normalize only the decision label', () => {
  for (const [label, Decision] of [
    ['Include', 'Include'],
    ['Included', 'Include'],
    ['Exclude', 'Exclude'],
    ['Excluded', 'Exclude'],
    ['Maybe', 'Maybe'],
    ['excluded', 'Exclude'],
  ]) {
    const text = ` ${label}: This is the explanation. `;
    assert.deepEqual(parsePromptResponse(text), {
      Decision,
      Rationale: 'This is the explanation.',
      ResponseText: text,
    });
  }
  const parsed = parsePromptResponse(reply);
  assert.equal(parsed.Decision, 'Exclude');
  assert.equal(parsed.Rationale, reply.slice('Excluded: '.length));
  assert.equal(parsed.ResponseText, reply);
});

test('explicit sentence decisions preserve the entire reply without requiring a field label', () => {
  for (const [text, decision] of [
    [sentenceReply, 'Exclude'],
    ['I include this study because it reports an eligible experiment.', 'Include'],
    ['We included the record because it meets the criteria.', 'Include'],
    ['I would exclude this article because it is a review.', 'Exclude'],
    ['I recommend excluding this paper because it is a review.', 'Exclude'],
    ['This study should be excluded.', 'Exclude'],
    ['The study is included because the population and design qualify.', 'Include'],
    ['Exclude this study because it examines a different treatment.', 'Exclude'],
    ['My decision is Maybe because the abstract is incomplete.', 'Maybe'],
    ['Included because the trial meets the inclusion criteria.', 'Include'],
    ['Exclude — this study included participants with a different condition.', 'Exclude'],
    ['Maybe, because the intervention is not described.', 'Maybe'],
  ]) {
    assert.deepEqual(parsePromptResponse(text), {
      Decision: decision,
      Rationale: text,
      ResponseText: text,
    });
  }
});

test('sentence parsing rejects uncertainty, negation, historical descriptions and conflicting decisions', () => {
  for (const text of [
    'I did not exclude this study because it is eligible.',
    'I would not include this study.',
    'This study should not be excluded.',
    'I may exclude this study because the intervention is unclear.',
    'Exclude this study if it is a review.',
    'Include this study only if it is quantitative.',
    'This study was included in another systematic review.',
    'I included participants from this study in a previous experiment.',
    'Included studies examined anxiety.',
    'I excluded this study. I included this study.',
    'I excluded this study, but I include this study.',
    'I excluded this study. Maybe, because more information is needed.',
    'I excluded this study because it is a review.\nDecision: Include',
    'My decision is Include or Exclude.',
  ])
    assert.throws(() => parsePromptResponse(text), text);
});

test('compact parsing rejects missing, inferred, negated and conflicting decisions', () => {
  for (const text of [
    'This study did not examine the treatment.',
    'Not excluded: this is a trial.',
    'Possibly included: unclear.',
    'Include / Exclude / Maybe: reason.',
    'Excluded: not a trial.\nIncluded: a trial.',
    'Excluded: not a trial. Included: a trial.',
    'Excluded: reason.\nDecision: Include\nRationale: conflicting.',
    'Decision: Include\nRationale: reason.\nExcluded: conflicting.',
    '**Excluded:** this is a survey.',
  ])
    assert.throws(() => parsePromptResponse(text), text);
  const config = { promptSections: {} };
  assert.throws(() =>
    parseRecommendation({ ...response(reply), status: 'incomplete' }, study, config),
  );
  assert.throws(() =>
    parseRecommendation(
      { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Refused' }] }] },
      study,
      config,
    ),
  );
  assert.throws(() =>
    parseRecommendation(
      {
        status: 'completed',
        output: [...response(reply).output, ...response('Included: reason.').output],
      },
      study,
      config,
    ),
  );
});

for (const [kind, text] of [
  ['compact', reply],
  ['sentence', sentenceReply],
]) {
  test(`a one-sentence instruction remains unchanged and its ${kind} answer can complete screening`, async () => {
    const f = await fixture();
    const request = buildRequest(f.config, study);
    assert.equal(
      request.instructions,
      'Inclusion criteria:\n' +
        f.config.promptSections.inclusion +
        '\n\nExclusion criteria:\n' +
        f.config.promptSections.exclusion +
        '\n\nResponse format:\nGive a one-sentence rationale about your decision.',
    );
    const store = new QueueStore(f.databasePath);
    let calls = 0,
      votes = 0;
    try {
      const job = store.create(f.config, ['1'], 'auto-vote');
      const operations = queueOperations({
        ...f,
        client: {
          responses: {
            create: async () => {
              calls++;
              return decisionResponse('Exclude', text);
            },
          },
        },
      });
      operations.extract = async () => study;
      operations.vote = async (id, recommendation) => {
        votes++;
        assert.equal(recommendation.parsed.Decision, 'Exclude');
        return {
          record: { status: 'confirmed', decision: 'Exclude', expectedButton: 'No' },
          ref: 'synthetic-vote',
        };
      };
      const items = await runQueue({ store, job, config: f.config, operations, log: () => {} });
      assert.equal(items[0].state, 'completed');
      assert.equal(calls, 1);
      assert.equal(votes, 1);
      assert.ok(readProjectHistory(f.databasePath, f.config.reviewUrl).log.includes(text));
    } finally {
      store.close();
    }
  });

  test(`a saved ${kind} response can be recovered and reused without another API call or a live vote`, async () => {
    const f = await fixture();
    let calls = 0;
    const result = await recommend({
      ...f,
      extractStudy: async () => study,
      client: {
        responses: {
          create: async () => {
            calls++;
            return decisionResponse('Exclude', text);
          },
        },
      },
      onCheckpoint: async ({ record }) => {
        if (record.status === 'response_saved')
          throw new Error('Synthetic interruption after saving the response');
      },
    });
    assert.equal(result.record.status, 'error');
    const before = withRecords(f.databasePath, (s) => s.payload(result.record.runId));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('Offline recovery must not call the network');
    try {
      const restored = await reparseRecommendation(f.databasePath, f.config, result.record.runId);
      assert.equal(restored.record.status, 'recommended');
      assert.equal(restored.record.parserVersion, '1.1.7');
      assert.equal(restored.parsed.Decision, 'Exclude');
      assert.equal(restored.parsed.ResponseText, text);
      assert.deepEqual(
        withRecords(f.databasePath, (s) => s.payload(result.record.runId)),
        before,
      );
      assert.equal(
        (await loadRecommendation(f.databasePath, f.config, result.record.runId)).record.runId,
        result.record.runId,
      );
      assert.equal(calls, 1);
      const store = new QueueStore(f.databasePath);
      try {
        const job = store.create(f.config, ['1'], 'recommend-only');
        const operations = queueOperations({
          ...f,
          client: { responses: { create: async () => assert.fail('Reuse must not call AI') } },
        });
        operations.extract = async () => study;
        operations.vote = async () => assert.fail('Recommendations only must not vote');
        const items = await runQueue({ store, job, config: f.config, operations, log: () => {} });
        assert.equal(items[0].state, 'recommended');
        assert.equal(items[0].data.reusedRecommendation, true);
      } finally {
        store.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('a continued queue handles successive sentence decisions and skips completed work', async () => {
  const f = await fixture(),
    store = new QueueStore(f.databasePath);
  const replies = [
    sentenceReply,
    'I include this study because it reports a treatment experiment.',
    'Maybe, because the treatment is unclear.',
  ];
  const requests = [],
    votes = [];
  try {
    const job = store.create(f.config, ['105', '1', '2', '3'], 'auto-vote');
    store.update(job.id, '105', 'completed', { voteRecord: { status: 'confirmed' } });
    const operations = queueOperations({
      ...f,
      client: {
        responses: {
          create: async (request) => {
            const id = JSON.parse(request.input).study.studyId;
            requests.push(id);
            return decisionResponse(
              ['Exclude', 'Include', 'Maybe'][Number(id) - 1],
              replies[Number(id) - 1],
            );
          },
        },
      },
    });
    operations.extract = async (id) => ({ ...study, studyId: id });
    operations.vote = async (id, recommendation) => {
      votes.push([id, recommendation.record.expectedButton]);
      return { record: { status: 'confirmed' } };
    };
    await runQueue({ store, job, config: f.config, operations, log: () => {} });
    assert.deepEqual(requests, ['1', '2', '3']);
    assert.deepEqual(votes, [
      ['1', 'No'],
      ['2', 'Yes'],
      ['3', 'Maybe'],
    ]);
    assert.ok(store.items(job.id).every((item) => item.state === 'completed'));
  } finally {
    store.close();
  }
});
