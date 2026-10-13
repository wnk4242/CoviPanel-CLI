import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScreening } from '../Application/evaluation.js';

const reviewUrl = 'https://demo.covidence.org/reviews/1';
const labels = [
  { reviewUrl, studyId: '1', referenceDecision: 'Include' },
  { reviewUrl, studyId: '2', referenceDecision: 'Include' },
  { reviewUrl, studyId: '3', referenceDecision: 'Exclude' },
  { reviewUrl, studyId: '4', referenceDecision: 'Maybe' },
];
test('evaluation separates false exclusions, missing decisions and repeated-run disagreement', () => {
  const predictions = [
    ['1', 'Exclude', 'a'],
    ['2', null, 'a'],
    ['3', 'Include', 'a'],
    ['4', 'Maybe', 'a'],
    ['1', 'Maybe', 'b'],
    ['2', 'Include', 'b'],
  ].map(([studyId, decision, replicate]) => ({ reviewUrl, studyId, decision, replicate }));
  const result = evaluateScreening(labels, predictions),
    [a, b] = result.runs;
  assert.equal(a.falseExclusions, 1);
  assert.equal(a.falseInclusions, 1);
  assert.equal(a.eligibleMissingOrFailed, 1);
  assert.equal(a.eligibleCoverage, 0.5);
  assert.equal(a.retentionSensitivityAmongDecided, 0);
  assert.equal(b.retentionSensitivityAmongDecided, 1);
  assert.equal(b.missingOrFailed, 2);
  assert.deepEqual(result.repeatability, {
    casesWithMultipleDecisions: 1,
    disagreements: 1,
    disagreementRate: 1,
  });
});
test('evaluation rejects duplicate identities, unmatched predictions and reports undefined rates as null', () => {
  const prediction = { reviewUrl, studyId: '1', replicate: 'a', decision: null };
  assert.throws(() => evaluateScreening([...labels, labels[0]], [prediction]), /Duplicate/);
  assert.throws(() => evaluateScreening(labels, [prediction, prediction]), /Duplicate/);
  assert.throws(
    () =>
      evaluateScreening(labels, [
        { ...prediction, reviewUrl: 'https://demo.covidence.org/reviews/2' },
      ]),
    /matching/,
  );
  const result = evaluateScreening(labels, [prediction]);
  assert.equal(result.runs[0].retentionSensitivityAmongDecided, null);
  assert.equal(result.runs[0].decisionCoverage, 0);
});
