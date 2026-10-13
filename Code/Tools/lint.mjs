import { createRequire } from 'node:module';
import path from 'node:path';
import { projectDir, programDir } from '../Application/config.js';

const require = createRequire(path.join(programDir, 'package.json'));
const { ESLint } = require('eslint');
const eslint = new ESLint({
  cwd: projectDir,
  overrideConfigFile: path.join(projectDir, 'Code/Tools/Config/eslint.config.mjs'),
});
const results = await eslint.lintFiles(['Code']);
const formatter = await eslint.loadFormatter('stylish');
const output = formatter.format(results);
if (output) console.log(output);
if (results.some((result) => result.errorCount || result.warningCount)) process.exitCode = 1;
