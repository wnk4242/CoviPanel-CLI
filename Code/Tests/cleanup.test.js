import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import {
  previewCleanup,
  applyCleanup,
  assertBrowserClosed,
  showCleanup,
} from '../Application/cleanup.js';
import { acquireWorkerLock } from '../Application/queue-store.js';
import { runMainMenu } from '../Application/project-menu.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'covipanel-cleanup-'));
  const data = {
    'Setups/Browser Login/Default/Cache/Cache_Data/data': 'page cache',
    'Setups/Browser Login/Default/Code Cache/js/data': 'code cache',
    'Setups/Browser Login/Default/GPUCache/data': 'graphics cache',
    'Setups/debug.log': 'debug log',
  };
  const protectedFiles = {
    'Setups/State/screening.sqlite': 'database fixture',
    'Setups/State/screening.sqlite-wal': 'active journal',
    'Setups/Settings/.env': 'synthetic fixture key',
    'Setups/Browser Login/Default/Network/Cookies': 'login cookies',
    'Setups/Browser Login/Default/Local Storage/session': 'login state',
    'Setups/Browser Login/Default/Service Worker/CacheStorage/site': 'persistent site storage',
    'Setups/Browser Login/Local State': 'browser configuration',
    'Setups/Backups/screening-sync-latest/before-sync.sqlite.gz': 'latest recovery fixture',
    'Covidence Projects/Review 1/Backups/reset.json': 'reset recovery',
    'Covidence Projects/Review 1/Project settings.json': 'saved criteria',
    'Covidence Projects/Review 1/Decision History.xlsx': 'export fixture',
    'Covidence Projects/Review 1/Screening Log.txt': 'screening history',
    'Covidence Projects/Review 1/Screening Log.txt.old.tmp': 'unclassified file kept',
    'Setups/node_modules/library.js': 'installed library',
  };
  for (const [relative, content] of Object.entries({ ...data, ...protectedFiles })) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, data, protectedFiles };
}

test('cleanup requires explicit yes, lists bullet-point removals/retention and preserves all durable files', async () => {
  const { root, data, protectedFiles } = await fixture();
  try {
    const before = await previewCleanup(root);
    assert.equal(before.files.length, 4);
    const screens = [];
    for (const answer of ['', 'n', 'No', 'maybe']) {
      const result = await showCleanup(async () => answer, {
        root,
        browserCheck: async () => {},
        show: (title, lines) => screens.push({ title, lines }),
      });
      assert.equal(result.cancelled, true);
      assert.deepEqual(await previewCleanup(root), before);
    }
    let prompts = 0;
    const result = await showCleanup(async () => (prompts++ === 0 ? ' YES ' : ''), {
      root,
      browserCheck: async () => {},
      show: (title, lines) => screens.push({ title, lines }),
    });
    assert.equal(result.count, 4);
    assert.equal(
      result.bytes,
      Object.values(data).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    );
    const preview = screens[0].lines.join('\n');
    assert.match(preview, /Will remove:[\s\S]*- Downloaded website cache/);
    assert.match(preview, /Will keep:[\s\S]*- All screening records/);
    assert.match(preview, /- Your saved browser login, cookies and session data/);
    assert.match(preview, /- Your latest recovery backup and all other backups/);
    for (const [file, content] of Object.entries(protectedFiles))
      assert.equal(await readFile(path.join(root, file), 'utf8'), content);
    assert.equal((await previewCleanup(root)).files.length, 0);
    let called = 0;
    const empty = await showCleanup(
      async () => {
        called++;
        return 'yes';
      },
      { root, browserCheck: async () => {}, show: () => {} },
    );
    assert.equal(empty.cancelled, true);
    assert.equal(called, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup refuses a changed preview and never follows a cache or state junction', async () => {
  const { root, protectedFiles } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'covipanel-cleanup-outside-'));
  try {
    const preview = await previewCleanup(root);
    const first = path.join(root, preview.files[0].relative);
    await writeFile(first, 'changed cache content');
    await assert.rejects(applyCleanup(preview), /changed during the preview/);
    assert.equal(await readFile(path.join(root, 'Setups/debug.log'), 'utf8'), 'debug log');
    await writeFile(path.join(outside, 'keep'), 'outside data');
    const cache = path.join(root, 'Setups/Browser Login/Default/Cache');
    await rm(cache, { recursive: true });
    await symlink(outside, cache, 'junction');
    await assert.rejects(previewCleanup(root), /linked elsewhere/);
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'outside data');
    await symlink(outside, path.join(root, 'Setups/State/Maintenance'), 'junction');
    await assert.rejects(
      showCleanup(async () => 'yes', { root, browserCheck: async () => {}, show: () => {} }),
      /linked elsewhere/,
    );
    assert.deepEqual(await readdir(outside), ['keep']);
    for (const [file, content] of Object.entries(protectedFiles))
      assert.equal(await readFile(path.join(root, file), 'utf8'), content);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('cleanup excludes active screening and sync, releases locks on cancellation/errors and rechecks browser before deleting', async () => {
  const { root } = await fixture();
  try {
    for (const relative of ['Setups/State', 'Setups/State/Maintenance']) {
      const release = await acquireWorkerLock(path.join(root, relative));
      try {
        await assert.rejects(
          showCleanup(async () => 'yes', { root, browserCheck: async () => {}, show: () => {} }),
          /running/,
        );
      } finally {
        await release();
      }
    }
    let checks = 0;
    await assert.rejects(
      showCleanup(async () => 'yes', {
        root,
        show: () => {},
        browserCheck: async () => {
          if (++checks === 2) throw new Error('Browser running');
        },
      }),
      /Browser running/,
    );
    assert.equal((await previewCleanup(root)).files.length, 4);
    const release = await acquireWorkerLock(path.join(root, 'Setups/State/Maintenance'));
    await release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser check blocks this persistent profile, allows other profiles and fails closed on unreadable process data', async () => {
  const root = path.resolve('fixture root');
  const profile = path.join(root, 'Setups', 'Browser Login');
  await assert.rejects(
    assertBrowserClosed(root, {
      platform: 'win32',
      execute: async () => ({
        stdout: JSON.stringify([`chrome.exe --headless --user-data-dir="${profile}"`]),
      }),
    }),
    /still running/,
  );
  await assertBrowserClosed(root, {
    platform: 'win32',
    execute: async () => ({
      stdout: JSON.stringify(['chrome.exe --user-data-dir="another profile"']),
    }),
  });
  for (const stdout of ['invalid', '[null]'])
    await assert.rejects(
      assertBrowserClosed(root, { platform: 'win32', execute: async () => ({ stdout }) }),
      /Could not confirm/,
    );
});

test('main-menu cleanup returns to the main menu after asynchronous work without selecting a project', async () => {
  const answers = ['3', '0'],
    screens = [];
  let cleaned = 0;
  await runMainMenu(
    async () => answers.shift(),
    {
      cleanup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        cleaned++;
      },
      create: async () => {
        throw new Error('Must not create');
      },
      list: async () => {
        throw new Error('Must not list projects');
      },
    },
    { show: (title, lines) => screens.push(lines) },
  );
  assert.equal(cleaned, 1);
  assert.equal(screens.length, 2);
  assert.ok(screens.every((lines) => lines.includes('3. Clean temporary files')));
});
