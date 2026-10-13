import { parsePromptResponse } from './prompt-response.js';
import { RESPONSE_FORMAT_NAME, parseDecisionResponse } from './response-contract.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    Decision: { type: 'string', enum: ['Include', 'Exclude', 'Maybe'] },
    Population: { type: 'string' },
    Intervention: { type: 'string' },
    Condition: { type: 'string' },
    StudyDesign: { type: 'string' },
    Rationale: { type: 'string' },
    Uncertainty: { type: 'string' },
    Evidence: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
  },
  required: [
    'Decision',
    'Population',
    'Intervention',
    'Condition',
    'StudyDesign',
    'Rationale',
    'Uncertainty',
    'Evidence',
  ],
};
export function responseSchema(config = {}) {
  if (config.responseFormat && config.responseFormat !== 'standard')
    throw new Error('Unknown response format.');
  return schema;
}
export function evidenceOptions(study) {
  // Every choice is copied from the source, never paraphrased by a model.
  const candidates = [study.title, ...study.abstract.split(/(?<=[.!?])\s+(?=[A-Z])/u)];
  const excerpts = candidates
    .map((text) => {
      const trimmed = text.trim();
      if (trimmed.length <= 600) return trimmed;
      const end = trimmed.lastIndexOf(' ', 600);
      return trimmed.slice(0, end > 0 ? end : 600);
    })
    .filter(Boolean);
  return [...new Set(excerpts)].slice(0, 100);
}
function sourceQuotation(quote, study) {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  for (const text of [study.title, study.abstract]) {
    if (text.includes(quote)) return quote;
    // Allow only lowercasing of a source sentence's first letter. Preserve words,
    // punctuation, numbers, units and every other character exactly.
    if (!/^[a-z]/.test(quote)) continue;
    const canonical = quote[0].toUpperCase() + quote.slice(1);
    let at = text.indexOf(canonical);
    while (at >= 0) {
      if (at === 0 || /[.!?]\s+$/.test(text.slice(0, at)))
        return text.slice(at, at + canonical.length);
      at = text.indexOf(canonical, at + 1);
    }
  }
  return null;
}
function resolveEvidence(value, study) {
  // New requests use short enum IDs. Legacy saved responses use literal quotes.
  if (typeof value === 'string' && /^E[1-9]\d*$/.test(value))
    return evidenceOptions(study)[Number(value.slice(1)) - 1] ?? null;
  return sourceQuotation(value, study);
}
export function parseRecommendation(response, study, config = {}, request) {
  if (response.status !== 'completed' || response.error || response.incomplete_details)
    throw new Error('OpenAI response is incomplete or failed; no decision accepted.');
  const content = (response.output || []).flatMap((item) => item.content || []);
  if (content.some((item) => item.type === 'refusal'))
    throw new Error('OpenAI refused this request; no decision accepted.');
  const texts = content.filter((item) => item.type === 'output_text');
  if (texts.length !== 1) throw new Error('Expected exactly one structured response.');
  if (config.promptSections) {
    // The original request selects the reader. New replies must never fall back
    // to guessing a vote from presentation text when the wrapper is malformed.
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('The original API request is required to read this response.');
    const format = request.text?.format;
    if (
      format?.name === RESPONSE_FORMAT_NAME &&
      format.type === 'json_schema' &&
      format.strict === true
    )
      return parseDecisionResponse(texts[0].text);
    if (format) throw new Error('Unknown saved API response format.');
    return parsePromptResponse(texts[0].text);
  }
  const expectedSchema = responseSchema(config);
  let result;
  try {
    result = JSON.parse(texts[0].text);
  } catch {
    throw new Error('AI output is not valid JSON; no decision accepted.');
  }
  if (
    !result ||
    Array.isArray(result) ||
    Object.keys(result).length !== expectedSchema.required.length ||
    !expectedSchema.required.every((key) => Object.hasOwn(result, key))
  )
    throw new Error('AI output does not match the required response fields.');
  if (!schema.properties.Decision.enum.includes(result.Decision))
    throw new Error('Invalid Decision field; no fallback decision is allowed.');
  for (const key of expectedSchema.required.filter((key) => key !== 'Evidence')) {
    if (typeof result[key] !== 'string' || !result[key].trim())
      throw new Error(`Missing or empty ${key} field.`);
  }
  if (
    !Array.isArray(result.Evidence) ||
    result.Evidence.length < 1 ||
    result.Evidence.length > 2 ||
    !result.Evidence.every((quote) => resolveEvidence(quote, study) !== null)
  ) {
    throw new Error('Evidence quotations do not match the extracted title/abstract.');
  }
  return { ...result, Evidence: result.Evidence.map((quote) => resolveEvidence(quote, study)) };
}
