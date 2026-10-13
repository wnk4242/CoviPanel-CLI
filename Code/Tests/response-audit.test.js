import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { recommend, reparseRecommendation } from '../Application/recommendation.js';
import { withRecords } from '../Application/records.js';
import { loadProfile } from './fixtures.js';

const study = {
  ready: true,
  studyId: '1',
  title: 'Synthetic trial',
  abstract: 'Participants received treatment.',
};
const parsed = {
  Decision: 'Include',
  Population: 'Participants',
  Intervention: 'Treatment',
  Condition: 'Not reported',
  StudyDesign: 'Trial',
  Rationale: 'A synthetic test only.',
  Uncertainty: 'Not reported',
  Evidence: ['E2'],
};
const response = (text = JSON.stringify(parsed)) => ({
  id: 'response-fixture',
  model: 'fixture-model',
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 10, output_tokens: 20 },
  headers: { authorization: 'secret-header-sentinel' },
});
async function fixture() {
  return {
    config: await loadProfile('demo', '1'),
    databasePath: path.join(
      await mkdtemp(path.join(os.tmpdir(), 'covipanel-response-')),
      'screening.sqlite',
    ),
  };
}

test('invalid response text and request are retained without transport secrets', async () => {
  const f = await fixture();
  const result = await recommend({
    ...f,
    config: { ...f.config, apiKey: 'secret-key-sentinel' },
    extractStudy: async () => study,
    client: { responses: { create: async () => response('ORIGINAL INVALID OUTPUT') } },
  });
  const payload = withRecords(f.databasePath, (s) => s.payload(result.record.runId));
  assert.equal(result.record.status, 'error');
  assert.equal(payload.response.output[0].content[0].text, 'ORIGINAL INVALID OUTPUT');
  assert.equal(payload.requestVersion, '1.1.2');
  assert.ok(payload.responseHash);
  assert.ok(!JSON.stringify(payload).includes('secret-key-sentinel'));
  assert.ok(!JSON.stringify(payload).includes('secret-header-sentinel'));
  assert.equal(
    withRecords(f.databasePath, (s) => s.db.prepare('SELECT status FROM parse_attempts').get())
      .status,
    'rejected',
  );
});

test('response checkpoint interruption can be repaired locally with one total API call', async () => {
  const f = await fixture();
  let calls = 0;
  const result = await recommend({
    ...f,
    extractStudy: async () => study,
    client: {
      responses: {
        create: async () => {
          calls++;
          return response();
        },
      },
    },
    onCheckpoint: async (snapshot) => {
      if (snapshot.record.status === 'response_saved')
        throw new Error('Simulated interruption before parsing');
    },
  });
  assert.equal(result.record.status, 'error');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Reparse cannot call any network API');
  try {
    const repaired = await reparseRecommendation(f.databasePath, f.config, result.record.runId);
    assert.equal(repaired.record.status, 'recommended');
    assert.equal(repaired.parsed.Decision, 'Include');
    assert.equal(calls, 1);
    assert.equal(
      (await reparseRecommendation(f.databasePath, f.config, result.record.runId)).record.runId,
      result.record.runId,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid, changed-settings and tampered responses cannot be promoted to decisions', async () => {
  const f = await fixture();
  const result = await recommend({
    ...f,
    extractStudy: async () => study,
    client: { responses: { create: async () => response('INVALID') } },
  });
  await assert.rejects(
    reparseRecommendation(
      f.databasePath,
      { ...f.config, configHash: 'different' },
      result.record.runId,
    ),
    /original settings/,
  );
  await assert.rejects(
    reparseRecommendation(f.databasePath, f.config, result.record.runId),
    /valid JSON/,
  );
  withRecords(f.databasePath, (s) =>
    s.db
      .prepare('UPDATE recommendation_payloads SET response=? WHERE run_id=?')
      .run(JSON.stringify(response()), result.record.runId),
  );
  await assert.rejects(
    reparseRecommendation(f.databasePath, f.config, result.record.runId),
    /integrity/,
  );
  assert.equal(
    withRecords(f.databasePath, (s) => s.recommendation(result.record.runId)).record.decision,
    null,
  );
});
