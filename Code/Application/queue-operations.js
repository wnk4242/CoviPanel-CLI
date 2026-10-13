import { databasePath as defaultDatabase } from './config.js';
import { searchStudy } from './covidence.js';
import { studyHash } from './profiles.js';
import { recommend, loadRecommendation } from './recommendation.js';
import { runVote } from './vote.js';
import { withRecords } from './records.js';

export async function existingVote(config, id, databasePath = defaultDatabase) {
  return withRecords(databasePath, (store) => store.existingVote(config, id));
}

export function queueOperations({
  page,
  config,
  client,
  confirm,
  shouldStop,
  databasePath = defaultDatabase,
}) {
  return {
    existingVote: (id) => existingVote(config, id, databasePath),
    extract: async (id) => {
      await page.goto(config.reviewUrl, { waitUntil: 'domcontentloaded' });
      return searchStudy(page, { ...config, studyId: id });
    },
    cached: async (id, study, preferred) => {
      let ids = withRecords(databasePath, (store) => store.recommendationIds(config, id));
      if (preferred) ids = [preferred, ...ids.filter((run) => run !== preferred)];
      for (const run of ids) {
        try {
          const saved = await loadRecommendation(databasePath, config, run);
          if (saved.record.studyId === id && saved.record.studyHash === studyHash(study))
            return saved;
        } catch {
          /* Only a validated recommendation is reusable. */
        }
      }
      return null;
    },
    recommend: async (id, study, reference, onCheckpoint, retryApprovedRecommendationId) => {
      const previous = withRecords(databasePath, (store) =>
        store.recommendationAttempts(config, id),
      ).find((r) => r.requestHash && r.studyHash === studyHash(study));
      if (previous && previous.runId !== retryApprovedRecommendationId) {
        const error = new Error(
          `A previous AI request exists for study #${id} with the same citation and settings. No automatic repeat. Use retry-api on this saved batch only after reviewing the previous request.`,
        );
        error.previousRecommendationId = previous.runId;
        throw error;
      }
      const result = await recommend({
        config: { ...config, studyId: id },
        extractStudy: async () => study,
        client,
        databasePath,
        reference,
        onCheckpoint,
      });
      return result.record.status === 'recommended'
        ? loadRecommendation(databasePath, { ...config, studyId: id }, result.record.runId)
        : result;
    },
    vote: async (id, recommendation, onCheckpoint) => {
      if (shouldStop()) return { record: { status: 'cancelled', error: 'Stopped before voting.' } };
      const r = recommendation.record;
      return runVote({
        page,
        config: { ...config, studyId: id, decision: r.decision, expectedButton: r.expectedButton },
        recommendation,
        databasePath,
        onCheckpoint,
        confirm: (record) => (shouldStop() ? false : confirm(record, recommendation)),
      });
    },
  };
}
