import { decisionMap } from './decisions.js';

// Compatibility reader for saved replies requested before the internal decision
// wrapper. New API replies use response-contract.js and never use these patterns.

// Read an explicit screening decision stated as a sentence. Only affirmative
// decision clauses count; eligibility keywords inside the explanation do not.
const sentencePatterns = [
  /^(?:I|we)\s+(?:(?:would|recommend)\s+)?(includ(?:e|ed|ing)|exclud(?:e|ed|ing))\s+(?:this|the)\s+(?:study|record|article|paper)\b/i,
  /^(?:this|the)\s+(?:study|record|article|paper)\s+(?:is|was|should\s+be)\s+(included|excluded)\b/i,
  /^(include|exclude)\s+(?:this|the)\s+(?:study|record|article|paper)\b/i,
  /^(?:my|our|the)\s+(?:decision|recommendation)\s+is\s+(include|exclude|maybe)\b/i,
  /^(include(?:d)?|exclude(?:d)?|maybe)\b/i,
];

function sentenceDecision(text) {
  const source = text.trimStart();
  for (const pattern of sentencePatterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const rest = source.slice(match[0].length);
    // A complete decision, followed by punctuation or an explanation. This
    // excludes conditional instructions and statements about included samples.
    if (
      !/^\s*(?:$|[.,:;\u2013\u2014-]|(?:because|as|since|given|due\s+to|although|despite|even\s+though)\b)/i.test(
        rest,
      ) ||
      /^\s*[,;:]?\s*(?:only\s+if|if|unless|provided|assuming)\b/i.test(rest)
    )
      continue;
    const word = match[1].toLowerCase().replace(/(?:ed|ing)$/, 'e');
    return {
      Decision: Object.keys(decisionMap).find((choice) => choice.toLowerCase() === word),
      rest,
    };
  }
  return null;
}

function parseSentenceResponse(text) {
  const first = sentenceDecision(text);
  if (!first) return null;
  const clauses = first.rest.split(/\r?\n|(?<=[.!?;])\s+|\s+(?:and|but|however|instead)[:,]?\s+/i);
  if (/\bDecision\s*:/i.test(first.rest) || clauses.some((clause) => sentenceDecision(clause)))
    throw new Error('Multiple or mixed decision statements; no decision accepted.');
  return { Decision: first.Decision, Rationale: text.trim(), ResponseText: text };
}

// One explicit decision is required. Rationale is a storage/export slot for
// an optional explanation, never an instruction to add a field to GPT's reply.
// Keep the entire response untouched for presentation and auditing.
export function parsePromptResponse(text) {
  let Decision, Rationale;
  // A compact reply states its decision explicitly, e.g. "Excluded: reason".
  // This is a spelling/format mapping, never an inference from the rationale.
  const compact = text.trim().match(/^(include(?:d)?|exclude(?:d)?|maybe)\s*:\s*([\s\S]*)$/i);
  if (compact) {
    if (/\b(?:Decision|include(?:d)?|exclude(?:d)?|maybe)\s*:/i.test(compact[2]))
      throw new Error('Multiple or mixed decision fields; no decision accepted.');
    Decision = {
      include: 'Include',
      included: 'Include',
      exclude: 'Exclude',
      excluded: 'Exclude',
      maybe: 'Maybe',
    }[compact[1].toLowerCase()];
    Rationale = compact[2].trim();
  } else if (text.trimStart().startsWith('{')) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('GPT returned invalid JSON.');
    }
    if (!value || Array.isArray(value)) throw new Error('Expected one response object.');
    // Repeated decision keys can hide conflicting votes. Repeated explanation
    // keys do not affect the vote; their full text remains in ResponseText.
    let depth = 0;
    const keys = new Set();
    for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
      if (token[0][0] === '"') {
        if (depth === 1 && /^\s*:/.test(text.slice(token.index + token[0].length))) {
          const key = JSON.parse(token[0]).toLowerCase();
          if (key === 'decision' && keys.has(key))
            throw new Error('Duplicate Decision response field.');
          keys.add(key);
        }
      } else if (['{', '['].includes(token[0])) depth++;
      else depth--;
    }
    Decision = value[Object.keys(value).find((key) => key.toLowerCase() === 'decision')];
    Rationale = value.Rationale;
    if (typeof Rationale !== 'string' || !Rationale.trim()) {
      const rest = Object.fromEntries(
        Object.entries(value).filter(([key]) => key.toLowerCase() !== 'decision'),
      );
      Rationale = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
    }
  } else {
    const lines = text.split(/\r?\n/);
    if (lines.some((line) => /^\s*(?:include(?:d)?|exclude(?:d)?|maybe)\s*:/i.test(line)))
      throw new Error('Multiple or mixed decision fields; no decision accepted.');
    const decisionLines = lines
      .map((line, index) => (/^\s*Decision\s*:/i.test(line) ? index : -1))
      .filter((index) => index >= 0);
    const rationaleLines = lines
      .map((line, index) => (/^\s*Rationale\s*:/i.test(line) ? index : -1))
      .filter((index) => index >= 0);
    if (!decisionLines.length) {
      const sentence = parseSentenceResponse(text);
      if (sentence) return sentence;
    }
    if (decisionLines.length !== 1)
      throw new Error(
        'Cannot read one clear GPT decision. Use Decision: Include, Decision: Exclude or Decision: Maybe, or an explicit sentence such as "I exclude this study because...". The response is saved; no vote was submitted.',
      );
    if (sentenceDecision(text))
      throw new Error('Multiple or mixed decision statements; no decision accepted.');
    const decisionIndex = decisionLines[0];
    Decision = lines[decisionIndex].replace(/^\s*Decision\s*:\s*/i, '').trim();
    // Preserve extraction for previously accepted replies so their cached
    // rationale, decision and response integrity checks remain unchanged.
    if (rationaleLines.length === 1) {
      const start = rationaleLines[0];
      const parts = [lines[start].replace(/^\s*Rationale\s*:\s*/i, '')];
      for (const line of lines.slice(start + 1)) {
        if (/^\s*[^:\r\n]{1,80}:/.test(line)) break;
        parts.push(line);
      }
      Rationale = parts.join('\n').trim();
    }
    // No mandatory rationale label: retain the other text as the spreadsheet
    // explanation. A decision-only reply leaves that cell blank.
    if (!Rationale)
      Rationale = lines
        .filter((_, index) => index !== decisionIndex)
        .join('\n')
        .trim();
  }
  Decision =
    typeof Decision === 'string'
      ? Object.keys(decisionMap).find(
          (choice) => choice.toLowerCase() === Decision.trim().toLowerCase(),
        )
      : undefined;
  if (!Decision)
    throw new Error('Decision must be Include, Exclude or Maybe; no fallback decision is allowed.');
  return { Decision, Rationale, ResponseText: text };
}
