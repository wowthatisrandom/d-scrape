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
   * Format: ?brand.keyword=ACE+SOLVENTLESS
   */
  addFilters(url, brandValue = null) {
    const urlObj = new URL(url);

    const brand = brandValue || this.brandFilter;
    if (brand) {
      // Treez uses brand.keyword parameter
      const formattedBrand = brand.toUpperCase().replace(/\s+/g, '+');
      urlObj.searchParams.set('brand.keyword', formattedBrand);
    }

    return urlObj.toString();
  }

  /**
   * Get brand filter variations to try
   * Treez requires exact brand name match
   */
  getBrandVariations() {
    if (!this.brandFilter) return [null];

    const filter = this.brandFilter.toLowerCase();
    if (filter.includes('ace')) {
      // Try full name first, then just ACE
      return ['ACE SOLVENTLESS', 'ACE'];
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
   * Main scrape method
   */
  async scrape(dispensary) {
    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // Get brand variations to try
      const brandVariations = this.getBrandVariations();

      for (const brandVariation of brandVariations) {
        const menuUrl = brandVariation
          ? this.addFilters(dispensary.menu_url, brandVariation)
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

        // Extract products
        const products = await this.extractProducts(page);
        console.log(`  📦 Found ${products.length} products`);

        // Filter products
        const filteredProducts = this.filterProducts(products);

        if (filteredProducts.length > 0) {
          console.log(`  🎯 ${filteredProducts.length} Ace products found`);
          return filteredProducts;
        }

        if (brandVariations.length > 1) {
          console.log(`  ⚠️ No products with "${brandVariation}", trying next...`);
        }
      }

      console.log(`  ❌ No Ace products found with any brand variation`);
      return [];

    } finally {
      await browser.close();
    }
  }
}

module.exports = TreezScraper;
