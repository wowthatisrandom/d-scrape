const BaseScraper = require('./base');
const { isExcludedProduct } = require('../exclusions');

/**
 * Scraper for Treez-powered dispensary menus
 * Treez uses direct rendering with product cards
 */
class TreezScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
    // Rediscover mode - ignore saved configs, try all variations
    this.rediscover = options.rediscover || false;
  }

  /**
   * Add brand filter to Treez URL
   * Format: /brand/ace-solventless (path-based)
   */
  addFilters(url, brandSlug = null) {
    const urlObj = new URL(url);

    const slug = brandSlug || this.brandFilter;
    if (slug) {
      // Treez uses path-based brand filtering: /brand/{slug}
      // Remove trailing slash and append brand path
      urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '/brand/' + slug;
    }

    return urlObj.toString();
  }

  /**
   * Get brand filter variations to try
   * Treez uses URL slugs like "ace-solventless" OR query params
   */
  getBrandVariations() {
    if (!this.brandFilter) return [null];

    const filter = this.brandFilter.toLowerCase();
    if (filter.includes('ace')) {
      // Try different variations - query param format first (works for Current Cannabis)
      return ['query-multi', 'ace-solventless', 'ace'];
    }
    return [this.brandFilter];
  }

  /**
   * Build URL with query params for multi-brand search (Ace + Jackpot)
   */
  buildMultiBrandUrl(url) {
    const urlObj = new URL(url);
    // Ensure we're on /shop page
    if (!urlObj.pathname.includes('/shop')) {
      urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '/shop';
    }
    // Add multi-brand query params
    urlObj.searchParams.set('query', 'ace jackpot');
    urlObj.searchParams.set('brand.keyword', 'JACKPOT,ACE SOLVENTLESS');
    return urlObj.toString();
  }

  /**
   * Handle age gate
   */
  async handleTreezAgeGate(page) {
    try {
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, a, input[type="submit"]');
        for (const btn of buttons) {
          const text = (btn.textContent || btn.value || '').toLowerCase();
          if (text.includes('21') || text.includes('yes') || text.includes('enter') || text.includes('i am')) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log('  ✅ Age gate bypassed');
        await this.wait(2000);
      }
    } catch (e) {
      console.log('  ⚠️ Age gate handling error:', e.message);
    }
  }

  /**
   * Wait for products to load
   */
  async waitForProducts(page) {
    console.log('  ⏳ Waiting for Treez products to load...');
    try {
      await page.waitForSelector('a[href*="/product/"]', { timeout: 30000 });
      console.log('  ✅ Products loaded');
    } catch (e) {
      console.log('  ⚠️ Product load timeout, continuing...');
    }
    // Extra wait for dynamic content
    await this.wait(3000);
  }

  /**
   * Extract products from Treez page
   */
  async extractProducts(page) {
    return page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('a[href*="/product/"]');

      cards.forEach(card => {
        try {
          // Get product name - format is "Brand | Product Name | Size"
          const nameEl = card.querySelector('[class*="product__name"]');
          const fullName = nameEl?.innerText?.trim() || '';

          // Parse name into components
          const nameParts = fullName.split('|').map(p => p.trim());
          let brand = null;
          let name = fullName;
          let size = null;

          if (nameParts.length >= 2) {
            brand = nameParts[0];
            name = nameParts.slice(1, -1).join(' | ') || nameParts[1];
            // Last part is usually size
            const lastPart = nameParts[nameParts.length - 1];
            if (lastPart && /\d/.test(lastPart)) {
              size = lastPart;
            }
          }

          // Get price
          const priceEl = card.querySelector('[class*="price__"]');
          const priceText = priceEl?.innerText || '';
          const priceMatch = priceText.match(/\$([\d.]+)/);
          const price = priceMatch ? parseFloat(priceMatch[1]) : null;

          // Get info elements (THC, category, strain type). Treez themes
          // are inconsistent — sometimes the info pills hold strain type,
          // sometimes they hold size labels like "150MG" or "2G", sometimes
          // they hold the real category like "LIVE ROSIN". We triage the
          // text and prefer name-based category inference over whatever
          // the pill says.
          const infoEls = card.querySelectorAll('[class*="product_info__"]');
          let rawCategoryFromPill = null;
          let thc = null;
          let strainType = null;

          infoEls.forEach(el => {
            const text = el.innerText.trim();

            // THC percentage
            if (text.includes('%')) {
              thc = text;
            }
            // Strain types
            else if (['HYBRID', 'INDICA', 'SATIVA', 'CBD'].includes(text.toUpperCase())) {
              strainType = text;
            }
            // Size labels like "150MG", "2G", "240MG" — skip, these are
            // not product categories.
            else if (/^[\d.]+\s*(mg|g|oz|ml)$/i.test(text)) {
              // noop — size, ignore
            }
            // Category (usually all caps, not a strain type)
            else if (text === text.toUpperCase() && text.length > 2) {
              // Skip if it's the brand name
              if (!text.includes('ACE') && !rawCategoryFromPill) {
                rawCategoryFromPill = text;
              }
            }
          });

          // Fallback: some Treez themes put the strain-type pill in a
          // different element class (e.g., chip/badge/strain-type) that
          // the product_info__ selector doesn't catch. Scan the full card
          // text for a strain-type word as a secondary extraction.
          if (!strainType) {
            const cardText = (card.textContent || '').trim();
            const strainMatch = cardText.match(/\b(Indica\s*Hybrid|Sativa\s*Hybrid|Indica\s*Dominant|Sativa\s*Dominant|Hybrid|Indica|Sativa)\b/i);
            if (strainMatch) strainType = strainMatch[1];
          }

          // Prefer name-keyword category inference over whatever the pill
          // said — Treez pills are too unreliable. Mirrors the same helper
          // used in dutchie.js and vfi.js. Order matters: sesh stick first
          // so "rosin" in the name doesn't win for vapes.
          let category = null;
          if (name) {
            const nameLower = name.toLowerCase();
            if (nameLower.includes('sesh stick') || nameLower.includes('disposable') || nameLower.includes('vape')) {
              category = 'Vape';
            } else if (nameLower.includes('hash cone')) {
              category = 'Infused Preroll';
            } else if (nameLower.includes('cold cure') || nameLower.includes('badder') || nameLower.includes('live rosin')) {
              category = 'Live Rosin';
            } else if (nameLower.includes('syrup') || nameLower.includes('liquid gold') || nameLower.includes('hot sauce')) {
              category = 'Edible';
            }
          }

          // If name inference failed, fall back to the pill text (title-cased
          // for consistency with the canonical display labels).
          if (!category && rawCategoryFromPill) {
            const lower = rawCategoryFromPill.toLowerCase();
            if (lower.includes('live rosin') || lower.includes('rosin') || lower.includes('concentrate')) category = 'Live Rosin';
            else if (lower.includes('edible') || lower.includes('syrup')) category = 'Edible';
            else if (lower.includes('vape') || lower.includes('disposable')) category = 'Vape';
            else if (lower.includes('preroll') || lower.includes('pre-roll') || lower.includes('cone')) category = 'Infused Preroll';
          }

          // Get URL
          const url = card.href;

          if (name) {
            results.push({
              name,
              brand,
              price,
              category: category || null,
              strainType: strainType || null,
              size,
              thc,
              url,
              raw: { fullName }
            });
          }
        } catch (e) {
          console.error('Error parsing Treez product:', e);
        }
      });

      return results;
    });
  }

  /**
   * Filter products by brand
   */
  filterProducts(products) {
    if (!this.brandFilter) {
      return products;
    }

    // Use word boundary regex to avoid matching "ace" inside words like "replacement"
    const aceRegex = /\bace\b/i;
    const jackpotRegex = /\bjackpot\b/i;

    return products.filter(product => {
      const brand = (product.brand || '');
      const name = (product.name || '');
      const fullName = (product.raw?.fullName || '');

      // Check if "ace" or "jackpot" (Ace sub-brand) is in brand or full name as whole word
      const isAceBrand = aceRegex.test(brand) || jackpotRegex.test(brand);
      const isAceProduct = aceRegex.test(fullName) || jackpotRegex.test(fullName);

      if (!isAceBrand && !isAceProduct) {
        return false;
      }

      // Exclude distillate products (Ace only makes solventless)
      if (name.toLowerCase().includes('distillate')) {
        return false;
      }

      if (isExcludedProduct(name, brand) || isExcludedProduct(fullName, brand)) {
        return false;
      }

      return true;
    });
  }

  /**
   * Try scraping with a specific brand slug or query format
   */
  async tryScrapeWithSlug(page, dispensary, brandSlug) {
    let menuUrl;
    if (brandSlug === 'query-multi') {
      // Use query param format for multi-brand search
      menuUrl = this.buildMultiBrandUrl(dispensary.menu_url);
    } else if (brandSlug) {
      menuUrl = this.addFilters(dispensary.menu_url, brandSlug);
    } else {
      menuUrl = dispensary.menu_url;
    }

    await this.navigateWithRetry(page, menuUrl, {
      waitUntil: 'networkidle2'
    });

    await this.wait(2000);

    // Handle age gates
    await this.handleTreezAgeGate(page);
    await this.handleAgeGate(page);

    // Wait for products
    await this.waitForProducts(page);

    // Extract and filter products
    const products = await this.extractProducts(page);
    console.log(`  📦 Found ${products.length} products`);

    return this.filterProducts(products);
  }

  /**
   * Main scrape method
   * Uses saved config if available, otherwise tries variations and saves what works
   */
  async scrape(dispensary) {
    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // Check for saved config - use it directly if available (unless rediscover mode)
      const savedConfig = dispensary.scrape_config;
      if (this.rediscover && savedConfig?.brand_slug) {
        console.log(`  🔄 Rediscover mode - ignoring saved config: ${savedConfig.brand_slug}`);
      }
      if (savedConfig?.brand_slug && !this.rediscover) {
        console.log(`  ⚡ Using saved config: brand_slug=${savedConfig.brand_slug}`);

        try {
          const products = await this.tryScrapeWithSlug(page, dispensary, savedConfig.brand_slug);
          if (products.length > 0) {
            console.log(`  🎯 ${products.length} Ace products found with saved config`);
            return { products, detectedFormat: savedConfig.brand_slug, configWorked: true };
          }
          // Trust saved config - format worked, just no products
          console.log(`  ℹ️ Saved config worked, no Ace products at this location`);
          return { products: [], detectedFormat: savedConfig.brand_slug, configWorked: true };
        } catch (e) {
          // If navigation timed out, don't try other formats - site is down
          if (e.message?.includes('Navigation timeout')) {
            console.log(`  ❌ Site unreachable (timeout), skipping other formats`);
            throw e;
          }
          console.log(`  ⚠️ Saved config failed: ${e.message}, trying all variations...`);
        }
      }

      // Get brand variations to try
      const brandVariations = this.getBrandVariations();

      // Track first variation that successfully loads (even with 0 products)
      let firstWorkingVariation = null;

      for (const brandVariation of brandVariations) {
        try {
          const products = await this.tryScrapeWithSlug(page, dispensary, brandVariation);

          // Track first variation that works (loads without error)
          if (!firstWorkingVariation) {
            firstWorkingVariation = brandVariation;
          }

          if (products.length > 0) {
            console.log(`  🎯 ${products.length} Ace products found with "${brandVariation}"`);
            return { products, detectedFormat: brandVariation, configWorked: false };
          }

          if (brandVariations.length > 1) {
            console.log(`  ⚠️ No products with "${brandVariation}", trying next...`);
          }
        } catch (e) {
          // If navigation timed out, don't try other formats - site is down
          if (e.message?.includes('Navigation timeout')) {
            console.log(`  ❌ Site unreachable (timeout), skipping other formats`);
            throw e;
          }
          console.log(`  ⚠️ "${brandVariation}" failed: ${e.message}, trying next...`);
        }
      }

      // No products found, but save first working variation so we don't retry all variations next time
      if (firstWorkingVariation) {
        console.log(`  ℹ️ No Ace products found, but saving working variation: ${firstWorkingVariation}`);
        return { products: [], detectedFormat: firstWorkingVariation, configWorked: false };
      }

      console.log(`  ❌ All brand variations failed`);
      return { products: [], detectedFormat: null };

    } finally {
      await browser.close();
    }
  }
}

module.exports = TreezScraper;
