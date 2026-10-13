import { studyHash } from './profiles.js';
import { savedDecisionIds } from './saved-decisions.js';
import { finishedItem, requiresReview } from './states.js';
import { preparedItem, reviewedRecommendation } from './review-decisions.js';

// All external work is injected so crash/restart semantics can be tested without live services.
export async function runQueue({
  store,
  job,
  config,
  operations,
  shouldStop = () => false,
  log = console.log,
}) {
  if (
    job.config_hash !== config.configHash ||
    job.dataset !== config.dataset ||
    job.review_url !== config.reviewUrl
  )
    throw new Error(
      'Queue configuration changed. Create a new job after reviewing the new criteria.',
    );
  store.recover(job.id);
  const saved = savedDecisionIds(store.db, config.reviewUrl);
  const batchApproved =
    job.mode === 'review-all' && store.items(job.id).some((item) => item.data.batchApproval);
  if (
    batchApproved &&
    store
      .items(job.id)
      .some(
        (item) =>
          !finishedItem(item, job.mode) && !saved.has(item.study_id) && !item.data.batchApproval,
      )
  )
    throw new Error('Batch confirmation is incomplete. Return to batch review before submission.');
  for (const original of store.items(job.id)) {
    if (shouldStop()) break;
    if (finishedItem(original, job.mode)) continue;
    if (saved.has(original.study_id)) {
      store.update(job.id, original.study_id, 'skipped', {
        ...original.data,
        reviewReason:
          'Decision saved without submission in another batch; no new screening or vote.',
      });
      continue;
    }
    if (job.mode === 'review-all' && !batchApproved && preparedItem(original, job.mode)) continue;
    if (requiresReview(original.state)) {
      log(
        `Study #${original.study_id} is paused: ${original.data.error || 'An earlier request or vote has an unresolved outcome.'}`,
      );
      break;
    }
    let data = { ...original.data };
    const id = original.study_id;
    const update = (state, patch = {}) => {
      data = { ...data, ...patch };
      store.update(job.id, id, state, data);
    };
    try {
      if (job.mode !== 'recommend-only') {
        const prior = await operations.existingVote(id);
        if (prior) {
          update(prior.record.status === 'confirmed' ? 'completed' : 'needs_review', {
            voteRecord: prior.record,
            voteRef: prior.ref,
            duplicatePrevented: true,
            error:
              prior.record.status === 'confirmed'
                ? null
                : 'Existing vote claim requires read-only review; no resubmission.',
          });
          if (prior.record.status !== 'confirmed') break;
          continue;
        }
      }
      update('processing', { stage: 'extracting', error: null });
      log(`Processing study #${id}`);
      const study = await operations.extract(id);
      if (!study.ready || study.studyId !== id) throw new Error('Wrong or unverified study.');
      update('processing', { study });
      let recommendation = await operations.cached(id, study, data.recommendationRecord?.runId);
      if (recommendation)
        update('processing', {
          reusedRecommendation: true,
          recommendationRecord: recommendation.record,
          recommendationRef: recommendation.ref,
        });
      if (!recommendation) {
        if (batchApproved)
          throw new Error(
            'The confirmed response or citation changed. No new AI request or vote was made.',
          );
        if (data.recommendationRecord?.status === 'recommended')
          throw new Error(
            'Saved recommendation no longer matches the study or criteria. Review before requesting another API call.',
          );
        if (shouldStop()) {
          update('pending', { stage: 'extracting' });
          break;
        }
        recommendation = await operations.recommend(
          id,
          study,
          data.referenceDecision,
          async (snapshot) => {
            update('processing', {
              stage: 'api',
              recommendationRecord: snapshot.record,
              recommendationRef: snapshot.ref,
            });
          },
          data.retryApprovedRecommendationId,
        );
      }
      if (recommendation.record.status !== 'recommended') {
        update('error', {
          recommendationRecord: recommendation.record,
          recommendationRef: recommendation.ref,
          error: recommendation.record.error,
        });
        break;
      }
      if (recommendation.record.studyHash !== studyHash(study))
        throw new Error('Recommendation source changed.');
      if (batchApproved && recommendation.record.runId !== data.batchReview?.runId)
        throw new Error(
          'The exact confirmed AI response is unavailable. No replacement response can be submitted.',
        );
      const r = {
        ...recommendation.record,
        referenceDecision: data.referenceDecision,
        referenceComparison: data.referenceDecision
          ? data.referenceDecision === recommendation.record.decision
            ? 'match'
            : 'mismatch'
          : 'not_assessed',
      };
      update('recommended', {
        stage: 'recommended',
        recommendationRecord: r,
        recommendationRef: recommendation.ref,
      });
      if (job.mode === 'recommend-only') {
        if (config.promptSections) log(recommendation.parsed.ResponseText);
      }
      if (
        job.mode === 'recommend-only' ||
        (job.mode === 'review-all' && !batchApproved) ||
        shouldStop()
      )
        continue;
      if (batchApproved) recommendation = reviewedRecommendation(recommendation, data, job);
      update('processing', { stage: 'voting' });
      const vote = await operations.vote(id, recommendation, async (snapshot) => {
        update('processing', {
          stage: 'voting',
          voteRecord: snapshot.record,
          voteRef: snapshot.ref,
        });
      });
      update(vote.record.status === 'confirmed' ? 'completed' : 'needs_review', {
        voteRecord: vote.record,
        voteRef: vote.ref,
        error: vote.record.error || vote.record.reason || null,
      });
      if (vote.record.status !== 'confirmed') break;
    } catch (error) {
      update(data.stage === 'voting' ? 'needs_review' : 'error', {
        error: error.message,
        ...(error.previousRecommendationId
          ? { previousRecommendationId: error.previousRecommendationId }
          : {}),
      });
      break;
    }
  }
  return store.items(job.id);
}
