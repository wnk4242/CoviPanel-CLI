import { createRequire } from 'node:module';
import path from 'node:path';
import { programDir } from './config.js';

// Installed packages live in Setups so the top level stays focused on the user.
const require = createRequire(path.join(programDir, 'package.json'));
// Node caches each package after its first use. Merely importing an application
// module must not load browser, API or spreadsheet engines.
export function browserLibrary() {
  return require('playwright');
}

export function apiLibraries() {
  return { OpenAI: require('openai').default, dotenv: require('dotenv') };
}

export async function spreadsheetLibrary() {
  return require('exceljs');
}
