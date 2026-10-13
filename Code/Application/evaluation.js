// @ts-check

/** @typedef {'Include'|'Exclude'|'Maybe'} Decision */
/** @typedef {{reviewUrl:string,studyId:string,referenceDecision:Decision}} Label */
/** @typedef {{reviewUrl:string,studyId:string,decision:Decision|null,replicate:string}} Prediction */

/** @param {{reviewUrl:string,studyId:string}} row */
function caseKey(row) {
  const url = new URL(row.reviewUrl),
    review = url.pathname.match(/^\/reviews\/([1-9]\d*)(?:\/|$)/)?.[1];
  if (!review || !/^\d+$/.test(row.studyId))
    throw new Error('Each evaluation row needs a review URL and numeric studyId.');
  return `${url.origin}/reviews/${review}#${row.studyId}`;
}
/** @param {number} n @param {number} d */
const ratio = (n, d) => (d ? n / d : null);

/** Offline evaluation only. Missing predictions are reported, never counted as correct.
 * @param {Label[]} labels @param {Prediction[]} predictions
 */
export function evaluateScreening(labels, predictions) {
  if (!labels.length || !predictions.length)
    throw new Error('Provide adjudicated labels and at least one prediction.');
  const choices = ['Include', 'Exclude', 'Maybe'];
  const truth = new Map();
  for (const row of labels) {
    const key = caseKey(row);
    if (truth.has(key) || !choices.includes(row.referenceDecision))
      throw new Error('Duplicate or invalid adjudicated label.');
    truth.set(key, row.referenceDecision);
  }
  /** @type {Map<string,Map<string,Decision|null>>} */
  const replicates = new Map();
  for (const row of predictions) {
    const key = caseKey(row);
    if (!truth.has(key)) throw new Error('Prediction has no matching adjudicated label.');
    if (!row.replicate?.trim() || (row.decision !== null && !choices.includes(row.decision)))
      throw new Error('Prediction requires a replicate ID and Include, Exclude, Maybe or null.');
    let run = replicates.get(row.replicate);
    if (!run) {
      run = new Map();
      replicates.set(row.replicate, run);
    }
    if (run.has(key)) throw new Error('Duplicate prediction within a replicate.');
    run.set(key, row.decision);
  }
  const runs = [...replicates].map(([replicate, run]) => {
    let decided = 0,
      agreement = 0,
      maybe = 0,
      eligible = 0,
      eligibleDecided = 0,
      eligibleRetained = 0,
      falseExclusions = 0,
      falseInclusions = 0,
      ambiguousReferences = 0;
    for (const [key, reference] of truth) {
      const decision = run.get(key);
      if (reference === 'Include') eligible++;
      if (reference === 'Maybe') ambiguousReferences++;
      if (decision === null || decision === undefined) continue;
      decided++;
      if (decision === reference) agreement++;
      if (decision === 'Maybe') maybe++;
      if (reference === 'Include') {
        eligibleDecided++;
        if (decision === 'Exclude') falseExclusions++;
        else eligibleRetained++;
      }
      if (reference === 'Exclude' && decision === 'Include') falseInclusions++;
    }
    return {
      replicate,
      labelledCases: truth.size,
      decided,
      missingOrFailed: truth.size - decided,
      decisionCoverage: ratio(decided, truth.size),
      agreementAmongDecided: ratio(agreement, decided),
      maybe,
      maybeRateAmongDecided: ratio(maybe, decided),
      eligible,
      eligibleDecided,
      eligibleMissingOrFailed: eligible - eligibleDecided,
      eligibleCoverage: ratio(eligibleDecided, eligible),
      falseExclusions,
      falseInclusions,
      retentionSensitivityAmongDecided: ratio(eligibleRetained, eligibleDecided),
      ambiguousReferences,
    };
  });
  let repeatedCases = 0,
    disagreements = 0;
  for (const key of truth.keys()) {
    const values = [...replicates.values()]
      .map((run) => run.get(key))
      .filter((value) => value !== null && value !== undefined);
    if (values.length > 1) {
      repeatedCases++;
      if (new Set(values).size > 1) disagreements++;
    }
  }
  return {
    labelledCases: truth.size,
    runs,
    repeatability: {
      casesWithMultipleDecisions: repeatedCases,
      disagreements,
      disagreementRate: ratio(disagreements, repeatedCases),
    },
    notes: [
      'Human Maybe labels are excluded from eligibility sensitivity and false inclusion/exclusion counts.',
      'Retained eligible studies include AI Include and Maybe; always inspect eligible coverage alongside sensitivity.',
      'These results describe only the supplied adjudicated dataset, not general screening accuracy.',
    ],
  };
}
