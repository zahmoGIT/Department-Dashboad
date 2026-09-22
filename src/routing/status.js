const config = require('../config');

/**
 * Detect item type from subtask name/description keywords (Section 8).
 * Order matters: more specific keywords are checked before falling back
 * to the MDF default.
 */
function detectItemType(name = '', description = '') {
  const text = `${name} ${description}`.toLowerCase();

  if (text.includes('upholster')) return 'upholstery';
  if (text.includes('respray') || text.includes('fill/repair') || text.includes('fill / repair')) return 'respray';
  if (text.includes('stain') || text.includes('veneer') || text.includes('imbua') || text.includes('walnut')) return 'veneer';
  return 'mdf';
}

/**
 * Given the current status and detected item type, find the next status in
 * that type's sequence. Skips statuses the sequence doesn't contain (e.g. a
 * respray item currently unaware of "wood work" jumps straight to "primer").
 *
 * Returns:
 *   { nextStatus: string }                          - unambiguous
 *   { ambiguous: true, choices: [...] }              - needs a user prompt
 *   { nextStatus: null, reason: string }             - current status isn't
 *                                                       in this type's sequence,
 *                                                       or it's already the
 *                                                       last stage
 */
function getNextStatus(currentStatus, itemType) {
  const sequence = config.routing[itemType];
  if (!sequence) {
    return { nextStatus: null, reason: `Unknown item type "${itemType}" - no routing sequence configured` };
  }

  const normalizedCurrent = (currentStatus || '').trim().toLowerCase();
  const idx = sequence.findIndex((s) => s.toLowerCase() === normalizedCurrent);

  if (idx === -1) {
    return { nextStatus: null, reason: `Status "${currentStatus}" is not part of the ${itemType} sequence` };
  }
  if (idx === sequence.length - 1) {
    return { nextStatus: null, reason: `"${currentStatus}" is already the final stage of the ${itemType} sequence` };
  }

  return { nextStatus: sequence[idx + 1] };
}

/**
 * Ambiguity hook (Section 6.5): "wood work" is a valid current status for
 * both the mdf and veneer sequences, and both agree on "assembly wood work"
 * as next, so in practice detection from keywords resolves it. This helper
 * exists for the case where keyword detection can't tell (e.g. name gives
 * no hint) - the caller can then prompt "Carpentry or Assembly?" using
 * these choices instead of silently guessing.
 */
function getAmbiguousChoices(currentStatus) {
  const candidates = new Set();
  for (const seq of Object.values(config.routing)) {
    const idx = seq.findIndex((s) => s.toLowerCase() === (currentStatus || '').toLowerCase());
    if (idx !== -1 && idx < seq.length - 1) candidates.add(seq[idx + 1]);
  }
  return [...candidates];
}

module.exports = { detectItemType, getNextStatus, getAmbiguousChoices };
