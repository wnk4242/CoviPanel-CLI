import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withRecords } from '../Application/records.js';
import { queueOperations } from '../Application/queue-operations.js';
import { studyHash } from '../Application/profiles.js';
import { screeningDevice } from '../Application/screening-device.js';

const config = {
  dataset: 'demo-vitamin-c-common-cold',
  reviewId: '160676',
  reviewUrl: 'https://demo.covidence.org/reviews/160676/review_studies/screen',
  studyId: '1',
  configHash: 'test-criteria',
};

test('a vote intent survives abrupt exit and still blocks duplicate submission', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-records-'));
  const file = path.join(folder, 'screening.sqlite');
  const source = new URL('../Application/audit.js', import.meta.url).href;
  const script = `import {createAudit} from ${JSON.stringify(source)};const a=await createAudit(${JSON.stringify(file)},${JSON.stringify(config)});await a.save({status:'click_intent'});process.exit(23);`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script]).status, 23);
  const saved = withRecords(file, (store) => store.existingVote(config, '1'));
  assert.equal(saved.record.status, 'click_intent');
  assert.equal(saved.record.deviceId, screeningDevice().id);
  assert.deepEqual(await readdir(folder), ['screening.sqlite']);
});

test('database cache respects review, study, criteria and source without calling the API', async () => {
  const file = path.join(
    await mkdtemp(path.join(os.tmpdir(), 'covipanel-cache-')),
    'screening.sqlite',
  );
  const study = {
    studyId: '1',
    title: 'Treatment experiment',
    abstract: 'Patients received vitamin C.',
  };
  const parsed = {
    Decision: 'Include',
    Rationale: 'A treatment experiment.',
    Population: 'Patients',
    Intervention: 'Vitamin C',
    Condition: 'Not reported',
    StudyDesign: 'Experiment',
    Uncertainty: 'Condition not reported',
    Evidence: [study.abstract],
  };
  const record = {
    ...config,
    runId: randomUUID(),
    status: 'recommended',
    decision: parsed.Decision,
    rationale: parsed.Rationale,
    expectedButton: 'Yes',
    studyHash: studyHash(study),
  };
  withRecords(file, (store) => store.saveRecommendation({ record, study, parsed }));
  const operations = queueOperations({
    config,
    databasePath: file,
    shouldStop: () => false,
    client: { responses: { create: () => assert.fail('Unexpected API call') } },
  });
  assert.equal((await operations.cached('1', study)).record.runId, record.runId);
  assert.equal(await operations.cached('2', { ...study, studyId: '2' }), null);
  assert.equal(await operations.cached('1', { ...study, abstract: 'Changed citation' }), null);
  const different = queueOperations({
    config: { ...config, configHash: 'changed' },
    databasePath: file,
  });
  assert.equal(await different.cached('1', study, record.runId), null);
});
