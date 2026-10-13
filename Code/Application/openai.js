import path from 'node:path';
import { apiLibraries } from './dependencies.js';
import { settingsDir } from './config.js';
import { responseSchema, evidenceOptions } from './ai-parser.js';
import { buildPrompt } from './prompt-sections.js';
import { decisionResponseFormat } from './response-contract.js';
export function createOpenAIClient({
  envPath = path.join(settingsDir, '.env'),
  env = process.env,
} = {}) {
  const { OpenAI, dotenv } = apiLibraries();
  // The project's explicit local credential wins over an unrelated inherited key.
  dotenv.config({ path: envPath, processEnv: env, override: true, quiet: true });
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey?.trim() || apiKey === 'replace_with_your_openai_api_key')
    throw new Error('Set OPENAI_API_KEY in Setups/Settings/.env.');
  return new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0 });
}
export function buildRequest(config, study) {
  const titleOnly = study.abstract === '' && study.abstractStatus === 'not_available';
  const citation = {
    studyId: study.studyId,
    title: study.title,
    abstract: study.abstract,
    ...(titleOnly ? { abstractStatus: 'not_available' } : {}),
    author: study.author,
    year: study.year,
  };
  if (config.promptSections) {
    return {
      model: config.openai.model,
      store: false,
      max_output_tokens: config.openai.maxOutputTokens,
      instructions: buildPrompt(config.promptSections),
      text: { format: decisionResponseFormat() },
      input: JSON.stringify({ study: citation }),
    };
  }
  // Compatibility for batches created before the three-section prompt editor.
  const choices = evidenceOptions(study);
  const schema = responseSchema(config);
  const evidenceChoices = choices.map((text, index) => ({ id: `E${index + 1}`, text }));
  const requestSchema = {
    ...schema,
    properties: {
      ...schema.properties,
      Evidence: {
        ...schema.properties.Evidence,
        items: { type: 'string', enum: evidenceChoices.map((choice) => choice.id) },
      },
    },
  };
  return {
    model: config.openai.model,
    store: false,
    max_output_tokens: config.openai.maxOutputTokens,
    instructions:
      config.prompt +
      (config.responseInstructions
        ? '\n\nResponse presentation preferences (keep the required JSON fields and decision values):\n' +
          config.responseInstructions
        : '') +
      (titleOnly
        ? '\n\nThis is a title-only citation: Covidence has no abstract available. State this limitation in Rationale and Uncertainty. Apply the supplied criteria using the title only; do not infer study methods, treatment or outcomes from the topic alone. If the title does not establish eligibility or a clear exclusion reason, choose Maybe. Missing an abstract alone is not an exclusion criterion.'
        : '') +
      '\n\nEvidence transport format: return one or two evidenceChoices IDs (such as E1) in Evidence. This overrides the instruction to copy quotation text into that field. The program resolves each ID to its exact source excerpt; all other screening instructions still apply.',
    input: JSON.stringify({
      dataset: config.dataset,
      criteriaVersion: config.criteriaVersion,
      criteria: config.criteria,
      study: citation,
      evidenceInstructions:
        'Select one or two relevant evidenceChoices IDs. Return only the IDs in Evidence. Base your decision on the full title and abstract.',
      evidenceChoices,
    }),
    text: {
      format: {
        type: 'json_schema',
        name: 'screening_recommendation',
        strict: true,
        schema: requestSchema,
      },
    },
  };
}
export function safeApiError(error) {
  if (error.status === 400 && error.code === 'invalid_json_schema')
    return 'OpenAI rejected the response-format schema (HTTP 400). This is a program configuration error, not an API credit error.';
  const status = Number.isInteger(error.status) ? error.status : null;
  const category = [
    'APIConnectionTimeoutError',
    'APIConnectionError',
    'AuthenticationError',
    'RateLimitError',
    'BadRequestError',
    'PermissionDeniedError',
    'NotFoundError',
  ].includes(error.name)
    ? error.name
    : 'APIError';
  return `OpenAI ${category}${status ? ` (HTTP ${status})` : ''}. No automatic retry; check API credentials, model access, quota, and connectivity.`;
}
export function safeApiDetails(error) {
  const safe = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,150}$/.test(value) ? value : null;
  return {
    status: Number.isInteger(error.status) ? error.status : null,
    code: safe(error.code),
    parameter: safe(error.param),
    summary: safeApiError(error),
  };
}
