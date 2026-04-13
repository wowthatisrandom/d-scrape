const BaseScraper = require('./base');

/**
 * Scraper for Leafbridge-powered dispensary menus
 * Leafbridge is a WordPress plugin that renders product cards directly in the DOM
 * Uses Dutchie as a backend (images from images.dutchie.com) but custom frontend
 */
class LeafbridgeScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
  }

  /**
   * Wait for Leafbridge product cards to load
   */
  async waitForProducts(page) {
    console.log('  ⏳ Waiting for Leafbridge products to load...');
    try {
      await page.waitForSelector('.leafbridge_product_card', { timeout: 30000 });
      console.log('  ✅ Products loaded');
    } catch (e) {
      console.log('  ⚠️ Product load timeout, continuing...');
    }
    // Extra wait for dynamic content
    await this.wait(3000);
  }

  /**
   * Extract products from Leafbridge page
   */
  async extractProducts(page) {
    return page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('.leafbridge_product_card');

      cards.forEach(card => {
        try {
          // Get product name from alt text or product name element
          const img = card.querySelector('.lb_prod_card_thumb');
          const altName = img?.alt || '';

          // Get the link URL
          const linkEl = card.querySelector('.leafbridge_product_a a, a[href*="/product/"]');
          const url = linkEl?.href || '';

          // Get price - look for leafbridge price element
          const priceEl = card.querySelector('.leafbridge_product_price, [class*="price"]');
          let price = null;
          if (priceEl) {
            // May have sale price - get the first dollar amount
            const priceText = priceEl.textContent || '';
            const priceMatch = priceText.match(/\$([\d.]+)/);
            if (priceMatch) {
              price = parseFloat(priceMatch[1]);
            }
          }

          // Get brand
          const brandEl = card.querySelector('.leafbridge_brand_name, [class*="brand_name"]');
          const brand = brandEl?.textContent?.trim() || null;

          // Get category
          const categoryEl = card.querySelector('.leafbridge_product_category, [class*="product_category"]');
          const category = categoryEl?.textContent?.trim() || null;

          // Get size - look for weight/size elements
          const fullText = card.textContent || '';
          let size = null;
          const sizeMatch = fullText.match(/(?:^|\s)([\d.]+\s*(?:g|mg|ml|oz)\b)/i);
          if (sizeMatch) {
            size = sizeMatch[1].trim();
          }

          // Get strain type
          let strainType = null;
          const strainMatch = fullText.match(/\b(Hybrid|Indica|Sativa|Indica Hybrid|Sativa Hybrid)\b/i);
          if (strainMatch) {
            strainType = strainMatch[1];
          }

          // Parse the product name - strip brand prefix like "Ace | "
          let name = altName;
          if (name.includes('|')) {
            const parts = name.split('|').map(p => p.trim());
            // Remove brand prefix, keep the rest
            if (parts.length >= 2) {
              name = parts.slice(1).join(' | ');
            }
          }

          if (name) {
            results.push({
              name,
              brand,
              price,
              category,
              strainType: strainType || null,
              size,
              url,
              raw: { fullName: altName, strainType }
            });
          }
        } catch (e) {
          console.error('Error parsing Leafbridge product:', e);
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

    const aceRegex = /\bace\b/i;
    const jackpotRegex = /\bjackpot\b/i;

    return products.filter(product => {
      const brand = (product.brand || '');
      const name = (product.name || '');
      const fullName = (product.raw?.fullName || '');

      const isAceBrand = aceRegex.test(brand) || jackpotRegex.test(brand);
      const isAceProduct = aceRegex.test(fullName) || jackpotRegex.test(fullName) ||
                           aceRegex.test(name) || jackpotRegex.test(name);

      return isAceBrand || isAceProduct;
    });
  }

  /**
   * Main scrape method
   * Leafbridge sites use the filtered_menu_url directly (brand filter in query params)
   */
  async scrape(dispensary) {
    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // Use filtered URL if available, otherwise base menu URL
      const menuUrl = dispensary.filtered_menu_url || dispensary.menu_url;
      console.log(`  📡 Loading Leafbridge menu: ${menuUrl}`);

      await this.navigateWithRetry(page, menuUrl, {
        waitUntil: 'networkidle2'
      });

      // Handle age gates
      await this.handleAgeGate(page);
      await this.wait(2000);

      // Wait for products
      await this.waitForProducts(page);

      // Extract products
      const products = await this.extractProducts(page);
      console.log(`  📦 Found ${products.length} total products`);

      // Filter to brand
      const filtered = this.filterProducts(products);
      console.log(`  🎯 ${filtered.length} Ace products after filtering`);

      return { products: filtered, detectedFormat: 'leafbridge', configWorked: true };

    } finally {
      await browser.close();
    }
  }
}

module.exports = LeafbridgeScraper;
