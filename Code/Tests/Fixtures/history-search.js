import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProfile } from '../fixtures.js';
import { QueueStore } from '../../Application/queue-store.js';
import { withRecords } from '../../Application/records.js';
import { studyHash } from '../../Application/profiles.js';

export async function historySearchFixture(realReview = false) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-history-search-'));
  const file = path.join(folder, 'screening.sqlite');
  const config = await loadProfile('demo', '123');
  if (realReview)
    Object.assign(config, {
      reviewUrl: 'https://app.covidence.org/reviews/900001',
      profile: 'standard',
      dataset: 'standard-review',
      enabled: true,
      criteriaApproved: true,
    });
  const study = { studyId: '123', title: 'Local search fixture', abstract: 'Synthetic abstract.' };
  const record = {
    runId: 'search-fixture',
    dataset: config.dataset,
    reviewUrl: config.reviewUrl,
    configHash: config.configHash,
    studyId: '123',
    title: study.title,
    studyHash: studyHash(study),
    status: 'recommended',
    decision: 'Include',
    rationale:
      'Decision: Include\nPopulation: adults\nIntervention: vitamin C\nCondition: common cold\nStudyDesign: randomized trial\nRationale: Original explanation.',
    createdAt: new Date().toISOString(),
  };
  const store = new QueueStore(file);
  let job;
  try {
    job = store.create(config, ['123', '456'], 'review-all');
    withRecords(file, (s) =>
      s.saveRecommendation({
        record,
        study,
        parsed: { Decision: 'Include', ResponseText: record.rationale },
      }),
    );
    store.update(job.id, '123', 'recommended', {
      recommendationRef: 'recommendation:search-fixture',
    });
  } finally {
    store.close();
  }
  return {
    folder,
    file,
    config,
    job,
    record,
    project: { name: 'Search fixture', reviewUrl: config.reviewUrl, folder },
    target: { reviewUrl: config.reviewUrl, studyId: '123', runId: record.runId },
  };
}
