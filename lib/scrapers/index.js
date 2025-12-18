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

  const scraper = getScraper(platform, options);
  const result = await scraper.scrape(dispensary);

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

  // Save the working config if we discovered a new one (not from saved config)
  if (detectedFormat && !configWorked) {
    console.log(`  💾 Saving config: ${detectedFormat}`);
    try {
      // Use appropriate config key based on platform
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
  getSupportedPlatforms,
  registerScraper,
  // Export individual scrapers for direct use if needed
  DutchieScraper,
  DutchiePlusScraper,
  VFIScraper,
  JaneScraper,
  TreezScraper
};
