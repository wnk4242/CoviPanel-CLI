import { decisionMap } from './decisions.js';

export const RESPONSE_FORMAT_NAME = 'covipanel_screening_response';

// The API wrapper carries the vote separately from the user's presentation.
// Its descriptions define transport only; eligibility stays in the user's prompt.
export function decisionResponseFormat() {
  return {
    type: 'json_schema',
    name: RESPONSE_FORMAT_NAME,
    strict: true,
    description:
      "Internal CoviPanel response wrapper. Apply the user's Response format instructions to the response string, not to this wrapper.",
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: {
          type: 'string',
          enum: Object.keys(decisionMap),
          description:
            "The screening decision for the supplied study, following the user's inclusion and exclusion criteria.",
        },
        response: {
          type: 'string',
          description:
            "The complete user-facing reply, consistent with decision and following the user's Response format instructions exactly. Preserve the requested fields, language and formatting within this string. If no response format is specified, give a concise explanation of the decision.",
        },
      },
      required: ['decision', 'response'],
    },
  };
}

/** @param {string} text */
export function parseDecisionResponse(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'GPT returned an invalid internal response object. The reply is saved; no vote was submitted.',
    );
  }
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'decision') ||
    !Object.hasOwn(value, 'response') ||
    typeof value.decision !== 'string' ||
    !Object.hasOwn(decisionMap, value.decision) ||
    typeof value.response !== 'string'
  )
    throw new Error(
      'GPT must return one internal decision and a response string. The reply is saved; no vote was submitted.',
    );

  // Reject duplicate outer keys, including escaped spellings. Words or JSON
  // inside the response string are presentation and are never parsed for voting.
  let depth = 0;
  const keys = new Set();
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    if (token[0][0] === '"') {
      if (depth === 1 && /^\s*:/.test(text.slice(token.index + token[0].length))) {
        const key = JSON.parse(token[0]);
        if (keys.has(key))
          throw new Error('Duplicate internal response field; no vote was submitted.');
        keys.add(key);
      }
    } else if (['{', '['].includes(token[0])) depth++;
    else depth--;
  }
  return { Decision: value.decision, Rationale: value.response, ResponseText: value.response };
}
