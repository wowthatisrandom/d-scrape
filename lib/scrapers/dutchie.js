const BaseScraper = require('./base');

/**
 * Scraper for Dutchie-powered dispensary menus
 * Handles iframe detection and Dutchie-specific selectors
 */
class DutchieScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    // Brand filter - can be customized per instance
    this.brandFilter = options.brandFilter || null;
  }

  /**
   * Add Ace Solventless filter parameters to Dutchie URL
   */
  addAceFilters(url) {
    const urlObj = new URL(url);

    const aceParams = {
      'dtche[path]': 'products',
      'dtche[brands]': 'ace-solventless',
      'dtche[search]': 'ace'
    };

    for (const [key, value] of Object.entries(aceParams)) {
      if (!urlObj.searchParams.has(key)) {
        urlObj.searchParams.set(key, value);
      }
    }

    return urlObj.toString();
  }

  /**
   * Find and switch to Dutchie iframe if present
   */
  async findDutchieFrame(page) {
    const iframeSelectors = [
      'iframe[src*="dutchie"]',
      'iframe[src*="dtche"]',
      'iframe[id*="dutchie"]',
      'iframe[class*="dutchie"]',
      'iframe[src*="embedded-menu"]'
    ];

    // Try specific selectors first
    for (const selector of iframeSelectors) {
      const iframeElement = await page.$(selector);
      if (iframeElement) {
        console.log(`  🖼️ Found Dutchie iframe: ${selector}`);
        const frame = await iframeElement.contentFrame();
        if (frame) {
          return frame;
        }
      }
    }

    // Check all frames by URL
    const frames = page.frames();
    console.log(`  🔍 Found ${frames.length} frames total`);
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes('dutchie') || url.includes('embedded-menu') || url.includes('dtche')) {
        console.log(`  🖼️ Found Dutchie frame by URL: ${url}`);
        return frame;
      }
    }

    return null;
  }

  /**
   * Wait for iframe content to render
   */
  async waitForIframeContent(frame) {
    console.log('  ⏳ Waiting for iframe content to render...');
    try {
      await frame.waitForFunction(
        () => {
          const nextDiv = document.getElementById('__next');
          const renderTarget = document.getElementById('render-target');
          return (nextDiv && nextDiv.children.length > 0) ||
                 (renderTarget && renderTarget.children.length > 0);
        },
        { timeout: 15000 }
      );
      console.log('  ✅ Iframe content rendered');
    } catch (e) {
      console.log('  ⚠️ Iframe render wait timed out, continuing...');
    }
    await this.wait(3000);
  }

  /**
   * Extract products from the page/frame
   */
  async extractProducts(targetFrame) {
    return targetFrame.evaluate(() => {
      const results = [];

      const selectors = [
        '[data-testid="product-list-item"]',
        '[data-testid="product-card"]',
        '[class*="full-card__Wrapper"]'
      ];

      let productElements = [];
      for (const selector of selectors) {
        productElements = document.querySelectorAll(selector);
        if (productElements.length > 0) {
          break;
        }
      }

      productElements.forEach(el => {
        try {
          const nameEl = el.querySelector(
            '[class*="full-card__Name"], [class*="ProductName"], [data-testid="product-name"], h3, h4'
          );
          const name = nameEl?.textContent?.trim();

          if (!name) return;

          const brandEl = el.querySelector(
            '[class*="full-card__Brand"], [class*="ProductBrand"], [data-testid="product-brand"]'
          );
          const brand = brandEl?.textContent?.trim();

          const priceEl = el.querySelector(
            '[class*="full-card__Details"], [class*="Price"], [data-testid="product-price"], [class*="price"]'
          );
          const priceText = priceEl?.textContent?.trim();
          const priceMatch = priceText?.match(/\$[\d.]+/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace('$', '')) : null;

          const categoryEl = el.querySelector(
            '[class*="category"], [data-testid="product-category"]'
          );
          const category = categoryEl?.textContent?.trim();

          const sizeEl = el.querySelector('[class*="optionstyles__Option"]');
          let size = sizeEl?.textContent?.trim() || null;

          if (!size) {
            const detailsEl = el.querySelector('[class*="full-card__Details"]');
            const detailsText = detailsEl?.textContent?.trim();
            const sizeMatch = detailsText?.match(/[\d.]+\s*(g|oz|mg|ml)/i);
            size = sizeMatch ? sizeMatch[0] : null;
          }

          const linkEl = el.querySelector('a[href*="/product/"], [class*="full-card__Anchor"]');
          const url = linkEl?.href;

          results.push({
            name,
            brand: brand || null,
            price: isNaN(price) ? null : price,
            category: category || null,
            size: size || null,
            url: url || null,
            raw: {
              html: el.innerHTML.substring(0, 500)
            }
          });
        } catch (e) {
          console.error('Error parsing product:', e);
        }
      });

      return results;
    });
  }

  /**
   * Filter products to only include Ace Solventless products
   */
  filterProducts(products) {
    if (!this.brandFilter) {
      return products;
    }

    return products.filter(product => {
      const brand = (product.brand || '').toLowerCase();

      if (brand.includes('ace solventless') || brand === 'ace') {
        return true;
      }

      const acePattern = /\bace\b/i;
      if (acePattern.test(brand)) {
        return true;
      }

      const name = (product.name || '').toLowerCase();
      if (name.includes('ace solventless')) {
        return true;
      }

      return false;
    });
  }

  /**
   * Main scrape method for Dutchie dispensaries
   */
  async scrape(dispensary) {
    // Add Ace filters to URL if brand filter is enabled
    const menuUrl = this.brandFilter ? this.addAceFilters(dispensary.menu_url) : dispensary.menu_url;
    console.log(`  📡 Loading: ${menuUrl}`);

    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      await page.goto(menuUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.timeout
      });

      await this.wait(3000);
      await this.handleAgeGate(page);

      const pageTitle = await page.title();
      const currentUrl = page.url();
      console.log(`  📄 Page title: ${pageTitle}`);
      console.log(`  🔗 Current URL: ${currentUrl}`);

      // Find Dutchie iframe
      let targetFrame = page;
      const dutchieFrame = await this.findDutchieFrame(page);
      if (dutchieFrame) {
        targetFrame = dutchieFrame;
        console.log('  ✅ Switched to iframe context');
        await this.waitForIframeContent(targetFrame);
      }

      // Wait for products to load
      await targetFrame.waitForSelector(
        '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"]',
        { timeout: 45000 }
      ).catch(() => {
        console.log('  ⚠️ No product cards found with primary selectors');
      });

      await this.wait(2000);

      // Extract products
      const products = await this.extractProducts(targetFrame);
      console.log(`  📦 Found ${products.length} products (unfiltered)`);

      // Filter products
      const filteredProducts = this.filterProducts(products);
      console.log(`  🎯 ${filteredProducts.length} products after filtering`);

      return filteredProducts;

    } finally {
      await browser.close();
    }
  }
}

module.exports = DutchieScraper;
