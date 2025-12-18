/**
 * ACE Solventless Product Name Normalizer
 * Converts scraped product names to clean, consistent format
 */

/**
 * Product type patterns and their normalized names
 */
const PRODUCT_TYPES = [
  {
    // Cold Cured Live Rosin (2g jars)
    patterns: [/live\s*rosin\s*cold\s*cure/i, /cold\s*cure.*live\s*rosin/i, /cold\s*cured\s*live\s*rosin/i, /live\s*rosin/i],
    exclude: [/sesh\s*stick/i, /disposable/i, /vape/i, /syrup/i, /preroll/i, /cone/i],
    normalized: 'Cold Cured Live Rosin',
    extractStrain: true
  },
  {
    // Sesh Stick Vapes (disposables)
    patterns: [/sesh\s*stick/i, /hash\s*rosin\s*sesh/i, /rosin\s*disposable/i],
    normalized: 'Sesh Stick Vape',
    extractStrain: true
  },
  {
    // Jackpot Infused Syrups
    patterns: [/jackpot/i, /liquid\s*gold/i, /infused\s*syrup/i, /solventless\s*syrup/i],
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
  }
];

/**
 * Common strain names to help extraction
 */
const KNOWN_STRAINS = [
  'Grape Gas', 'First Degree Strobbery', 'Second Degree Strobbery',
  'Sewer Water', 'Buttered Biscuits', 'Orange Pie', 'Pothole',
  'Mellow Yellow', 'Trop Ya Life Up', 'Buttered Sausage',
  "Grandpa's Stash", 'Divine Banana', 'Gary Payton'
];

/**
 * Flavor names for syrups
 */
const KNOWN_FLAVORS = [
  'Salted Caramel', 'Strawberry', 'Lychee', 'Black Cherry',
  'Watermelon', 'Grape', 'Mango', 'Peach'
];

/**
 * Extract strain name from product name
 */
function extractStrain(name) {
  // First, check for known strains
  for (const strain of KNOWN_STRAINS) {
    if (name.toLowerCase().includes(strain.toLowerCase())) {
      return strain;
    }
  }

  // Try to extract from common patterns
  // Pattern: "Strain Name - Product Type" or "ACE Strain Name Product Type"

  // Remove ACE/Ace Solventless prefix
  let cleaned = name.replace(/^(ACE|Ace)\s*(Solventless)?\s*/i, '');

  // Remove size info
  cleaned = cleaned.replace(/\|\s*[\d.]+\s*(g|mg|ml)/i, '');
  cleaned = cleaned.replace(/[\d.]+\s*(g|mg|ml)/i, '');

  // Remove strain type indicators
  cleaned = cleaned.replace(/\s*\(?[HSI]\)?\s*$/i, ''); // (H), (S), (I)
  cleaned = cleaned.replace(/\s*(Hybrid|Indica|Sativa)(-Hybrid|-Indica|-Sativa)?$/i, '');

  // Remove product type keywords
  cleaned = cleaned.replace(/live\s*rosin\s*cold\s*cure\s*badder/i, '');
  cleaned = cleaned.replace(/cold\s*cure\s*live\s*rosin/i, '');
  cleaned = cleaned.replace(/cold\s*cured\s*live\s*rosin/i, '');
  cleaned = cleaned.replace(/hash\s*rosin\s*sesh\s*stick/i, '');
  cleaned = cleaned.replace(/sesh\s*stick/i, '');
  cleaned = cleaned.replace(/live\s*rosin/i, '');
  cleaned = cleaned.replace(/hash\s*wrapped\s*preroll/i, '');
  cleaned = cleaned.replace(/rosin\s*disposable\s*vape/i, '');
  cleaned = cleaned.replace(/disposable\s*vape/i, '');

  // Remove THC/CBD info
  cleaned = cleaned.replace(/THC:?\s*[\d.]+%?/i, '');
  cleaned = cleaned.replace(/CBD:?\s*[\d.]+%?/i, '');

  // Clean up separators and whitespace
  cleaned = cleaned.replace(/\s*[-–—|]\s*/g, ' ').trim();
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // If we have something left, capitalize it properly
  if (cleaned.length > 2) {
    return cleaned.split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  return null;
}

/**
 * Extract flavor from syrup product name
 */
function extractFlavor(name, defaultFlavor = 'Lychee') {
  // Check for known flavors
  for (const flavor of KNOWN_FLAVORS) {
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
  // Look for "x" or "X" between words
  const crossMatch = name.match(/([A-Za-z'\s]+)\s*[xX]\s*([A-Za-z'\s]+)/);
  if (crossMatch) {
    const strain1 = crossMatch[1].trim();
    const strain2 = crossMatch[2].trim();
    // Clean up each part
    const clean1 = strain1.replace(/^(ACE|Ace)\s*/i, '').trim();
    const clean2 = strain2.replace(/(hash|wrapped|preroll|cone).*/i, '').trim();
    if (clean1 && clean2) {
      return `${clean1} x ${clean2}`;
    }
  }
  return null;
}

/**
 * Normalize a product name to clean format
 * @param {string} rawName - The scraped product name
 * @returns {string} - Normalized product name
 */
function normalizeProductName(rawName) {
  if (!rawName) return rawName;

  // Find matching product type
  for (const productType of PRODUCT_TYPES) {
    // Check if any pattern matches
    const matches = productType.patterns.some(pattern => pattern.test(rawName));
    if (!matches) continue;

    // Check exclusions
    if (productType.exclude) {
      const excluded = productType.exclude.some(pattern => pattern.test(rawName));
      if (excluded) continue;
    }

    // Extract strain or flavor
    let descriptor = null;

    if (productType.extractFlavor) {
      descriptor = extractFlavor(rawName, productType.defaultFlavor);
    } else if (productType.strainFormat === 'cross') {
      descriptor = extractCrossStrain(rawName) || extractStrain(rawName);
    } else if (productType.extractStrain) {
      descriptor = extractStrain(rawName);
    }

    if (descriptor) {
      return `${productType.normalized} - ${descriptor}`;
    } else {
      return productType.normalized;
    }
  }

  // No match found, return cleaned version of original
  return rawName
    .replace(/\s*(Hybrid|Indica|Sativa)(-Hybrid|-Indica|-Sativa)?$/i, '')
    .replace(/THC:?\s*[\d.]+%?/i, '')
    .replace(/CBD:?\s*[\d.]+%?/i, '')
    .trim();
}

/**
 * Normalize an array of products
 */
function normalizeProducts(products) {
  return products.map(product => ({
    ...product,
    normalizedName: normalizeProductName(product.name || product.scraped_product_name)
  }));
}

module.exports = {
  normalizeProductName,
  normalizeProducts,
  extractStrain,
  extractFlavor,
  KNOWN_STRAINS,
  KNOWN_FLAVORS
};
