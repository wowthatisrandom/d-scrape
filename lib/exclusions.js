/**
 * Shared product exclusions applied across every scrape path AND at the
 * upsert boundary. Add new patterns here so they apply everywhere at once.
 */

// Collab products / non-ACE-only SKUs we don't want to track.
const EXCLUDED_PATTERNS = [
  /\bstellar\b/i,
];

// Internal / non-retail entries that occasionally surface on dispensary menus
// (employee samples, donations, demos, $0 placeholders).
const INTERNAL_PATTERNS = [
  /\bemployee\s+sample\b/i,
  /\bstaff\s+sample\b/i,
  /\bdo\s+not\s+sell\b/i,
  /\bdemo\b/i,
  /\bdonation\b/i,
  /\binternal\s+use\b/i,
];

function matchesAny(patterns, value) {
  if (!value) return false;
  return patterns.some(p => p.test(value));
}

/**
 * Returns true if a product should be excluded from scrape results / DB writes.
 * Checks name and brand against collab and internal-use patterns.
 */
function isExcludedProduct(name, brand) {
  const n = name || '';
  const b = brand || '';
  return (
    matchesAny(EXCLUDED_PATTERNS, n) ||
    matchesAny(EXCLUDED_PATTERNS, b) ||
    matchesAny(INTERNAL_PATTERNS, n) ||
    matchesAny(INTERNAL_PATTERNS, b)
  );
}

module.exports = {
  isExcludedProduct,
  EXCLUDED_PATTERNS,
  INTERNAL_PATTERNS,
};
