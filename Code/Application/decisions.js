import { validateConfig, profileForReview } from './config.js';
import { validatePromptSections } from './prompt-sections.js';

export const decisionMap = Object.freeze({ Include: 'Yes', Exclude: 'No', Maybe: 'Maybe' });

/** @param {Record<string, any>} config */
export function assertVotingProfile(config) {
  const profile = profileForReview(config.reviewUrl);
  const dataset = profile === 'demo' ? 'demo-vitamin-c-common-cold' : 'standard-review';
  if (config.dataset !== dataset || (config.profile && config.profile !== profile))
    throw new Error('Voting dataset and profile must match the review domain.');
  if (config.promptSections) validatePromptSections(config.promptSections);
  if (
    profile === 'standard' &&
    (config.enabled !== true ||
      config.criteriaApproved !== true ||
      !(config.promptSections
        ? config.promptSections.inclusion.trim()
        : config.criteria?.inclusion?.length))
  ) {
    throw new Error(
      'Save the real review address and its inclusion/exclusion criteria in Project settings before voting.',
    );
  }
}

/** @param {Record<string, any>} config */
export function validateVoteConfig(config) {
  const validated = validateConfig(config);
  assertVotingProfile(validated);
  const decision = /** @type {keyof typeof decisionMap} */ (config.decision);
  if (!Object.hasOwn(decisionMap, decision) || decisionMap[decision] !== config.expectedButton)
    throw new Error('Invalid decision-to-button mapping.');
  const reviewId = new URL(validated.reviewUrl).pathname.match(/^\/reviews\/(\d+)/)?.[1];
  if (!reviewId) throw new Error('Invalid Covidence review address.');
  return {
    ...validated,
    reviewId,
  };
}
