const DutchieScraper = require('./dutchie');
const DutchiePlusScraper = require('./dutchie-plus');
const VFIScraper = require('./vfi');
const JaneScraper = require('./jane');
const TreezScraper = require('./treez');
const { updateDispensaryPlatform, updateScrapeConfig } = require('../supabase');

/**
 * Registry of available scrapers by platform name
 * dutchie-plus uses API-based scraper for Flutter sites
 */
const scrapers = {
  dutchie: DutchieScraper,
  'dutchie-plus': DutchiePlusScraper,
  vfi: VFIScraper,
  jane: JaneScraper,
  iheartjane: JaneScraper,
  treez: TreezScraper
};

/**
 * Get a scraper instance for the given platform
 * @param {string} platform - The platform name (e.g., 'dutchie', 'dutchie-plus', 'vfi')
 * @param {Object} options - Options to pass to the scraper constructor
 * @returns {BaseScraper} - An instance of the appropriate scraper
 */
function getScraper(platform, options = {}) {
  const platformLower = platform?.toLowerCase();
  const ScraperClass = scrapers[platformLower];

  if (!ScraperClass) {
    throw new Error(`Unknown platform: ${platform}. Available platforms: ${Object.keys(scrapers).join(', ')}`);
  }

  // Enable plus mode for dutchie-plus platform
  if (platformLower === 'dutchie-plus') {
    options.plusMode = true;
  }

  return new ScraperClass(options);
}

/**
 * Scrape a dispensary using the appropriate platform scraper
 * Auto-detects and saves platform format for future scrapes
 * @param {Object} dispensary - The dispensary object with menu_platform field
 * @param {Object} options - Options to pass to the scraper
 * @returns {Promise<Array>} - Array of product objects
 */
async function scrapeDispensary(dispensary, options = {}) {
  const platform = dispensary.menu_platform;

  if (!platform) {
    throw new Error(`Dispensary ${dispensary.name} has no menu_platform set`);
  }

  // If useFormat is specified, temporarily inject it into the dispensary's scrape_config
  // This is used by chain scraping to reuse a discovered format
  let originalConfig = null;
  if (options.useFormat) {
    originalConfig = dispensary.scrape_config;
    const configKey = platform === 'treez' ? 'brand_slug' : 'url_format';
    dispensary.scrape_config = { [configKey]: options.useFormat };
    // Also pass along the brand slug if provided
    if (options.useBrandSlug) {
      dispensary.scrape_config.brand_slug = options.useBrandSlug;
    }
  }

  const scraper = getScraper(platform, options);
  const result = await scraper.scrape(dispensary);

  // Restore original config if we modified it
  if (originalConfig !== null) {
    dispensary.scrape_config = originalConfig;
  }

  // Handle both old format (array) and new format ({ products, detectedFormat })
  let products, detectedFormat, configWorked, needsRetry, brandSlug;
  if (Array.isArray(result)) {
    products = result;
    detectedFormat = null;
    configWorked = false;
    needsRetry = false;
    brandSlug = null;
  } else {
    products = result.products;
    detectedFormat = result.detectedFormat;
    configWorked = result.configWorked || false;
    needsRetry = result.needsRetry || false;
    brandSlug = result.brandSlug || null;
  }

  // Track what format was actually used
  const usedFormat = options.useFormat || detectedFormat;

  // If we detected a plus format on a regular dutchie site, upgrade it
  if (platform === 'dutchie' && detectedFormat && detectedFormat.startsWith('plus-')) {
    console.log(`  🔄 Upgrading ${dispensary.name} from dutchie to dutchie-plus`);
    try {
      await updateDispensaryPlatform(dispensary.id, 'dutchie-plus');
    } catch (e) {
      console.log(`  ⚠️ Failed to update platform: ${e.message}`);
    }
  }

  // Save the working config if we found products
  // Always save to ensure all dispensaries have proper config
  const formatToSave = usedFormat || detectedFormat;
  if (formatToSave && products.length > 0) {
    const configToSave = {};
    if (platform === 'treez') {
      configToSave.brand_slug = formatToSave;
    } else {
      configToSave.url_format = formatToSave;
      if (brandSlug) {
        configToSave.brand_slug = brandSlug;
      }
    }
    console.log(`  💾 Saving config: ${JSON.stringify(configToSave)}`);
    try {
      await updateScrapeConfig(dispensary.id, configToSave);
    } catch (e) {
      console.log(`  ⚠️ Failed to save config: ${e.message}`);
    }
  }

  return { products, needsRetry, usedFormat, brandSlug };
}

/**
 * Retry scraping with full format discovery (ignores saved config)
 * Used for dispensaries that returned 0 products with saved config
 */
async function scrapeDispensaryWithDiscovery(dispensary, options = {}) {
  const platform = dispensary.menu_platform;

  if (!platform) {
    throw new Error(`Dispensary ${dispensary.name} has no menu_platform set`);
  }

  // Clear the saved config temporarily to force format discovery
  const originalConfig = dispensary.scrape_config;
  dispensary.scrape_config = null;

  console.log(`  🔍 Retrying with full format discovery...`);

  const scraper = getScraper(platform, options);
  const result = await scraper.scrape(dispensary);

  // Restore original config
  dispensary.scrape_config = originalConfig;

  // Handle both old format (array) and new format ({ products, detectedFormat })
  let products, detectedFormat, configWorked;
  if (Array.isArray(result)) {
    products = result;
    detectedFormat = null;
    configWorked = false;
  } else {
    products = result.products;
    detectedFormat = result.detectedFormat;
    configWorked = result.configWorked || false;
  }

  // If we detected a plus format on a regular dutchie site, upgrade it
  if (platform === 'dutchie' && detectedFormat && detectedFormat.startsWith('plus-')) {
    console.log(`  🔄 Upgrading ${dispensary.name} from dutchie to dutchie-plus`);
    try {
      await updateDispensaryPlatform(dispensary.id, 'dutchie-plus');
    } catch (e) {
      console.log(`  ⚠️ Failed to update platform: ${e.message}`);
    }
  }

  // Save the new config if we found products with a different format
  if (detectedFormat && products.length > 0) {
    console.log(`  💾 Saving new config: ${detectedFormat}`);
    try {
      const configKey = platform === 'treez' ? 'brand_slug' : 'url_format';
      await updateScrapeConfig(dispensary.id, { [configKey]: detectedFormat });
    } catch (e) {
      console.log(`  ⚠️ Failed to save config: ${e.message}`);
    }
  }

  return products;
}

/**
 * Get list of supported platforms
 */
function getSupportedPlatforms() {
  return Object.keys(scrapers);
}

/**
 * Register a new scraper for a platform
 * @param {string} platform - The platform name
 * @param {Class} ScraperClass - The scraper class (must extend BaseScraper)
 */
function registerScraper(platform, ScraperClass) {
  scrapers[platform.toLowerCase()] = ScraperClass;
}

module.exports = {
  getScraper,
  scrapeDispensary,
  scrapeDispensaryWithDiscovery,
  getSupportedPlatforms,
  registerScraper,
  // Export individual scrapers for direct use if needed
  DutchieScraper,
  DutchiePlusScraper,
  VFIScraper,
  JaneScraper,
  TreezScraper
};
