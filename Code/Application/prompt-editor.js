import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { promptLabels, promptTextLimit } from './prompt-sections.js';
import { showScreen } from './terminal-screen.js';

async function openEditor(file) {
  if (process.platform !== 'win32') return;
  await new Promise((resolve, reject) => {
    const child = spawn('notepad.exe', [file], { shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function editPromptSection(
  question,
  key,
  current,
  { open = openEditor, show = showScreen, tempRoot = os.tmpdir() } = {},
) {
  const label = promptLabels[key];
  if (!label) throw new Error('Unknown prompt section.');
  const folder = await mkdtemp(path.join(tempRoot, 'covipanel-prompt-'));
  const file = path.join(folder, `${label}.txt`);
  try {
    await writeFile(file, current, 'utf8');
    show(
      `CoviPanel | ${label}`,
      [
        'Enter or paste the complete text in Notepad. Line breaks are preserved.',
        'Save with Ctrl+S, close Notepad, then return here and press Enter.',
        'Then choose 7. Save and continue to save your project settings.',
        'Type /cancel here to keep the previous text.',
        '',
        file,
        ...(key === 'responseFormat'
          ? [
              '',
              'Use any fields, paragraphs, tables or language. No Decision: or Rationale: field is required.',
              'Leave this empty for a concise explanation.',
              'CoviPanel receives the voting decision separately from your formatted reply.',
            ]
          : []),
      ],
      '',
    );
    await open(file);
    if (
      (await question('Press Enter after saving (/cancel discards this edit): ')).trim() ===
      '/cancel'
    )
      return null;
    const bytes = await readFile(file);
    if (bytes.length > promptTextLimit * 4 + 2) throw new Error('Prompt section is too large.');
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.length > promptTextLimit)
      throw new Error(
        `Keep this section within ${promptTextLimit.toLocaleString('en-US')} characters.`,
      );
    if (key === 'inclusion' && !text.trim()) throw new Error(`${label} cannot be empty.`);
    return text;
  } finally {
    // Delete only this editor's own file and then its empty temporary directory.
    await unlink(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(folder);
  }
}
