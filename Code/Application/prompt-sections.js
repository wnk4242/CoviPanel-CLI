export const promptLabels = {
  inclusion: 'Inclusion criteria',
  exclusion: 'Exclusion criteria',
  responseFormat: 'Response format',
};
export const promptTextLimit = 100000;

/** @typedef {{[key:string]:string, inclusion:string, exclusion:string, responseFormat:string}} PromptSections */

/** @param {PromptSections} sections */
export function validatePromptSections(sections) {
  if (
    !sections ||
    typeof sections !== 'object' ||
    Array.isArray(sections) ||
    Object.keys(sections).length !== 3 ||
    !Object.keys(promptLabels).every((key) => typeof sections[key] === 'string')
  )
    throw new Error(
      'Provide exactly three prompt sections: inclusion, exclusion and responseFormat.',
    );
  for (const [key, label] of Object.entries(promptLabels)) {
    if (sections[key].length > promptTextLimit)
      throw new Error(
        `${label} must stay within ${promptTextLimit.toLocaleString('en-US')} characters.`,
      );
    if (key === 'inclusion' && !sections[key].trim())
      throw new Error(`Enter ${label.toLowerCase()}.`);
  }
  return sections;
}

/** @param {PromptSections} sections */
export function buildPrompt(sections) {
  validatePromptSections(sections);
  return Object.entries(promptLabels)
    .map(([key, label]) => `${label}:\n${sections[key]}`)
    .join('\n\n');
}

// Convert editable legacy settings without changing snapshots held by saved batches.
/** @param {Record<string, any>} settings */
export function editableSettings(settings) {
  const {
    criteria,
    promptFile: _promptFile,
    responseInstructions,
    responseFormat: _responseFormat,
    ...rest
  } = settings;
  if (settings.promptSections) return { ...rest, promptSections: { ...settings.promptSections } };
  const fields = [
    'Decision',
    'Population',
    'Intervention',
    'Condition',
    'StudyDesign',
    'Rationale',
  ];
  return {
    ...rest,
    promptSections: {
      inclusion: (criteria?.inclusion || []).join('\n'),
      exclusion: (criteria?.exclusion || []).join('\n'),
      responseFormat: [
        `Return these fields, each on a separate line: ${fields.join(', ')}.`,
        'Decision must be Include, Exclude or Maybe. Rationale explains the decision.',
        responseInstructions || '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  };
}
