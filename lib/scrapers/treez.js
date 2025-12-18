const BaseScraper = require('./base');

/**
 * Scraper for Treez-powered dispensary menus
 * Treez uses direct rendering with product cards
 */
class TreezScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
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
   * Treez uses URL slugs like "ace-solventless"
   */
  getBrandVariations() {
    if (!this.brandFilter) return [null];

    const filter = this.brandFilter.toLowerCase();
    if (filter.includes('ace')) {
      // Try different slug variations
      return ['ace-solventless', 'ace'];
    }
    return [this.brandFilter];
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

          // Get info elements (THC, category, strain type)
          const infoEls = card.querySelectorAll('[class*="product_info__"]');
          let category = null;
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
            // Category (usually all caps, not a strain type)
            else if (text === text.toUpperCase() && text.length > 2) {
              // Skip if it's the brand name
              if (!text.includes('ACE') && !category) {
                category = text;
              }
            }
          });

          // Get URL
          const url = card.href;

          if (name) {
            results.push({
              name,
              brand,
              price,
              category: category || strainType,
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

    return products.filter(product => {
      const brand = (product.brand || '').toLowerCase();
      const name = (product.name || '').toLowerCase();
      const fullName = (product.raw?.fullName || '').toLowerCase();

      // Check if "ace" is in brand or full name
      if (!brand.includes('ace') && !fullName.includes('ace')) {
        return false;
      }

      // Exclude distillate products (Ace only makes solventless)
      if (name.includes('distillate')) {
        return false;
      }

      return true;
    });
  }

  /**
   * Try scraping with a specific brand slug
   */
  async tryScrapeWithSlug(page, dispensary, brandSlug) {
    const menuUrl = brandSlug
      ? this.addFilters(dispensary.menu_url, brandSlug)
      : dispensary.menu_url;

    console.log(`  📡 Loading: ${menuUrl}`);

    await page.goto(menuUrl, {
      waitUntil: 'networkidle2',
      timeout: this.options.timeout
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

      // Check for saved config - use it directly if available
      const savedConfig = dispensary.scrape_config;
      if (savedConfig?.brand_slug) {
        console.log(`  ⚡ Using saved config: brand_slug=${savedConfig.brand_slug}`);

        try {
          const products = await this.tryScrapeWithSlug(page, dispensary, savedConfig.brand_slug);
          if (products.length > 0) {
            console.log(`  🎯 ${products.length} Ace products found with saved config`);
            return { products, detectedFormat: savedConfig.brand_slug, configWorked: true };
          }
          console.log(`  ⚠️ Saved config returned no products, trying all variations...`);
        } catch (e) {
          console.log(`  ⚠️ Saved config failed: ${e.message}, trying all variations...`);
        }
      }

      // Get brand variations to try
      const brandVariations = this.getBrandVariations();

      for (const brandVariation of brandVariations) {
        try {
          const products = await this.tryScrapeWithSlug(page, dispensary, brandVariation);

          if (products.length > 0) {
            console.log(`  🎯 ${products.length} Ace products found with "${brandVariation}"`);
            return { products, detectedFormat: brandVariation, configWorked: false };
          }

          if (brandVariations.length > 1) {
            console.log(`  ⚠️ No products with "${brandVariation}", trying next...`);
          }
        } catch (e) {
          console.log(`  ⚠️ "${brandVariation}" failed: ${e.message}, trying next...`);
        }
      }

      console.log(`  ❌ No Ace products found with any brand variation`);
      return { products: [], detectedFormat: null };

    } finally {
      await browser.close();
    }
  }
}

module.exports = TreezScraper;
