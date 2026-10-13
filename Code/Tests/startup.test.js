import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { cp, copyFile, mkdir, mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectDir } from '../Application/config.js';
import { assertSupportedNode } from '../Application/setup.js';

async function isolatedProgram() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'covipanel-startup-test-'));
  await cp(path.join(projectDir, 'Code/Application'), path.join(root, 'Code/Application'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'Setups'));
  await copyFile(
    path.join(projectDir, 'Setups/package.json'),
    path.join(root, 'Setups/package.json'),
  );
  await copyFile(
    path.join(projectDir, 'Start CoviPanel.cmd'),
    path.join(root, 'Start CoviPanel.cmd'),
  );
  return root;
}

// Exercise the real launcher against source-only, temporary settings. The child
// reads scripted terminal input but cannot load a browser, API or spreadsheet SDK.
function runLauncher(root, answers, { shortcut = false } = {}) {
  const preload = `import Module from 'node:module';const original=Module._load;Module._load=function(name,...args){if(['playwright','openai','exceljs'].includes(name))throw new Error('Unexpected startup dependency: '+name);return original.call(this,name,...args);};Object.defineProperty(process.stdin,'isTTY',{value:true});`;
  const launch = pathToFileURL(path.join(root, 'Code/Application/launcher.js')).href;
  return new Promise((resolve, reject) => {
    let output = '',
      errors = '',
      from = 0,
      answered = 0;
    const child = spawn(
      shortcut ? process.env.ComSpec || 'cmd.exe' : process.execPath,
      shortcut
        ? ['/d', '/c', path.join(root, 'Start CoviPanel.cmd')]
        : ['--input-type=module', '-e', preload + `await import(${JSON.stringify(launch)});`],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_PATH: '',
          NODE_OPTIONS: shortcut
            ? '--import=data:text/javascript,' + encodeURIComponent(preload)
            : '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Launcher did not finish: ' + errors + output));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on('data', (bytes) => {
      output += bytes;
      if (answered >= answers.length) return;
      const [prompt, answer] = answers[answered];
      const at = output.indexOf(prompt, from);
      if (at >= 0) {
        from = at + prompt.length;
        answered++;
        child.stdin.write(answer + '\n');
      }
    });
    child.stderr.on('data', (bytes) => {
      errors += bytes;
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || answered !== answers.length)
        return reject(new Error(`Launcher exited ${code}: ${errors}\n${output}`));
      resolve(output);
    });
  });
}

test('the main menu and saved-project list work without loading screening SDKs', async () => {
  const root = await isolatedProgram();
  const metadataFile = path.join(root, 'Setups/package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  await writeFile(metadataFile, JSON.stringify({ ...metadata, version: '9.8.7' }));
  const output = await runLauncher(root, [
    ['Choose an option:', '2'],
    ['Choose a project:', '0'],
    ['Choose an option:', '0'],
  ]);
  assert.match(output, /Start a new screening/);
  assert.match(output, /CoviPanel v9\.8\.7/);
  assert.match(output, /No saved projects yet/);
  await assert.rejects(
    access(path.join(root, 'Setups/State/screening.sqlite')),
    (error) => error.code === 'ENOENT',
  );
  assert.equal(
    await readFile(path.join(root, 'Setups/Settings/.env'), 'utf8'),
    'OPENAI_API_KEY=replace_with_your_openai_api_key\n',
  );
});

test('the real launcher deletes a confirmed local project and does not recreate it on restart', async () => {
  const root = await isolatedProgram();
  const folder = path.join(root, 'Covidence Projects', 'Demo Review 123');
  const settings = path.join(root, 'Setups', 'Settings');
  await mkdir(folder, { recursive: true });
  await mkdir(settings);
  await writeFile(
    path.join(folder, 'Project settings.json'),
    JSON.stringify({
      projectName: 'Temporary deletion fixture',
      reviewUrl:
        'https://demo.covidence.org/reviews/123/review_studies/screen?filter=vote_required_from',
    }),
  );
  await writeFile(
    path.join(settings, 'projects.json'),
    JSON.stringify({ active: 'demo', demo: 'Demo Review 123/Project settings.json' }),
  );
  const output = await runLauncher(root, [
    ['Choose an option:', '2'],
    ['Choose a project:', 'd'],
    ['Choose a project to delete:', '1'],
    ['Type DELETE to confirm (Enter cancels):', 'DELETE'],
    ['Press Enter to return to saved projects.', ''],
    ['Choose a project:', '0'],
    ['Choose an option:', '0'],
  ]);
  assert.match(output, /Deleted Temporary deletion fixture/);
  assert.match(output, /No saved projects yet/);
  await assert.rejects(access(folder), (error) => error.code === 'ENOENT');
  const restarted = await runLauncher(root, [
    ['Choose an option:', '2'],
    ['Choose a project:', '0'],
    ['Choose an option:', '0'],
  ]);
  assert.match(restarted, /No saved projects yet/);
  assert.equal(
    JSON.parse(await readFile(path.join(settings, 'projects.json'), 'utf8')).demo,
    undefined,
  );
});

test(
  'the Windows shortcut reaches the actual main menu and exits from a path containing spaces',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await isolatedProgram();
    const spaced = path.join(root, 'Folder with spaces');
    await mkdir(spaced);
    await cp(path.join(root, 'Code'), path.join(spaced, 'Code'), { recursive: true });
    await cp(path.join(root, 'Setups'), path.join(spaced, 'Setups'), { recursive: true });
    await copyFile(
      path.join(root, 'Start CoviPanel.cmd'),
      path.join(spaced, 'Start CoviPanel.cmd'),
    );
    const output = await runLauncher(spaced, [['Choose an option:', '0']], { shortcut: true });
    const { version } = JSON.parse(
      await readFile(path.join(spaced, 'Setups/package.json'), 'utf8'),
    );
    assert.ok(output.includes('CoviPanel v' + version));
  },
);

test('screening modules can be imported without loading browser or API engines', async () => {
  const root = await isolatedProgram();
  const source =
    `import Module from 'node:module';const original=Module._load;Module._load=function(name,...args){if(['playwright','openai','exceljs'].includes(name))throw new Error('Eager dependency '+name);return original.call(this,name,...args);};` +
    ['settings.js', 'screening-session.js', 'openai.js', 'history-export.js', 'project-backups.js']
      .map(
        (file) =>
          `await import(${JSON.stringify(pathToFileURL(path.join(root, 'Code/Application', file)).href)});`,
      )
      .join('');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      windowsHide: true,
    });
    let errors = '';
    child.stderr.on('data', (bytes) => {
      errors += bytes;
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(errors))));
  });
});

test('the obsolete worker export alias is rejected before creating local state', async () => {
  const root = await isolatedProgram();
  const worker = path.join(root, 'Code/Application/worker.js');
  const result = await new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(process.execPath, [worker, 'export'], {
      cwd: root,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Worker command validation did not finish.'));
    }, 10000);
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (output += bytes));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /Commands: start, resume, status, recover/);
  assert.doesNotMatch(result.output, /status, export/);
  await assert.rejects(
    access(path.join(root, 'Setups/State/screening.sqlite')),
    (error) => error.code === 'ENOENT',
  );
});

test('the launcher validates the minimum Node runtime without a second Node process', () => {
  for (const version of ['22.13.0', '22.20.0', '23.0.0', '24.16.0'])
    assert.doesNotThrow(() => assertSupportedNode(version));
  for (const version of ['20.19.0', '21.7.0', '22.12.0', 'invalid'])
    assert.throws(() => assertSupportedNode(version), /22.13/);
});
