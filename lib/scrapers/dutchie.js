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
    // Plus mode - skip iframe attempts, go straight to plus URL format
    this.plusMode = options.plusMode || false;
  }

  /**
   * Generate multiple URL formats to try for Ace filtering
   * Returns array of URLs to try in order
   * Order: plus-search (broadest) -> iframe -> plus-brands variations
   */
  getFilteredUrls(baseUrl) {
    const urls = [];
    const urlObj = new URL(baseUrl);
    const basePathname = urlObj.pathname.replace(/\/$/, '');

    // Format 1: Dutchie Plus with search=ace (broadest, gets most results)
    const plusUrl1 = new URL(baseUrl);
    plusUrl1.pathname = basePathname + '/products';
    plusUrl1.search = '';
    plusUrl1.searchParams.set('search', 'ace');
    urls.push({ url: plusUrl1.toString(), type: 'plus-search' });

    // Format 2: Standard iframe dtche[] params with search
    const iframeUrl = new URL(baseUrl);
    iframeUrl.searchParams.set('dtche[path]', 'products');
    iframeUrl.searchParams.set('dtche[search]', 'ace');
    urls.push({ url: iframeUrl.toString(), type: 'iframe' });

    // Format 3: Dutchie Plus with brands=ace (some dispensaries use just "ACE")
    const plusUrl2 = new URL(baseUrl);
    plusUrl2.pathname = basePathname + '/products';
    plusUrl2.search = '';
    plusUrl2.searchParams.set('brands', 'ace');
    urls.push({ url: plusUrl2.toString(), type: 'plus-brands-ace' });

    // Format 4: Dutchie Plus with brands=ace-solventless
    const plusUrl3 = new URL(baseUrl);
    plusUrl3.pathname = basePathname + '/products';
    plusUrl3.search = '';
    plusUrl3.searchParams.set('brands', 'ace-solventless');
    urls.push({ url: plusUrl3.toString(), type: 'plus-brands-solventless' });

    return urls;
  }

  /**
   * Add filters to direct Dutchie URL (dutchie.com/embedded-menu/...)
   */
  addAceFiltersToDirectUrl(url) {
    const urlObj = new URL(url);

    // Ensure we're on the products page with brand filter
    let pathname = urlObj.pathname;
    if (!pathname.includes('/products')) {
      pathname = pathname.replace(/\/$/, '') + '/products';
    }
    urlObj.pathname = pathname;
    urlObj.searchParams.set('brands', 'ace-solventless');

    return urlObj.toString();
  }

  /**
   * Find and switch to Dutchie iframe if present
   * Returns { frame, directUrl } - directUrl is set if iframe content is empty
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

        // Get the iframe src URL for potential direct loading
        const iframeSrc = await iframeElement.evaluate(el => el.src);

        const frame = await iframeElement.contentFrame();
        if (frame) {
          return { frame, iframeSrc };
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
        return { frame, iframeSrc: url };
      }
    }

    return { frame: null, iframeSrc: null };
  }

  /**
   * Check if iframe content is empty and needs direct loading
   */
  async isIframeEmpty(frame) {
    try {
      const isEmpty = await frame.evaluate(() => {
        const nextDiv = document.getElementById('__next');
        const renderTarget = document.getElementById('render-target');
        const hasContent = (nextDiv && nextDiv.innerHTML.length > 100) ||
                          (renderTarget && renderTarget.innerHTML.length > 100);
        return !hasContent;
      });
      return isEmpty;
    } catch (e) {
      return true;
    }
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
        '[class*="card__Wrapper"]',
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
          // Try multiple name selectors (including Dutchie Plus styled-components)
          let nameEl = el.querySelector(
            '[class*="card__Name"], [class*="full-card__Name"], [class*="ProductName"], [data-testid="product-name"], h3, h4, [class*="product-name"], [class*="productName"]'
          );

          // For link-based cards, get the text content more aggressively
          let name = nameEl?.textContent?.trim();
          if (!name && el.tagName === 'A') {
            // Find any heading or strong text in the link
            nameEl = el.querySelector('h1, h2, h3, h4, h5, strong, [class*="name"], [class*="Name"], [class*="title"], [class*="Title"]');
            name = nameEl?.textContent?.trim();
          }

          if (!name) return;

          // Try multiple brand selectors (including Dutchie Plus styled-components)
          let brandEl = el.querySelector(
            '[class*="card__Brand"], [class*="full-card__Brand"], [class*="ProductBrand"], [data-testid="product-brand"]'
          );
          let brand = brandEl?.textContent?.trim() || null;

          // Price selectors (including Dutchie Plus)
          const priceEl = el.querySelector(
            '[class*="card__Price"], [class*="full-card__Details"], [class*="Price"], [data-testid="product-price"], [class*="price"]'
          );
          const priceText = priceEl?.textContent?.trim() || el.textContent;
          const priceMatch = priceText?.match(/\$[\d.]+/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace('$', '')) : null;

          // Category/strain selectors (including Dutchie Plus)
          const categoryEl = el.querySelector(
            '[class*="card__Strain"], [class*="category"], [data-testid="product-category"], [class*="Category"], [class*="Strain"]'
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
      const name = (product.name || '').toLowerCase();

      // Must have "ace" in brand
      if (!brand.includes('ace')) {
        return false;
      }

      // Ace only makes SOLVENTLESS - exclude distillate products
      if (name.includes('distillate')) {
        return false;
      }

      return true;
    });
  }

  /**
   * Try scraping with a specific URL
   */
  async tryScrapeUrl(page, url) {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: this.options.timeout
    });

    await this.wait(3000);
    await this.handleAgeGate(page);

    let targetFrame = page;
    const { frame: dutchieFrame, iframeSrc } = await this.findDutchieFrame(page);

    if (dutchieFrame) {
      targetFrame = dutchieFrame;
      await this.waitForIframeContent(targetFrame);

      // Check if iframe content is empty - if so, load Dutchie URL directly
      if (await this.isIframeEmpty(targetFrame)) {
        if (iframeSrc && iframeSrc.includes('dutchie.com')) {
          const directUrl = this.addAceFiltersToDirectUrl(iframeSrc);
          console.log(`  ⚠️ Iframe empty, trying direct: ${directUrl}`);
          await page.goto(directUrl, { waitUntil: 'networkidle2', timeout: this.options.timeout });
          await this.wait(3000);
          targetFrame = page;
        }
      }
    }

    // Wait for products
    await targetFrame.waitForSelector(
      '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
      { timeout: 15000 }
    ).catch(() => {});

    await this.wait(1000);

    const products = await this.extractProducts(targetFrame);
    return this.filterProducts(products);
  }

  /**
   * Main scrape method for Dutchie dispensaries
   * Tries multiple URL formats until one returns Ace products
   * Returns { products, detectedFormat } - detectedFormat can be used to update platform
   */
  async scrape(dispensary) {
    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // If no brand filter, just scrape normally
      if (!this.brandFilter) {
        const url = dispensary.menu_url;
        console.log(`  📡 Loading: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: this.options.timeout });
        await this.wait(3000);
        await this.handleAgeGate(page);
        await this.wait(2000);
        const products = await this.extractProducts(page);
        return { products, detectedFormat: null };
      }

      // Get URL formats to try
      let urlFormats = this.getFilteredUrls(dispensary.menu_url);

      // If plus mode, only try plus formats (skip iframe)
      if (this.plusMode) {
        console.log(`  ⚡ Plus mode - skipping iframe detection`);
        urlFormats = urlFormats.filter(f => f.type.startsWith('plus-'));
      }

      for (const { url, type } of urlFormats) {
        console.log(`  📡 Trying ${type}: ${url}`);

        try {
          const products = await this.tryScrapeUrl(page, url);

          if (products.length > 0) {
            console.log(`  ✅ Found ${products.length} Ace products with ${type} format`);
            return { products, detectedFormat: type };
          }
          console.log(`  ⚠️ No Ace products with ${type}, trying next format...`);
        } catch (e) {
          console.log(`  ⚠️ ${type} failed: ${e.message}, trying next...`);
        }
      }

      // All formats tried, return empty
      console.log(`  ❌ No Ace products found with any URL format`);
      return { products: [], detectedFormat: null };

    } finally {
      await browser.close();
    }
  }
}

module.exports = DutchieScraper;
