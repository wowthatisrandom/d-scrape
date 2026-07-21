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

// Discontinued ACE products, matched against the NORMALIZED name at the
// upsert boundary. Old stock may still sit on dispensary menus, but we no
// longer track or display it. (Not raw-name patterns — hash cone raw names
// vary too much: "+ crosses", "Infused Preroll" with no "cone" keyword.)
const DISCONTINUED_NORMALIZED_PATTERNS = [
  // (empty — no products currently discontinued; add patterns like
  // /^hash\s*cones?\b/i here when a product line is truly retired)
];

/**
 * Returns true if a normalized product name refers to a discontinued product.
 */
function isDiscontinuedProduct(normalizedName) {
  return matchesAny(DISCONTINUED_NORMALIZED_PATTERNS, normalizedName);
}

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
  isDiscontinuedProduct,
  EXCLUDED_PATTERNS,
  INTERNAL_PATTERNS,
  DISCONTINUED_NORMALIZED_PATTERNS,
};
