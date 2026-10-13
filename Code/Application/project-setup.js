import { readFile } from 'node:fs/promises';
import { activeProfile, profileFile, screeningAddress, profileForReview } from './config.js';
import { projectSettings, reviewDraft } from './settings.js';
import { emptyProfile } from './defaults.js';
import { showScreen } from './terminal-screen.js';
import { readProject } from './projects.js';

export async function createProject(
  question,
  {
    show = showScreen,
    read = readProject,
    prepare = reviewDraft,
    configure = projectSettings,
    readPrevious = async () => JSON.parse(await readFile(profileFile(activeProfile()), 'utf8')),
  } = {},
) {
  show(
    'CoviPanel | Start a new screening',
    [
      'Enter the Covidence review address to set up your project.',
      'An existing review opens its saved project.',
    ],
    '',
  );
  const address = await question('Covidence review address (Enter cancels): ');
  if (!address) return null;
  const url = screeningAddress(address);
  try {
    return await read(url);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let previous;
  try {
    previous = await readPrevious();
  } catch {
    previous = emptyProfile(profileForReview(url));
  }
  const draft = await prepare(previous, url);
  draft.projectName = await question('Project name: ');
  const result = await configure(question, {
    readCurrent: async () => draft,
    lockedReview: url,
  });
  return result?.saved ? read(url) : null;
}
