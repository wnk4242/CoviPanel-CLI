export const standardFields = [
  'Decision',
  'Population',
  'Intervention',
  'Condition',
  'StudyDesign',
  'Rationale',
];
/** @param {Record<string, string>} parsed */
export function standardLines(parsed) {
  return standardFields.map(
    (field) =>
      `${field}: ${String(parsed[field] || '')
        .replace(/\s+/g, ' ')
        .trim()}`,
  );
}
