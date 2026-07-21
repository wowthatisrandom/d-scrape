/**
 * ACE Solventless Product Name Normalizer
 * Converts scraped product names to clean, consistent format.
 *
 * This module is pure and synchronous. Strain and flavor dictionaries live in
 * the Supabase `brand_vocabulary` table — callers load them once via
 * `loadVocabulary()` from `./vocabulary` and pass the result in as `vocab`.
 *
 *   const vocab = await loadVocabulary(supabase);
 *   const normalized = normalizeProductName(rawName, size, vocab);
 */

/**
 * Product type patterns and their normalized names
 */
const PRODUCT_TYPES = [
  {
    // Rosin Jam (2g jars, flavor-based)
    patterns: [/rosin\s*jam/i],
    normalized: 'Rosin Jam',
    extractFlavor: true,
    defaultFlavor: 'Strawberry Pie'
  },
  {
    // Rosin Thumbprint (2g jars, flavor-based)
    patterns: [/rosin\s*thumb\s*print/i, /thumb\s*print/i],
    normalized: 'Rosin Thumbprint',
    extractFlavor: true,
    defaultFlavor: 'Apple Creme'
  },
  {
    // Bingo Hash Hole (2g infused prerolls) — raw names often lead with
    // "Cold Cured Live Rosin – Strain – Bingo Hash Hole", so this entry
    // must sit above the Cold Cured Live Rosin entry.
    patterns: [/bingo\s*hash\s*hole/i, /hash\s*hole/i],
    normalized: 'Bingo Hash Hole',
    extractStrain: true
  },
  {
    // FECO Syringe (1g)
    patterns: [/\bfeco\b/i, /full\s*extract\s*cannabis\s*oil/i],
    normalized: 'FECO Syringe',
    extractStrain: false
  },
  {
    // Cold Cured Live Rosin (2g jars)
    patterns: [/live\s*rosin\s*cold\s*cure/i, /cold\s*cure.*live\s*rosin/i, /cold\s*cured\s*live\s*rosin/i, /cold\s*cured?\s*rosin/i, /live\s*rosin/i, /badder/i],
    exclude: [/sesh\s*stick/i, /disposable/i, /vape/i, /syrup/i, /preroll/i, /cone/i, /rosin\s*jam/i, /thumb\s*print/i, /hash\s*hole/i, /\bfeco\b/i],
    normalized: 'Cold Cured Live Rosin',
    extractStrain: true
  },
  {
    // Sesh Stick Vapes (disposables)
    patterns: [/sesh\s*stick/i, /hash\s*rosin\s*sesh/i, /rosin\s*disposable/i, /hash\s*rosin.*disposable/i, /aio\s*disposable/i],
    normalized: 'Sesh Stick Vape',
    extractStrain: true
  },
  {
    // Jackpot Infused Syrups
    patterns: [/jackpot/i, /liquid\s*gold/i, /infused\s*syrup/i, /solventless\s*syrup/i, /rosin\s*syrup/i],
    normalized: 'Jackpot Infused Syrup',
    extractFlavor: true,
    defaultFlavor: 'Lychee'
  },
  {
    // Hash Cones (prerolls)
    patterns: [/hash\s*wrapped/i, /hash\s*cone/i, /preroll/i],
    normalized: 'Hash Cones',
    extractStrain: true,
    strainFormat: 'cross' // Format as "Strain x Strain" if detected
  },
  {
    // Sudden Death Hot Sauce
    patterns: [/sudden\s*death/i, /hot\s*sauce/i, /rosin\s*infused\s*hot/i],
    normalized: 'Sudden Death Rosin Infused Hot Sauce',
    extractStrain: false
  }
];

// Words that must keep their canonical casing when title-casing
const CASE_EXCEPTIONS = ['FECO', 'THC', 'CBD', 'AIO', 'OG', 'GMO', 'GSC', 'GG4', 'MVP'];

// Known menu typos -> canonical spelling, fixed before any matching
const TYPO_CORRECTIONS = [
  [/shaboinboing/gi, 'Shaboingboing'],
];

