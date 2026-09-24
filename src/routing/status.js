const config = require('../config');

const MATT_KEYWORDS = ['matt', 'matte', 'satin', 'suede finish', 'soft touch'];

/**
 * Gloss vs matt determines whether "polishing" is part of the sequence at
 * all (matt/satin finishes skip it). Mirrors the WIP-PRODUCTION-CONTROL
 * skill's own detection rule exactly, including its default: no finish
 * keyword found -> assume gloss.
 */
function detectFinish(text) {
  return MATT_KEYWORDS.some((k) => text.includes(k)) ? 'matt' : 'gloss';
}

/**
 * Detect the routing key (material, plus finish where the material's
 * sequence depends on it) from subtask name/description keywords.
 *
 * This mirrors the production sequences in the ZCreations Full Intelligence
 * doc's Production Control page (WIP-PRODUCTION-CONTROL skill, ClickUp doc
 * 2e92p-7572 / page 2e92p-5532, last edited 23 Sep 2026) rather than a
 * flatter material-only guess - that page is the authoritative, most
 * recently updated source for these sequences. Order matters: more specific
 * keywords are checked before falling back to the mdf default.
 */
function detectItemType(name = '', description = '') {
  const text = `${name} ${description}`.toLowerCase();
  const finish = detectFinish(text);

  const isUpholstery = text.includes('upholster');
  if (isUpholstery && text.includes('bed')) return 'bed_base_upholstered';
  if (isUpholstery) return 'upholstery';

  if (text.includes('respray') || text.includes('fill/repair') || text.includes('fill / repair')) {
    return `respray_${finish}`;
  }
  if (text.includes('melamine') || text.includes('board')) return 'melamine';
  if (text.includes('stain') || text.includes('veneer') || text.includes('imbua') || text.includes('walnut')) {
    return `veneer_${finish}`;
  }
  return `mdf_${finish}`;
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
 * Ambiguity hook (Section 6.5): "wood work" is a valid current status
 * across several sequences that diverge immediately after it (mdf ->
 * primer, veneer -> staining, melamine -> assembly wood work, bed base ->
 * upholstery), so keyword detection normally resolves it. This helper
 * exists for the case where keyword detection can't tell (e.g. name gives
 * no hint) - the caller can then prompt the carpenter to choose using
 * these candidate next-statuses instead of silently guessing.
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
