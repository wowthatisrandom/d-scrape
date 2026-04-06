const DutchieScraper = require('./dutchie');
const DutchiePlusScraper = require('./dutchie-plus');
const VFIScraper = require('./vfi');
const JaneScraper = require('./jane');
const TreezScraper = require('./treez');
const WeedmapsScraper = require('./weedmaps');
const LeafbridgeScraper = require('./leafbridge');
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
  treez: TreezScraper,
  weedmaps: WeedmapsScraper,
  leafbridge: LeafbridgeScraper
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
  let products, detectedFormat, configWorked, needsRetry, brandSlug, storeSlug;
  if (Array.isArray(result)) {
    products = result;
    detectedFormat = null;
    configWorked = false;
    needsRetry = false;
    brandSlug = null;
    storeSlug = null;
  } else {
    products = result.products;
    detectedFormat = result.detectedFormat;
    configWorked = result.configWorked || false;
    needsRetry = result.needsRetry || false;
    brandSlug = result.brandSlug || null;
    storeSlug = result.storeSlug || null;
  }

  // Exclude collab products (e.g. "Ace x Stellar") - not our brand
  products = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const brand = (p.brand || '').toLowerCase();
    return !name.includes('stellar') && !brand.includes('stellar');
  });

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

  // Save the working config if we found products AND:
  // - Config didn't already work (we had to discover/change something)
  // - OR we discovered new info (storeSlug) that should be saved
  const formatToSave = usedFormat || detectedFormat;
  const shouldSaveConfig = products.length > 0 && !configWorked;

  if (shouldSaveConfig && (formatToSave || storeSlug)) {
    const configToSave = {};
    if (platform === 'treez') {
      configToSave.brand_slug = formatToSave;
    } else {
      if (formatToSave) configToSave.url_format = formatToSave;
      if (brandSlug) configToSave.brand_slug = brandSlug;
      if (storeSlug) configToSave.store_slug = storeSlug;
    }
    console.log(`  💾 Saving config: ${JSON.stringify(configToSave)}`);
    try {
      await updateScrapeConfig(dispensary.id, configToSave);
    } catch (e) {
      console.log(`  ⚠️ Failed to save config: ${e.message}`);
    }
  }

  return { products, needsRetry, usedFormat, brandSlug, storeSlug };
}

/**
 * Retry scraping with full format discovery (ignores saved config)
 * Used for dispensaries that returned 0 products with saved config
 * If dispensary has store_slug, tries direct URL first before format discovery
 */
async function scrapeDispensaryWithDiscovery(dispensary, options = {}) {
  const platform = dispensary.menu_platform;

  if (!platform) {
    throw new Error(`Dispensary ${dispensary.name} has no menu_platform set`);
  }

  const originalConfig = dispensary.scrape_config;

  // If we have a store_slug, try direct URL first (skip full format discovery)
  // This is faster and usually works - just needs fresh navigation
  if (originalConfig?.store_slug) {
    console.log(`  🔄 Retrying direct URL for ${originalConfig.store_slug}...`);
    // Keep store_slug but clear url_format to force direct path
    dispensary.scrape_config = { store_slug: originalConfig.store_slug, brand_slug: originalConfig.brand_slug };

    const scraper = getScraper(platform, options);
    const result = await scraper.scrape(dispensary);
    dispensary.scrape_config = originalConfig;

    let products = Array.isArray(result) ? result : result.products;
    products = (products || []).filter(p => {
      const name = (p.name || '').toLowerCase();
      const brand = (p.brand || '').toLowerCase();
      return !name.includes('stellar') && !brand.includes('stellar');
    });
    if (products.length > 0) {
      return products;
    }
    console.log(`  ⚠️ Direct URL retry failed, skipping full discovery (too slow)`);
    return [];
  }

  // No store_slug - do limited format discovery (only try 2 most common formats)
  console.log(`  🔍 Retrying with limited format discovery...`);
  dispensary.scrape_config = null;

  // Limit to 2 formats to avoid long retry loops
  const scraper = getScraper(platform, { ...options, maxFormats: 2 });
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

  // Exclude collab products (e.g. "Ace x Stellar") - not our brand
  products = products.filter(p => {
    const name = (p.name || '').toLowerCase();
    const brand = (p.brand || '').toLowerCase();
    return !name.includes('stellar') && !brand.includes('stellar');
  });

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
  TreezScraper,
  WeedmapsScraper,
  LeafbridgeScraper
};