function fixKnownTypos(name) {
  let fixed = String(name);
  for (const [pattern, replacement] of TYPO_CORRECTIONS) {
    fixed = fixed.replace(pattern, replacement);
  }
  return fixed;
}

/**
 * Title-case a name: "MELLOW YELLOW" -> "Mellow Yellow", "badger milk" ->
 * "Badger Milk". Preserves intentional mixed-case words ("McFlurry"),
 * known acronyms (FECO, THC, ...) and the lowercase "x" cross separator.
 */
function toTitleCase(str) {
  if (!str) return str;
  return String(str)
    .split(/\s+/)
    .map(word => {
      if (CASE_EXCEPTIONS.includes(word.toUpperCase())) return word.toUpperCase();
      if (word.toLowerCase() === 'x') return 'x'; // cross-strain separator
      const isAllCaps = word === word.toUpperCase();
      const isAllLower = word === word.toLowerCase();
      if (!isAllCaps && !isAllLower) return word; // keep "McFlurry" etc.
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function getStrains(vocab) {
  return (vocab && Array.isArray(vocab.strains)) ? vocab.strains : [];
}

function getFlavors(vocab) {
  return (vocab && Array.isArray(vocab.flavors)) ? vocab.flavors : [];
}

/**
 * Extract the cannabis effect type from a raw product name.
 * Returns one of: 'hybrid' | 'indica' | 'sativa' | 'indica-hybrid' | 'sativa-hybrid' | null.
 *
 * Compound patterns ("Indica Hybrid", "Sativa Dominant") are matched BEFORE
 * single-word ones so they don't collapse to a less-specific value.
 */
function extractEffectType(name) {
  if (!name) return null;
  const s = String(name);

  // Compound forms first — order matters
  if (/\b(indica[-\s]?hybrid|hybrid[-\s]?indica|indica\s*dominant)\b/i.test(s)) {
    return 'indica-hybrid';
  }
  if (/\b(sativa[-\s]?hybrid|hybrid[-\s]?sativa|sativa\s*dominant)\b/i.test(s)) {
    return 'sativa-hybrid';
  }

  // Single-word matches
  if (/\bhybrid\b/i.test(s)) return 'hybrid';
  if (/\bindica\b/i.test(s)) return 'indica';
  if (/\bsativa\b/i.test(s)) return 'sativa';

  // (H)/(I)/(S) single-letter suffix pattern
  const parenMatch = s.match(/\(([HSI])\)/i);
  if (parenMatch) {
    const c = parenMatch[1].toUpperCase();
    if (c === 'H') return 'hybrid';
    if (c === 'I') return 'indica';
    if (c === 'S') return 'sativa';
  }

  return null;
}

/**
 * Strip effect type tokens (and their separators) from a product name so
 * it displays cleanly alongside a badge. Handles:
 *   - Leading / trailing bare words: "hybrid – Foo", "Foo - Sativa"
 *   - Parenthesized forms anywhere: "Foo (hybrid) Bar", "Foo (Hybrid)"
 *   - Single-letter parens: "Foo (H)", "(I) Bar"
 *   - Compound forms: "Indica Dominant", "Sativa Hybrid"
 * Safe to call even if no effect type is present.
 */
function stripEffectType(name) {
  if (!name) return name;
  return String(name)
    // Parenthesized word forms anywhere in the string
    .replace(/\s*\(\s*(indica[-\s]?hybrid|sativa[-\s]?hybrid|indica\s*dominant|sativa\s*dominant|hybrid|indica|sativa)\s*\)\s*/gi, ' ')
    // Parenthesized single-letter forms anywhere
    .replace(/\s*\(\s*[HSI]\s*\)\s*/gi, ' ')
    // Leading bare word: "hybrid – ", "Indica -", "Indica Hybrid  "
    .replace(/^\s*(indica[-\s]?hybrid|sativa[-\s]?hybrid|indica\s*dominant|sativa\s*dominant|hybrid|indica|sativa)\b[\s\-–—:]*/i, '')
    // Trailing bare word: "... Hybrid", "... - Sativa"
    .replace(/[\s\-–—:]*\b(indica[-\s]?hybrid|sativa[-\s]?hybrid|indica\s*dominant|sativa\s*dominant|hybrid|indica|sativa)\s*$/i, '')
    // Clean up orphan separators and collapsed whitespace
    .replace(/\s*[-–—:]\s*$/g, '')
    .replace(/^\s*[-–—:]\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract strain name from product name.
 */
function extractStrain(name, vocab) {
  // First, check for known strains. Longest-first with word boundaries so
  // "Lemon" doesn't false-match inside "Lemonz" or "Lemon Pledge".
  const strains = [...getStrains(vocab)].sort((a, b) => b.length - a.length);
  for (const strain of strains) {
    const escaped = strain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(name)) {
      return strain;
    }
  }

  // Try to extract from common patterns
  // Pattern: "Strain Name - Product Type" or "ACE Strain Name Product Type"

  // Remove ACE/Ace Solventless prefix and suffix (with trailing : or -)
  let cleaned = name.replace(/^(ACE|Ace)\s*(Solventless)?\s*[:\-–—]?\s*/i, '');
  cleaned = cleaned.replace(/\s*(ACE|Ace)\s*(Solventless)?\s*$/i, '');

  // Remove size info
  cleaned = cleaned.replace(/\|\s*[\d.]+\s*(g|mg|ml)/i, '');
  cleaned = cleaned.replace(/[\d.]+\s*(g|mg|ml)/i, '');

  // Remove strain type indicators. The single letter must be parenthesized
  // or a standalone trailing word — a bare [HSI]$ match would truncate
  // strains like "Yoshi's Droppings" to "Yoshi's Dropping".
  cleaned = cleaned.replace(/\s*\([HSI]\)\s*$/i, ''); // (H), (S), (I)
  cleaned = cleaned.replace(/\s+[HSI]\s*$/i, '');
  cleaned = cleaned.replace(/\s*(Hybrid|Indica|Sativa)(-Hybrid|-Indica|-Sativa)?$/i, '');

  // Remove product type keywords
  cleaned = cleaned.replace(/live\s*rosin\s*cold\s*cure\s*badder/i, '');
  cleaned = cleaned.replace(/cold\s*cure\s*live\s*rosin/gi, '');
  cleaned = cleaned.replace(/cold\s*cured\s*live\s*rosin/gi, '');
  // Menus sometimes append "Cold Cure Rosin" (no "Live") as a category tag
  cleaned = cleaned.replace(/cold\s*cured?\s*rosin/gi, '');
  cleaned = cleaned.replace(/cold\s*cured?\b/gi, '');
  cleaned = cleaned.replace(/hash\s*rosin\s*sesh\s*sticks?/gi, '');
  cleaned = cleaned.replace(/sesh\s*sticks?/gi, '');
  cleaned = cleaned.replace(/\bhash\s*rosin\b/gi, '');
  cleaned = cleaned.replace(/live\s*rosin/gi, '');
  cleaned = cleaned.replace(/solventless/gi, '');
  cleaned = cleaned.replace(/\bbadder\b/gi, '');
  cleaned = cleaned.replace(/bingo\s*hash\s*hole/i, '');
  cleaned = cleaned.replace(/hash\s*hole/i, '');
  cleaned = cleaned.replace(/\bfeco\b/i, '');
  cleaned = cleaned.replace(/syringe/i, '');
  cleaned = cleaned.replace(/hash\s*wrapped\s*preroll/i, '');
  cleaned = cleaned.replace(/rosin\s*disposable\s*vape/i, '');
  cleaned = cleaned.replace(/disposable\s*vape/i, '');
  cleaned = cleaned.replace(/\bdisposable\b/gi, '');

  // Unwrap parenthesized strain names: "(Badger Milk)" -> "Badger Milk"
  cleaned = cleaned.replace(/[()]/g, ' ');

  // Remove THC/CBD info
  cleaned = cleaned.replace(/THC:?\s*[\d.]+%?/i, '');
  cleaned = cleaned.replace(/CBD:?\s*[\d.]+%?/i, '');

  // Clean up separators and whitespace (colons show up as category
  // separators on some menus, e.g. "Badger Milk : Cold Cure Rosin")
  cleaned = cleaned.replace(/\s*[-–—|:]\s*/g, ' ').trim();
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // If we have something left, capitalize it properly
  if (cleaned.length > 2) {
    return toTitleCase(cleaned);
  }

  return null;
}

/**
 * Extract flavor from syrup product name.
 */
function extractFlavor(name, vocab, defaultFlavor = 'Lychee') {
  // Sort longest-first so multi-word flavors ("Strawberry Pie") win over
  // substring matches ("Strawberry") when both exist in the vocabulary.
  const flavors = [...getFlavors(vocab)].sort((a, b) => b.length - a.length);
  for (const flavor of flavors) {
    if (name.toLowerCase().includes(flavor.toLowerCase())) {
      return flavor;
    }
  }

  return defaultFlavor;
}

/**
 * Check if name contains cross strain pattern (Strain x Strain)
 */
function extractCrossStrain(name) {
  // Look for "x", "X", or "+" between words
  const crossMatch = name.match(/([A-Za-z'\s]+)\s*[xX+]\s*([A-Za-z'\s]+)/);
  if (crossMatch) {
    const strain1 = crossMatch[1].trim();
    const strain2 = crossMatch[2].trim();
    // Clean up each part - remove brand and product type keywords
    let clean1 = strain1
      .replace(/^(ACE|Ace)\s*(Solventless)?\s*/i, '')
      .replace(/\b(hash\s*cones?|hash\s*wrapped|preroll|cone)\b/gi, '')
      .trim();
    let clean2 = strain2
      .replace(/(hash|wrapped|preroll|cone).*/i, '')
      .replace(/hand[\s-]*rolled.*/i, '')
      .replace(/\bhand\b\s*$/i, '')
      .replace(/[\d.]+\s*(g|mg)/i, '') // Remove size
      .trim();
    if (clean1 && clean2) {
      return `${toTitleCase(clean1)} x ${toTitleCase(clean2)}`;
    }
  }
  return null;
}

/**
 * Infer product type from size when name lacks keywords
 * @param {string} name - Product name
 * @param {string} size - Product size (e.g., "2g", "150mg", ".5g")
 * @returns {object|null} - Product type info or null
 */
function inferProductTypeFromSize(name, size) {
  if (!size) return null;

  const sizeLower = size.toLowerCase();

  // Hash Cones: 2.5g with cross strain pattern (+ or x)
  if ((sizeLower.includes('2.5g') || sizeLower === '2.5g') &&
      (name.includes('+') || name.toLowerCase().includes(' x '))) {
    return { normalized: 'Hash Cones', type: 'cross' };
  }

  // Jackpot Syrup: 150mg
  if (sizeLower.includes('150mg') || sizeLower === '150mg') {
    return { normalized: 'Jackpot Infused Syrup', type: 'flavor' };
  }

  // Sesh Stick Vape: .5g or 500mg (disposables)
  if (sizeLower.includes('.5g') || sizeLower.includes('0.5g') ||
      sizeLower.includes('500mg') || sizeLower === '.5g') {
    return { normalized: 'Sesh Stick Vape', type: 'strain' };
  }

  // Cold Cured Live Rosin: 2g (jars)
  if (sizeLower.includes('2g') || sizeLower === '2g') {
    return { normalized: 'Cold Cured Live Rosin', type: 'strain' };
  }

  return null;
}

/**
 * Clean up a product name by removing size brackets and extra info.
 * Output is always title-cased so ALL-CAPS menu names never leak through.
 */
function cleanName(name) {
  return toTitleCase(name
    // Remove ACE/Ace prefix and suffix
    .replace(/^(ACE|Ace)\s*(Solventless)?\s*[-:]\s*/i, '')
    .replace(/\s+(ACE|Ace)\s*(Solventless)?\s*$/i, '')
    // Remove leading size patterns: "8oz ...", "2g ...", "150mg ..."
    .replace(/^[\d.]+\s*(g|mg|ml|oz)\s*/i, '')
    // Remove size in brackets: [2g], [150mg], [2.5g]
    .replace(/\s*\[[\d.]+\s*(g|mg|ml|oz)\]/gi, '')
    // Remove size in parens: (150mg)
    .replace(/\s*\([\d.]+\s*(g|mg|ml|oz)\)/gi, '')
    // Remove standalone size patterns
    .replace(/\s*\|\s*[\d.]+\s*(g|mg|ml|oz)/gi, '')
    .replace(/\s*[-–]\s*[\d.]+\s*(g|mg|ml|oz)/gi, '')
    // Remove strain type suffixes
    .replace(/\s*(Hybrid|Indica|Sativa)(-Hybrid|-Indica|-Sativa)?$/i, '')
    // Remove THC/CBD info
    .replace(/THC:?\s*[\d.]+%?/gi, '')
    .replace(/CBD:?\s*[\d.]+%?/gi, '')
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .trim());
}

/**
 * Normalize a product name to clean format
 * @param {string} rawName - The scraped product name
 * @param {string|null} size - Optional size for inference
 * @param {{strains: string[], flavors: string[]}} vocab - Brand vocabulary loaded from Supabase
 * @returns {string} - Normalized product name
 */
function normalizeProductName(rawName, size = null, vocab = null) {
  if (!rawName) return rawName;

  // Extract size from name if not provided
  if (!size) {
    const sizeMatch = rawName.match(/[\d.]+\s*(g|mg|ml|oz)/i);
    size = sizeMatch ? sizeMatch[0] : null;
  }

  // Strip leading/trailing effect tokens so they don't pollute downstream
  // matching or the final normalized name. The effect type itself is
  // captured separately by extractEffectType().
  let workingName = stripEffectType(fixKnownTypos(rawName));

  // "Type Shit" is a collab tag, not a strain — strip it before matching so
  // it can't pollute strain extraction, then re-append as a "(Type Shit)"
  // suffix on the final normalized name.
  const isTypeShit = /type\s*shit/i.test(workingName);
  if (isTypeShit) {
    workingName = workingName
      .replace(/type\s*shit/gi, ' ')
      .replace(/^\s*[-–—:|]\s*/, '')
      .replace(/\s*[-–—:|]\s*$/, '')
      .replace(/\s*([-–—|])\s*(?=[-–—|])/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const withCollabTag = (result) => isTypeShit ? `${result} (Type Shit)` : result;

  // First, try to match by keywords in the name
  for (const productType of PRODUCT_TYPES) {
    // Check if any pattern matches
    const matches = productType.patterns.some(pattern => pattern.test(workingName));
    if (!matches) continue;

    // Check exclusions
    if (productType.exclude) {
      const excluded = productType.exclude.some(pattern => pattern.test(workingName));
      if (excluded) continue;
    }

    // Extract strain or flavor
    let descriptor = null;

    if (productType.extractFlavor) {
      descriptor = extractFlavor(workingName, vocab, productType.defaultFlavor);
    } else if (productType.strainFormat === 'cross') {
      descriptor = extractCrossStrain(workingName) || extractStrain(workingName, vocab);
    } else if (productType.extractStrain) {
      descriptor = extractStrain(workingName, vocab);
    }

    if (descriptor) {
      return withCollabTag(`${productType.normalized} - ${descriptor}`);
    } else {
      return withCollabTag(productType.normalized);
    }
  }

  // No keyword match - try to infer from size
  const inferred = inferProductTypeFromSize(workingName, size);
  if (inferred) {
    const cleaned = cleanName(workingName);

    if (inferred.type === 'flavor') {
      const flavor = extractFlavor(cleaned, vocab, 'Lychee');
      return withCollabTag(`${inferred.normalized} - ${flavor}`);
    } else if (inferred.type === 'cross') {
      // Convert "+" to "x" for cross strains
      const crossName = cleaned.replace(/\s*\+\s*/g, ' x ');
      return withCollabTag(`${inferred.normalized} - ${crossName}`);
    } else {
      return withCollabTag(`${inferred.normalized} - ${cleaned}`);
    }
  }

  // No match found, return cleaned version of original
  return withCollabTag(cleanName(workingName));
}

module.exports = {
  normalizeProductName,
  extractStrain,
  extractFlavor,
  extractEffectType,
  stripEffectType,
};
