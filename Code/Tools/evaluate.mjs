import { readFile, writeFile } from 'node:fs/promises';
import { evaluateScreening } from '../Application/evaluation.js';

const [labelsFile, predictionsFile, output, ...extra] = process.argv.slice(2);
if (!labelsFile || !predictionsFile || extra.length)
  throw new Error(
    'Usage: evaluate.mjs <labels.json> <predictions.json> [new-report.json]. This tool makes no AI requests.',
  );
const labels = JSON.parse(await readFile(labelsFile, 'utf8')),
  predictions = JSON.parse(await readFile(predictionsFile, 'utf8'));
const result = evaluateScreening(labels, predictions);
const text = JSON.stringify(result, null, 2) + '\n';
if (output) await writeFile(output, text, { flag: 'wx' });
console.log(text);
