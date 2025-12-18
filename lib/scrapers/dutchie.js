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
   * Detect if this is a Dutchie Plus site (direct render) vs iframe embed
   */
  isDutchiePlus(url) {
    const plusDomains = [
      'mhwdispensaries.com',
      // Add other Dutchie Plus domains here as discovered
    ];
    const hostname = new URL(url).hostname;
    return plusDomains.some(d => hostname.includes(d));
  }

  /**
   * Add brand filter parameters to Dutchie URL
   * Handles both iframe embed and Dutchie Plus URL formats
   */
  addAceFilters(url) {
    const urlObj = new URL(url);

    if (this.isDutchiePlus(url)) {
      // Dutchie Plus uses path-based filtering: /products/sortby=relevance?brands=ace
      let pathname = urlObj.pathname;

      // Ensure we're on the products page
      if (!pathname.includes('/products')) {
        pathname = pathname.replace(/\/$/, '') + '/products/sortby=relevance';
      }

      urlObj.pathname = pathname;
      urlObj.searchParams.set('brands', 'ace');

      return urlObj.toString();
    }

    // Standard iframe Dutchie uses query params
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
      const { frame: dutchieFrame, iframeSrc } = await this.findDutchieFrame(page);

      if (dutchieFrame) {
        targetFrame = dutchieFrame;
        console.log('  ✅ Switched to iframe context');
        await this.waitForIframeContent(targetFrame);

        // Check if iframe content is empty - if so, load Dutchie URL directly
        if (await this.isIframeEmpty(targetFrame)) {
          console.log('  ⚠️ Iframe content empty, loading Dutchie URL directly...');

          if (iframeSrc && iframeSrc.includes('dutchie.com')) {
            // Build filtered URL from iframe src
            const directUrl = this.addAceFiltersToDirectUrl(iframeSrc);
            console.log(`  📡 Direct load: ${directUrl}`);

            await page.goto(directUrl, {
              waitUntil: 'networkidle2',
              timeout: this.options.timeout
            });
            await this.wait(5000);
            targetFrame = page; // Now scraping the main page, not iframe
          }
        }
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
