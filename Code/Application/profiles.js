import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { projectDir, validateConfig, profileFile, screeningAddress } from './config.js';
import { buildPrompt } from './prompt-sections.js';

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const studyHash = (study) =>
  hash({
    studyId: study.studyId,
    title: study.title,
    abstract: study.abstract,
    author: study.author || '',
    year: study.year || '',
  });
export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const criteriaApproval = (settings) =>
  hash({
    reviewUrl: screeningAddress(settings.reviewUrl),
    criteriaVersion: settings.criteriaVersion,
    ...(settings.promptSections
      ? { promptSections: settings.promptSections }
      : { criteria: settings.criteria }),
  });

export async function loadProfile(
  name,
  studyId,
  { profileLocation = profileFile, root = projectDir } = {},
) {
  if (!['demo', 'standard'].includes(name)) throw new Error('Unknown review profile.');
  const settings = JSON.parse(await readFile(profileLocation(name), 'utf8'));
  return validateProfile(settings, name, studyId, { root });
}

export async function validateProfile(settings, name, studyId, { root = projectDir } = {}) {
  if (settings.enabled !== true || settings.criteriaApproved !== true)
    throw new Error(
      `Profile ${name} is disabled until its review URL and screening criteria are configured and approved.`,
    );
  if (settings.criteriaApproval && settings.criteriaApproval !== criteriaApproval(settings))
    throw new Error(
      'Review address or criteria changed since approval. Save and approve this review in Project settings.',
    );
  const expectedDataset = name === 'demo' ? 'demo-vitamin-c-common-cold' : 'standard-review';
  const origin = name === 'demo' ? 'https://demo.covidence.org' : 'https://app.covidence.org';
  const config = validateConfig({ ...settings, studyId });
  if (config.dataset !== expectedDataset || new URL(config.reviewUrl).origin !== origin)
    throw new Error('Review domain and dataset do not match the selected profile.');
  if (!config.criteriaVersion) throw new Error('Provide versioned review criteria.');
  if (
    !config.promptSections &&
    (!config.criteriaVersion ||
      !Array.isArray(config.criteria?.inclusion) ||
      !config.criteria.inclusion.length ||
      !['inclusion', 'exclusion', 'interpretation'].every(
        (key) =>
          Array.isArray(config.criteria[key]) &&
          config.criteria[key].every((value) => typeof value === 'string' && value.trim()),
      ))
  )
    throw new Error('Provide valid versioned review criteria.');
  if (
    !/^[a-zA-Z0-9._-]+$/.test(config.openai?.model || '') ||
    !Number.isInteger(config.openai.maxOutputTokens) ||
    config.openai.maxOutputTokens < 256 ||
    config.openai.maxOutputTokens > 8000 ||
    !Number.isInteger(config.openai.timeoutMs) ||
    config.openai.timeoutMs < 1000 ||
    config.openai.timeoutMs > 120000
  )
    throw new Error('Invalid OpenAI model/token/timeout configuration.');
  let prompt;
  if (config.promptSections) {
    if (
      ['criteria', 'promptFile', 'responseInstructions', 'responseFormat'].some((key) =>
        Object.hasOwn(config, key),
      )
    )
      throw new Error('Use only the three prompt sections; remove legacy prompt settings.');
    prompt = buildPrompt(config.promptSections);
  } else {
    // Legacy saved batches retain their original prompt and cache identity.
    if (typeof config.promptFile !== 'string') throw new Error('Provide a promptFile path.');
    // Saved settings and older backups may still name the former runtime folder.
    const promptFile = config.promptFile.replace(/^Program[\\/]/, 'Setups/');
    const promptPath = path.resolve(root, promptFile);
    const relative = path.relative(root, promptPath);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Prompt file must stay within the project.');
    prompt = await readFile(promptPath, 'utf8');
    if (!prompt.trim()) throw new Error('Prompt file is empty.');
    if (
      config.responseInstructions !== undefined &&
      (typeof config.responseInstructions !== 'string' || config.responseInstructions.length > 8000)
    )
      throw new Error('Response instructions must be text up to 8,000 characters.');
    if (config.responseFormat !== undefined && config.responseFormat !== 'standard')
      throw new Error('Unknown response format.');
  }
  const configHash = hash({
    dataset: config.dataset,
    reviewUrl: config.reviewUrl,
    criteriaVersion: config.criteriaVersion,
    ...(config.promptSections
      ? { promptSections: config.promptSections }
      : { criteria: config.criteria }),
    prompt,
    openai: config.openai,
    ...(config.responseInstructions ? { responseInstructions: config.responseInstructions } : {}),
  });
  return {
    ...config,
    profile: name,
    prompt,
    configHash,
    reviewId: new URL(config.reviewUrl).pathname.match(/^\/reviews\/(\d+)/)[1],
  };
}
