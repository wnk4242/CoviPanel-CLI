import path from 'node:path';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { browserLibrary } from './dependencies.js';
import {
  profileDir,
  dataDir,
  profilesIndex,
  projectsDir,
  reviewFolder,
  activeProfile,
  profileForReview,
  screeningAddress,
  normalizeProjectName,
  validateConfig,
} from './config.js';
import { loadProfile, validateProfile, criteriaApproval } from './profiles.js';
import { emptyProfile } from './defaults.js';
import { QueueStore, acquireWorkerLock } from './queue-store.js';
import { assertUnscreenedUrl } from './discovery.js';
import { openReview } from './browser-mode.js';
import { showScreen } from './terminal-screen.js';
import { editableSettings } from './prompt-sections.js';
import { editPromptSection } from './prompt-editor.js';

export async function reviewDraft(current, address, { projectLocation = reviewFolder } = {}) {
  const reviewUrl = screeningAddress(address),
    profile = profileForReview(reviewUrl);
  let source;
  try {
    source = JSON.parse(
      await readFile(path.join(projectLocation(reviewUrl), 'Project settings.json'), 'utf8'),
    );
    if (screeningAddress(source.reviewUrl) !== reviewUrl)
      throw new Error('Saved project settings belong to a different review.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (current.reviewUrl && screeningAddress(current.reviewUrl) === reviewUrl) source = current;
    else {
      source = {
        ...emptyProfile(profile),
        openai: { ...current.openai },
      };
    }
  }
  return { ...source, reviewUrl };
}

export async function saveSettings(
  draft,
  {
    file,
    baseDir = dataDir,
    loadCurrent = () => loadProfile(activeProfile(), '1'),
    projectLocation = reviewFolder,
    indexFile = profilesIndex,
    projectRoot = projectsDir,
  } = {},
) {
  draft = {
    ...draft,
    projectName: normalizeProjectName(draft.projectName),
    reviewUrl: screeningAddress(draft.reviewUrl),
    enabled: true,
    criteriaApproved: true,
  };
  draft.criteriaApproval = criteriaApproval(draft);
  const profile = profileForReview(draft.reviewUrl);
  assertUnscreenedUrl(draft.reviewUrl, draft.reviewUrl);
  await validateProfile(draft, profile, '1');
  const target = file || path.join(projectLocation(draft.reviewUrl), 'Project settings.json');
  const release = await acquireWorkerLock(baseDir);
  let store;
  const temp = `${target}.${randomUUID()}.tmp`,
    indexTemp = `${indexFile}.${randomUUID()}.tmp`;
  try {
    let previous;
    try {
      previous = await loadCurrent();
    } catch (error) {
      // A first-run or damaged active profile must not prevent saving repaired
      // settings. Legacy jobs with missing snapshots still require valid input.
      const probe = new QueueStore(path.join(baseDir, 'screening.sqlite'));
      try {
        if (
          probe.db
            .prepare(
              'SELECT 1 FROM jobs LEFT JOIN job_settings ON jobs.id=job_settings.job_id WHERE job_settings.job_id IS NULL LIMIT 1',
            )
            .get()
        )
          throw error;
      } finally {
        probe.close();
      }
    }
    store = new QueueStore(path.join(baseDir, 'screening.sqlite'));
    if (previous) store.preserveSettings(previous);
    draft.settingsSavedAt = new Date().toISOString();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temp, JSON.stringify(draft, null, 2) + '\n');
    await rename(temp, target);
    if (!file) {
      let index;
      try {
        index = JSON.parse(await readFile(indexFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        index = {};
      }
      index[profile] = path.relative(projectRoot, target).split(path.sep).join('/');
      index.active = profile;
      await writeFile(indexTemp, JSON.stringify(index, null, 2) + '\n');
      await rename(indexTemp, indexFile);
    }
  } finally {
    try {
      store?.close();
      for (const tempFile of [temp, indexTemp])
        await unlink(tempFile).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    } finally {
      await release();
    }
  }
}

async function login(question, config) {
  const { chromium } = browserLibrary();
  const release = await acquireWorkerLock(dataDir);
  let context;
  try {
    showScreen(
      'CoviPanel | Covidence login',
      [
        'Enter your username and password in the Chromium window.',
        'Complete any additional sign-in steps there.',
        'Your browser session will be saved for visible and headless runs.',
      ],
      '',
    );
    context = await chromium.launchPersistentContext(profileDir, { headless: false });
    const page = context.pages()[0] || (await context.newPage());
    await openReview(page, config, 'visible', question);
    await question('Review access verified. Press Enter to save the session and close Chromium. ');
  } finally {
    try {
      await context?.close();
    } finally {
      await release();
    }
  }
}

export async function projectSettings(
  question,
  {
    readCurrent,
    save = saveSettings,
    edit = editPromptSection,
    show = showScreen,
    lockedReview = null,
  } = {},
) {
  const saved = await readCurrent();
  if (lockedReview && screeningAddress(saved.reviewUrl) !== screeningAddress(lockedReview))
    throw new Error('Settings must belong to the selected project.');
  let draft = editableSettings(saved);
  let dirty = !saved.promptSections;
  while (true) {
    show(
      'CoviPanel | Project settings',
      [
        `Project name: ${draft.projectName || '(not set — uses the review number)'}`,
        `Review: ${draft.reviewUrl}`,
        `Prompt: ${draft.promptSections.inclusion.length} inclusion / ${draft.promptSections.exclusion.length} exclusion / ${draft.promptSections.responseFormat.length} response-format characters`,
        `AI model: ${draft.openai.model}`,
        dirty
          ? 'Unsaved changes — choose 7 to save them.'
          : 'Settings saved in Project settings.json',
        '',
        '1. Project name',
        '2. Log in to Covidence / refresh saved login',
        '3. Enter or paste inclusion criteria',
        '4. Enter or paste exclusion criteria',
        '5. Enter or paste response format (optional)',
        '6. AI model and response token limit',
        '7. Save and continue',
        '0. Back',
      ],
      '',
    );
    const choice = await question('Choose an option: ');
    if (choice === '0') {
      if (dirty) {
        const action = (
          await question('Unsaved changes: s = save, d = discard, Enter = keep editing: ')
        ).toLowerCase();
        if (action === 's') {
          try {
            await save(draft);
            return { saved: true, settings: draft };
          } catch (error) {
            await question(`${error.message}\nPress Enter to keep editing. `);
            continue;
          }
        }
        if (action !== 'd') continue;
      }
      return;
    }
    try {
      if (choice === '1') {
        show(
          'CoviPanel | Project details',
          [
            `Project name: ${draft.projectName || '(not set)'}`,
            `Current: ${draft.reviewUrl}`,
            'Paste with Ctrl+V or right-click. Enter keeps the current name.',
          ],
          '',
        );
        const enteredName = await question(
          `Project name [${draft.projectName || 'not set'}] (Enter keeps; /clear removes): `,
        );
        const projectName = normalizeProjectName(
          enteredName === '/clear' ? '' : enteredName || draft.projectName,
        );
        draft = { ...draft, projectName };
        dirty = true;
      } else if (choice === '2') {
        await login(
          question,
          validateConfig({ ...draft, reviewUrl: screeningAddress(draft.reviewUrl), studyId: '1' }),
        );
      } else if (['3', '4', '5'].includes(choice)) {
        const key = { 3: 'inclusion', 4: 'exclusion', 5: 'responseFormat' }[choice];
        const text = await edit(question, key, draft.promptSections[key]);
        if (text !== null && text !== draft.promptSections[key]) {
          draft = {
            ...draft,
            promptSections: { ...draft.promptSections, [key]: text },
            criteriaVersion: `custom-${randomUUID()}`,
          };
          dirty = true;
        }
      } else if (choice === '6') {
        show(
          'CoviPanel | AI settings',
          [
            `Model: ${draft.openai.model}`,
            `Response token limit: ${draft.openai.maxOutputTokens}`,
            'Enter keeps the current value. The API key is in Setups/Settings/.env.',
          ],
          '',
        );
        const model = await question('Model name: ');
        const tokens = await question('Response token limit (256–8000): ');
        const candidate = {
          ...draft,
          openai: {
            ...draft.openai,
            model: model || draft.openai.model,
            maxOutputTokens: tokens ? Number(tokens) : draft.openai.maxOutputTokens,
          },
        };
        if (
          !/^[a-zA-Z0-9._-]+$/.test(candidate.openai.model) ||
          !Number.isInteger(candidate.openai.maxOutputTokens) ||
          candidate.openai.maxOutputTokens < 256 ||
          candidate.openai.maxOutputTokens > 8000
        )
          throw new Error('Enter a valid model name and a response token limit from 256 to 8000.');
        draft = candidate;
        dirty = true;
      } else if (choice === '7') {
        await save(draft);
        return { saved: true, settings: draft };
      }
    } catch (error) {
      await question(`${error.message}\nPress Enter to return to settings. `);
    }
  }
}
