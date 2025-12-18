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
          // Check for React content in __next
          if (nextDiv && nextDiv.children.length > 0) return true;
          // Check for Flutter content (canvas) in render-target
          if (renderTarget && renderTarget.children.length > 0) return true;
          // Check for Flutter canvas directly
          if (document.querySelector('flt-glass-pane')) return true;
          if (document.querySelector('canvas')) return true;
          return false;
        },
        { timeout: 20000 }
      );
      console.log('  ✅ Iframe content rendered');
    } catch (e) {
      console.log('  ⚠️ Iframe render wait timed out, continuing...');
    }
    // Extra wait for dynamic content to fully load
    await this.wait(5000);
  }

  /**
   * Extract products from the page/frame
   */
  async extractProducts(targetFrame) {
    return targetFrame.evaluate(() => {
      const results = [];

      // Selectors for both iframe embeds and Dutchie Plus direct render
      const selectors = [
        '[data-testid="product-list-item"]',
        '[data-testid="product-card"]',
        '[class*="full-card__Wrapper"]',
        '[data-testid="product-card-container"]',
        '[class*="ProductCard"]',
        '[class*="product-card"]',
        'a[href*="/product/"]'
      ];

      let productElements = [];
      for (const selector of selectors) {
        productElements = document.querySelectorAll(selector);
        if (productElements.length > 0) {
          console.log('Found products with selector:', selector);
          break;
        }
      }

      // If still no products, try finding by structure (cards with images and prices)
      if (productElements.length === 0) {
        // Look for any container that has an image and a price
        const allLinks = document.querySelectorAll('a[href*="/product"]');
        if (allLinks.length > 0) {
          productElements = allLinks;
        }
      }

      productElements.forEach(el => {
        try {
          // Try multiple name selectors
          let nameEl = el.querySelector(
            '[class*="full-card__Name"], [class*="ProductName"], [data-testid="product-name"], h3, h4, [class*="product-name"], [class*="productName"]'
          );

          // For link-based cards, get the text content more aggressively
          let name = nameEl?.textContent?.trim();
          if (!name && el.tagName === 'A') {
            // Find any heading or strong text in the link
            nameEl = el.querySelector('h1, h2, h3, h4, h5, strong, [class*="name"], [class*="Name"], [class*="title"], [class*="Title"]');
            name = nameEl?.textContent?.trim();
          }

          if (!name) return;

          // Try multiple brand selectors - only trust actual brand elements
          let brandEl = el.querySelector(
            '[class*="full-card__Brand"], [class*="ProductBrand"], [data-testid="product-brand"]'
          );
          let brand = brandEl?.textContent?.trim() || null;

          const priceEl = el.querySelector(
            '[class*="full-card__Details"], [class*="Price"], [data-testid="product-price"], [class*="price"]'
          );
          const priceText = priceEl?.textContent?.trim() || el.textContent;
          const priceMatch = priceText?.match(/\$[\d.]+/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace('$', '')) : null;

          const categoryEl = el.querySelector(
            '[class*="category"], [data-testid="product-category"], [class*="Category"]'
          );
          const category = categoryEl?.textContent?.trim();

          const sizeEl = el.querySelector('[class*="optionstyles__Option"], [class*="size"], [class*="Size"]');
          let size = sizeEl?.textContent?.trim() || null;

          if (!size) {
            const fullText = el.textContent || '';
            const sizeMatch = fullText.match(/[\d.]+\s*(g|oz|mg|ml)/i);
            size = sizeMatch ? sizeMatch[0] : null;
          }

          // Get URL from the element itself if it's a link, or find a link inside
          let url = el.href;
          if (!url) {
            const linkEl = el.querySelector('a[href*="/product/"], [class*="full-card__Anchor"], a');
            url = linkEl?.href;
          }

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

      // Simple: only include if brand contains "ace"
      return brand.includes('ace');
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

      // Wait for JavaScript to start rendering
      await this.wait(5000);
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

      // Debug: Get page content for analysis
      const bodyHTML = await targetFrame.evaluate(() => document.body.innerHTML.substring(0, 2000));
      console.log(`  📝 Page preview: ${bodyHTML.substring(0, 500)}...`);

      // Wait for products to load - try multiple selectors
      await targetFrame.waitForSelector(
        '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
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
