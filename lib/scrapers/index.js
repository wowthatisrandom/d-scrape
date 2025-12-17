const DutchieScraper = require('./dutchie');
const VFIScraper = require('./vfi');

/**
 * Registry of available scrapers by platform name
 */
const scrapers = {
  dutchie: DutchieScraper,
  vfi: VFIScraper
};

/**
 * Get a scraper instance for the given platform
 * @param {string} platform - The platform name (e.g., 'dutchie', 'vfi')
 * @param {Object} options - Options to pass to the scraper constructor
 * @returns {BaseScraper} - An instance of the appropriate scraper
 */
function getScraper(platform, options = {}) {
  const ScraperClass = scrapers[platform?.toLowerCase()];

  if (!ScraperClass) {
    throw new Error(`Unknown platform: ${platform}. Available platforms: ${Object.keys(scrapers).join(', ')}`);
  }

  return new ScraperClass(options);
}

/**
 * Scrape a dispensary using the appropriate platform scraper
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
  return scraper.scrape(dispensary);
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
  VFIScraper
};
