import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile as readProfile } from '../Application/profiles.js';
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'Fixtures');
export function profileFile(name) {
  if (!['demo', 'standard'].includes(name)) throw new Error('Unknown review profile.');
  return path.join(fixtureDir, name + '.json');
}
export function loadProfile(name, studyId) {
  return readProfile(name, studyId, { profileLocation: profileFile });
}

export function decisionResponse(decision, response) {
  return {
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify({ decision, response }) }] }],
  };
}
