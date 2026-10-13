import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const programDir = path.join(projectDir, 'Setups');
export const projectsDir = path.join(projectDir, 'Covidence Projects');
export const settingsDir = path.join(programDir, 'Settings');
export const profileDir = path.join(programDir, 'Browser Login');
export const dataDir = path.join(programDir, 'State');
export const databasePath = path.join(dataDir, 'screening.sqlite');
export const profilesIndex = path.join(settingsDir, 'projects.json');
export function activeProfile() {
  const name = JSON.parse(readFileSync(profilesIndex, 'utf8')).active || 'demo';
  if (!['demo', 'standard'].includes(name)) throw new Error('Unknown active review profile.');
  return name;
}
/** @param {string} address */
export function profileForReview(address) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('Use an HTTPS Covidence review address.');
  if (url.hostname === 'demo.covidence.org') return 'demo';
  if (url.hostname === 'app.covidence.org') return 'standard';
  throw new Error('Use a demo.covidence.org or app.covidence.org review address.');
}
/** @param {unknown} input */
export function screeningAddress(input) {
  let text = String(input).trim();
  const markdown = text.match(/^\[[^\]\r\n]*\]\((https:\/\/[^\s)]+)\)$/);
  if (markdown) text = markdown[1];
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      'Paste a Covidence review address, such as https://demo.covidence.org/reviews/160736.',
    );
  }
  profileForReview(url.href);
  const match = url.pathname.match(/^\/reviews\/([1-9]\d*)(?:\/(?:review_studies\/)?screen)?\/?$/);
  if (
    !match ||
    url.hash ||
    [...url.searchParams.keys()].some((k) => k !== 'filter') ||
    url.searchParams.getAll('filter').length > 1 ||
    (url.searchParams.has('filter') && url.searchParams.get('filter') !== 'vote_required_from')
  )
    throw new Error(
      'Use the review address or Screen references address without a study search or other filters.',
    );
  url.pathname = `/reviews/${match[1]}/review_studies/screen`;
  url.searchParams.set('filter', 'vote_required_from');
  return url.href;
}
/** @param {string} name */
export function profileFile(name) {
  if (!['demo', 'standard'].includes(name)) throw new Error('Unknown review profile.');
  const relative = JSON.parse(readFileSync(profilesIndex, 'utf8'))[name];
  if (typeof relative !== 'string') throw new Error('Missing project settings location.');
  const file = path.resolve(projectsDir, relative);
  if (!file.startsWith(projectsDir + path.sep))
    throw new Error('Project settings must stay inside Covidence Projects.');
  return file;
}
/** @param {string} reviewUrl */
export function reviewFolder(reviewUrl) {
  const url = new URL(reviewUrl),
    id = url.pathname.match(/^\/reviews\/(\d+)(?:\/|$)/)?.[1];
  if (
    url.protocol !== 'https:' ||
    !['demo.covidence.org', 'app.covidence.org'].includes(url.hostname) ||
    !id
  )
    throw new Error('Invalid Covidence review address.');
  return path.join(
    projectsDir,
    `${url.hostname === 'demo.covidence.org' ? 'Demo Review' : 'Review'} ${id}`,
  );
}

/** @param {unknown} value */
export function normalizeProjectName(value = '') {
  if (typeof value !== 'string') throw new Error('Project name must be text.');
  // eslint-disable-next-line no-control-regex -- Names must fit safely on one terminal line.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value))
    throw new Error('Project name must be a single line without control characters.');
  const name = value.trim();
  if ([...name].length > 120) throw new Error('Keep the project name within 120 characters.');
  return name;
}

/**
 * @param {string} reviewUrl
 * @param {{projectName?: string, projectLocation?: (reviewUrl: string) => string}} [options]
 */
export function projectLabel(reviewUrl, { projectName, projectLocation = reviewFolder } = {}) {
  const identity = path.basename(reviewFolder(reviewUrl));
  if (projectName === undefined) {
    try {
      const settings = JSON.parse(
        readFileSync(path.join(projectLocation(reviewUrl), 'Project settings.json'), 'utf8'),
      );
      if (screeningAddress(settings.reviewUrl) === screeningAddress(reviewUrl))
        projectName = normalizeProjectName(settings.projectName);
    } catch {
      // Optional display metadata must not prevent access to saved batches.
    }
  }
  const name = normalizeProjectName(projectName);
  return name ? `${name} (${identity})` : identity;
}

/** @param {Record<string, any>} config */
export function validateConfig(config) {
  let url;
  try {
    url = new URL(config.reviewUrl);
  } catch {
    throw new Error('Set the Covidence screening URL in Project settings.');
  }
  if (
    url.protocol !== 'https:' ||
    !['app.covidence.org', 'demo.covidence.org'].includes(url.hostname) ||
    !/^\/reviews\/\d+(?:\/|$)/.test(url.pathname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'reviewUrl must be an HTTPS app.covidence.org or demo.covidence.org /reviews/<numeric ID>/... URL.',
    );
  }
  const studyId = String(config.studyId ?? '')
    .trim()
    .replace(/^#/, '');
  if (!/^[1-9]\d*$/.test(studyId))
    throw new Error('studyId must be ONE positive numeric ID, not a list or range.');
  if (typeof config.headless !== 'boolean') throw new Error('headless must be a boolean.');
  const timeoutMs = config.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be an integer from 1000 to 120000.');
  }
  const selectors = config.selectors ?? {};
  if (
    !selectors ||
    typeof selectors !== 'object' ||
    Array.isArray(selectors) ||
    Object.values(selectors).some((value) => typeof value !== 'string')
  ) {
    throw new Error('selectors must be an object of CSS selector strings.');
  }
  return {
    ...config,
    projectName: normalizeProjectName(config.projectName),
    studyId,
    timeoutMs,
    selectors,
    reviewUrl: url.href,
  };
}
