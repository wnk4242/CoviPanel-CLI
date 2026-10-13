import { randomUUID } from 'node:crypto';

// The profile IDs remain compatible with saved v1.0 jobs. The topic and criteria
// belong to individual reviews; a domain must never supply another review's rules.
/** @param {'demo'|'standard'} [profile] */
export function emptyProfile(profile = 'demo') {
  if (!['demo', 'standard'].includes(profile)) throw new Error('Unknown review profile.');
  return {
    dataset: profile === 'demo' ? 'demo-vitamin-c-common-cold' : 'standard-review',
    enabled: false,
    criteriaApproved: false,
    projectName: '',
    reviewUrl: '',
    headless: false,
    timeoutMs: 30000,
    selectors: {},
    criteriaVersion: `custom-${randomUUID()}`,
    promptSections: { inclusion: '', exclusion: '', responseFormat: '' },
    openai: { model: 'gpt-4.1-mini-2025-04-14', maxOutputTokens: 1500, timeoutMs: 60000 },
  };
}
