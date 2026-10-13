import path from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { projectDir } from './config.js';
import { emptyProfile } from './defaults.js';

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 22 ||
    (major === 22 && minor < 13)
  )
    throw new Error('Node.js 22.13 or newer is required.');
}

async function createOnly(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// Explicit first-run setup; importing application modules never creates files.
// Existing settings and API credentials are never replaced.
export async function initializeSettings(root = projectDir) {
  const settings = path.join(root, 'Setups', 'Settings');
  const index = {
    active: 'demo',
    demo: 'Unconfigured demo/Project settings.json',
    standard: 'Unconfigured review/Project settings.json',
  };
  const created = [];
  let configured = false;
  try {
    await access(path.join(settings, 'projects.json'));
    configured = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!configured) {
    for (const name of ['demo', 'standard']) {
      const file = path.join(root, 'Covidence Projects', index[name]);
      if (await createOnly(file, JSON.stringify(emptyProfile(name), null, 2) + '\n'))
        created.push(file);
    }
  }
  const files = [
    [path.join(settings, 'projects.json'), JSON.stringify(index, null, 2) + '\n'],
    [path.join(settings, '.env'), 'OPENAI_API_KEY=replace_with_your_openai_api_key\n'],
  ];
  for (const [file, content] of files) if (await createOnly(file, content)) created.push(file);
  return created;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.join(projectDir, 'Code', 'Application', 'setup.js')
) {
  const created = await initializeSettings();
  console.log(
    `${created.length} missing configuration files created. Open Project settings to enter your review, criteria and model. Existing files were preserved.`,
  );
}
