import { randomUUID } from 'node:crypto';
import { hash, studyHash, uuidPattern } from './profiles.js';
import { buildRequest, safeApiError, safeApiDetails } from './openai.js';
import { parseRecommendation } from './ai-parser.js';
import { decisionMap } from './decisions.js';
import { withRecords } from './records.js';
import { RESPONSE_FORMAT_NAME } from './response-contract.js';
import { screeningDevice } from './screening-device.js';

const PARSER_VERSION = '1.1.7';

// Persist response data needed to diagnose or reparse decisions. Transport
// headers, client options and credentials never enter this record.
function responsePayload(response) {
  return Object.fromEntries(
    ['id', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details']
      .filter((key) => response[key] !== undefined)
      .map((key) => [key, response[key]]),
  );
}

export async function recommend({
  config,
  extractStudy,
  client,
  databasePath,
  reference = null,
  onCheckpoint = async () => {},
}) {
  if (reference !== null && !Object.hasOwn(decisionMap, reference))
    throw new Error('Invalid human reference decision.');
  const runId = randomUUID();
  const ref = `recommendation:${runId}`;
  let study = null,
    parsed = null,
    request = null,
    response = null;
  let record = {
    runId,
    deviceId: screeningDevice().id,
    dataset: config.dataset,
    profile: config.profile,
    reviewUrl: config.reviewUrl,
    reviewId: config.reviewId,
    studyId: config.studyId,
    model: config.openai.model,
    criteriaVersion: config.criteriaVersion,
    configHash: config.configHash,
    referenceDecision: reference,
    referenceComparison: 'not_assessed',
    status: 'extracting',
    decision: null,
    expectedButton: null,
    createdAt: new Date().toISOString(),
  };
  const save = async (patch) => {
    record = { ...record, ...patch, updatedAt: new Date().toISOString() };
    withRecords(databasePath, (store) =>
      store.transaction(() => {
        store.saveRecommendation({ record, study, parsed });
        if (request)
          store.savePayload(runId, {
            request,
            response,
            requestVersion: request.text?.format?.name === RESPONSE_FORMAT_NAME ? '1.1.3' : '1.1.2',
          });
      }),
    );
    await onCheckpoint({ record, ref });
  };
  await save({});
  try {
    study = await extractStudy();
    const verifiedAbstract =
      typeof study.abstract === 'string' &&
      (study.abstract.trim() || study.abstractStatus === 'not_available');
    if (!study.ready || study.studyId !== config.studyId || !study.title || !verifiedAbstract)
      throw new Error('Study identity or required text is not verified.');
    request = buildRequest(config, study);
    await save({
      status: 'request_started',
      title: study.title,
      studyHash: studyHash(study),
      requestHash: hash(request),
    });
    try {
      response = responsePayload(
        await client.responses.create(request, { timeout: config.openai.timeoutMs, maxRetries: 0 }),
      );
    } catch (error) {
      await save({ apiError: safeApiDetails(error) });
      // API transport errors can contain credentials; retain only sanitized details.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeApiError(error));
    }
    await save({
      status: 'response_saved',
      responseId: response.id,
      actualModel: response.model,
      usage: response.usage,
    });
    try {
      parsed = parseRecommendation(response, study, config, request);
      withRecords(databasePath, (store) => store.parseAttempt(runId, PARSER_VERSION, 'accepted'));
    } catch (error) {
      withRecords(databasePath, (store) =>
        store.parseAttempt(runId, PARSER_VERSION, 'rejected', error.message),
      );
      throw error;
    }
    await save({
      status: 'recommended',
      parserVersion: PARSER_VERSION,
      decision: parsed.Decision,
      expectedButton: decisionMap[parsed.Decision],
      rationale: parsed.Rationale,
      referenceComparison: reference
        ? reference === parsed.Decision
          ? 'match'
          : 'mismatch'
        : 'not_assessed',
    });
  } catch (error) {
    await save({ status: 'error', error: error.message, decision: null, expectedButton: null });
  }
  return { ref, record, parsed };
}

// Reprocess only already received output. This function has no API client and
// cannot replace decisions associated with retained submission claims.
export async function reparseRecommendation(databasePath, config, runId) {
  if (!uuidPattern.test(runId)) throw new Error('Invalid recommendation ID.');
  const { saved, payload } = withRecords(databasePath, (store) => ({
    saved: store.recommendation(runId),
    payload: store.payload(runId),
  }));
  const { record, study } = saved;
  if (
    record.configHash !== config.configHash ||
    record.reviewUrl !== config.reviewUrl ||
    record.studyId !== config.studyId ||
    record.studyHash !== studyHash(study || {})
  )
    throw new Error('Saved response does not match this study and its original settings.');
  if (record.status === 'recommended') return loadRecommendation(databasePath, config, runId);
  if (!payload?.response)
    throw new Error(
      'No response body was saved for this attempt. An explicit API retry is required; older v1.0 responses cannot be reconstructed.',
    );
  if (
    payload.responseHash !== hash(payload.response) ||
    record.requestHash !== hash(payload.request)
  )
    throw new Error('Saved response or request integrity check failed.');
  if (withRecords(databasePath, (store) => store.existingVote(config, record.studyId)))
    throw new Error('A retained vote claim exists. Resolve it before reprocessing this response.');
  let parsed;
  try {
    parsed = parseRecommendation(payload.response, study, config, payload.request);
  } catch (error) {
    withRecords(databasePath, (store) =>
      store.transaction(() => {
        store.parseAttempt(runId, PARSER_VERSION, 'rejected', error.message);
        store.projectEvent(randomUUID(), record.reviewUrl, 'response_reparse_failed', {
          studyId: record.studyId,
          runId,
          error: error.message,
        });
      }),
    );
    throw error;
  }
  const updated = {
    ...record,
    deviceId: screeningDevice().id,
    status: 'recommended',
    parserVersion: PARSER_VERSION,
    decision: parsed.Decision,
    expectedButton: decisionMap[parsed.Decision],
    rationale: parsed.Rationale,
    error: null,
    reprocessedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    referenceComparison: record.referenceDecision
      ? record.referenceDecision === parsed.Decision
        ? 'match'
        : 'mismatch'
      : 'not_assessed',
  };
  withRecords(databasePath, (store) =>
    store.transaction(() => {
      // Recheck under the transaction before updating the canonical record.
      if (store.existingVote(config, record.studyId))
        throw new Error('A retained vote claim exists.');
      store.saveRecommendation({ record: updated, study, parsed });
      store.parseAttempt(runId, PARSER_VERSION, 'accepted');
      store.projectEvent(randomUUID(), record.reviewUrl, 'response_reparsed', {
        studyId: record.studyId,
        runId,
        message: 'Saved response reprocessed locally; no AI request.',
      });
    }),
  );
  return loadRecommendation(databasePath, config, runId);
}

export async function loadRecommendation(databasePath, config, runId) {
  if (!uuidPattern.test(runId)) throw new Error('Invalid recommendation ID.');
  const saved = withRecords(databasePath, (store) => store.recommendation(runId));
  const { record, study, parsed } = saved;
  if (!study || !parsed) throw new Error('Recommendation has no validated decision.');
  if (config.promptSections) {
    const payload = withRecords(databasePath, (store) => store.payload(runId));
    if (
      !payload?.response ||
      payload.responseHash !== hash(payload.response) ||
      record.requestHash !== hash(payload.request)
    )
      throw new Error('Saved response or request integrity check failed.');
    const checked = parseRecommendation(payload.response, study, config, payload.request);
    if (hash(checked) !== hash(parsed))
      throw new Error('Saved parsed response differs from the original GPT reply.');
  } else
    parseRecommendation(
      {
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(parsed) }] }],
      },
      study,
      config,
    );
  if (
    record.status !== 'recommended' ||
    record.runId !== runId ||
    record.dataset !== config.dataset ||
    record.reviewId !== config.reviewId ||
    record.reviewUrl !== config.reviewUrl ||
    record.configHash !== config.configHash ||
    record.studyHash !== studyHash(study) ||
    record.decision !== parsed.Decision ||
    record.rationale !== parsed.Rationale ||
    record.expectedButton !== decisionMap[parsed.Decision] ||
    record.studyId !== study.studyId
  ) {
    throw new Error(
      'Recommendation is invalid, modified, or belongs to different review criteria. Generate a new recommendation.',
    );
  }
  return saved;
}
