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
    // Rediscover mode - ignore saved configs, try all formats
    this.rediscover = options.rediscover || false;
  }

  /**
   * Generate multiple URL formats to try for Ace filtering
   * Returns array of URLs to try in order
   */
  getFilteredUrls(baseUrl) {
    const urls = [];
    const urlObj = new URL(baseUrl);
    const basePathname = urlObj.pathname.replace(/\/$/, '');

    // Format 1: iframe dtche[path]=brands/ace (most reliable for iframe embeds)
    const iframeBrandUrl = new URL(baseUrl);
    iframeBrandUrl.searchParams.set('dtche[path]', 'brands/ace');
    urls.push({ url: iframeBrandUrl.toString(), type: 'iframe-brand' });

    // Format 2: iframe dtche[path]=brands/ace-solventless
    const iframeBrandUrl2 = new URL(baseUrl);
    iframeBrandUrl2.searchParams.set('dtche[path]', 'brands/ace-solventless');
    urls.push({ url: iframeBrandUrl2.toString(), type: 'iframe-brand-full' });

    // Format 3: Standard iframe dtche[] params with search
    const iframeUrl = new URL(baseUrl);
    iframeUrl.searchParams.set('dtche[path]', 'products');
    iframeUrl.searchParams.set('dtche[search]', 'ace');
    urls.push({ url: iframeUrl.toString(), type: 'iframe-search' });

    // Format 4: Dutchie Plus with search=ace
    const plusUrl1 = new URL(baseUrl);
    plusUrl1.pathname = basePathname + '/products';
    plusUrl1.search = '';
    plusUrl1.searchParams.set('search', 'ace');
    urls.push({ url: plusUrl1.toString(), type: 'plus-search' });

    // Format 5: Dutchie Plus with brands=ace
    const plusUrl2 = new URL(baseUrl);
    plusUrl2.pathname = basePathname + '/products';
    plusUrl2.search = '';
    plusUrl2.searchParams.set('brands', 'ace');
    urls.push({ url: plusUrl2.toString(), type: 'plus-brands-ace' });

    // Format 6: Dutchie Plus with brands=ace-solventless
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
    let pathname = urlObj.pathname;

    // If URL already has /brands/xxx, it's a valid product listing - keep it as is
    if (pathname.includes('/brands/')) {
      // Just add the query param for extra filtering
      urlObj.searchParams.set('brands', 'ace-solventless');
      return urlObj.toString();
    }

    // Otherwise, ensure we're on the products page with brand filter
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

    // Check all frames by URL (skip main frame)
    const frames = page.frames();
    const mainFrameUrl = page.url();
    console.log(`  🔍 Found ${frames.length} frames total`);
    for (const frame of frames) {
      const url = frame.url();
      // Skip the main frame - we want actual iframes
      if (url === mainFrameUrl) continue;
      // Check for Dutchie-related URLs (must be dutchie.com domain, not just dtche param)
      if (url.includes('dutchie.com') || url.includes('embedded-menu')) {
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
    await this.wait(3000);
  }

  /**
   * Clean up extracted product name - remove concatenated garbage
   */
  cleanProductName(name) {
    if (!name) return name;

    let cleaned = name
      // Remove price patterns ($XX.XX)
      .replace(/\$[\d.]+/g, '')
      // Remove "Add X to cart" patterns
      .replace(/Add\s+[\d.]+\s*(g|mg|oz|ml)?\s*to\s*cart/gi, '')
      .replace(/Add\s+to\s*cart/gi, '')
      // Remove strain type info and everything after (often concatenated garbage follows)
      // Match: space/dash + Indica/Sativa/Hybrid + optional dash + optional second type + optional garbage
      .replace(/[\s\-–—]+(Indica|Sativa|Hybrid)([\-–—]*(Indica|Sativa|Hybrid))?([A-Z].*)?$/gi, '')
      // Also handle when it appears mid-string followed by known patterns
      .replace(/\s+(Indica|Sativa|Hybrid)([\-–—]*(Indica|Sativa|Hybrid))?\s*(THC|CBD|$)/gi, ' $4')
      // Remove THC/CBD info (often concatenated at end)
      .replace(/\s*THC:?\s*[\d.]+%?/gi, '')
      .replace(/\s*CBD:?\s*[\d.]+%?/gi, '')
      // Clean up separators and whitespace
      .replace(/\s*[|–—]\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned;
  }

  /**
   * Clean up extracted size - extract only the size portion
   */
  cleanSize(size) {
    if (!size) return size;

    // Extract just the size pattern (first match)
    const sizeMatch = size.match(/(\.?\d+\.?\d*)\s*(g|mg|oz|ml)/i);
    if (sizeMatch) {
      return sizeMatch[0];
    }
    return null;
  }

  /**
   * Extract products from the page/frame
   */
  async extractProducts(targetFrame) {
    const rawProducts = await targetFrame.evaluate(() => {
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
          // Helper to get only direct text content (not nested elements)
          const getDirectText = (element) => {
            if (!element) return null;
            // Get only the first text node or the h2/h3 inside
            const heading = element.querySelector('h2, h3, h4, h5');
            if (heading) return heading.textContent?.trim();
            // Otherwise get text but stop at first element boundary
            let text = '';
            for (const node of element.childNodes) {
              if (node.nodeType === 3) { // Text node
                text += node.textContent;
              } else if (node.nodeType === 1 && !text.trim()) {
                // First element child, get its text
                text = node.textContent || '';
                break;
              }
            }
            return text.trim() || element.textContent?.trim();
          };

          // Try multiple name selectors (including Dutchie Plus styled-components)
          let nameEl = el.querySelector(
            '[class*="card__Name"], [class*="full-card__Name"], [class*="ProductName"], [data-testid="product-name"], h3, h4, [class*="product-name"], [class*="productName"]'
          );

          // For link-based cards, get the text content more aggressively
          let name = getDirectText(nameEl);
          if (!name && el.tagName === 'A') {
            // Find any heading or strong text in the link
            nameEl = el.querySelector('h1, h2, h3, h4, h5, strong, [class*="name"], [class*="Name"], [class*="title"], [class*="Title"]');
            name = getDirectText(nameEl);
          }

          if (!name) return;

          // Try multiple brand selectors (including Dutchie Plus styled-components)
          let brandEl = el.querySelector(
            '[class*="card__Brand"], [class*="full-card__Brand"], [class*="ProductBrand"], [data-testid="product-brand"]'
          );
          let brand = getDirectText(brandEl) || null;

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
          const category = getDirectText(categoryEl);

          // Size - look for option/weight selectors first, then extract from name
          const sizeEl = el.querySelector('[class*="optionstyles__Option"], [class*="Weight"], [class*="weight"]');
          let size = null;
          if (sizeEl) {
            size = sizeEl.textContent || '';
          }

          // If no size found, extract from the product name
          if (!size && name) {
            const sizeMatch = name.match(/[\d.]+\s*(g|oz|mg|ml)/i);
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

    // Post-process to clean up extracted data
    return rawProducts.map(product => {
      // Extract THC/CBD before cleaning name
      const thcMatch = product.name?.match(/THC:?\s*([\d.]+)%?/i);
      const cbdMatch = product.name?.match(/CBD:?\s*([\d.]+)%?/i);
      const thc = thcMatch ? parseFloat(thcMatch[1]) : null;
      const cbd = cbdMatch ? parseFloat(cbdMatch[1]) : null;

      return {
        ...product,
        name: this.cleanProductName(product.name),
        size: this.cleanSize(product.size),
        raw: {
          ...product.raw,
          thc,
          cbd
        }
      };
    });
  }

  /**
   * Filter products to only include Ace Solventless products
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

      // Must have "ace" or "jackpot" (Ace sub-brand) in brand as whole word
      if (!aceRegex.test(brand) && !jackpotRegex.test(brand)) {
        return false;
      }

      // Ace only makes SOLVENTLESS - exclude distillate products
      if (name.toLowerCase().includes('distillate')) {
        return false;
      }

      return true;
    });
  }

  /**
   * Try scraping with a specific URL
   */
  async tryScrapeUrl(page, url) {
    await this.navigateWithRetry(page, url, {
      waitUntil: 'networkidle2'
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
          await this.navigateWithRetry(page, directUrl, { waitUntil: 'networkidle2' });
          await this.wait(5000); // Wait for direct Dutchie to load
          targetFrame = page;
        }
      }
    }

    // Wait for products with multiple selector options
    await targetFrame.waitForSelector(
      '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
      { timeout: 20000 }
    ).catch(() => {});

    await this.wait(2000);

    const products = await this.extractProducts(targetFrame);
    return this.filterProducts(products);
  }

  /**
   * Build URL for a specific format type
   */
  buildUrlForFormat(baseUrl, formatType) {
    const urlObj = new URL(baseUrl);
    const basePathname = urlObj.pathname.replace(/\/$/, '');

    switch (formatType) {
      case 'iframe-brand':
        urlObj.searchParams.set('dtche[path]', 'brands/ace');
        return urlObj.toString();
      case 'iframe-brand-full':
        urlObj.searchParams.set('dtche[path]', 'brands/ace-solventless');
        return urlObj.toString();
      case 'iframe-search':
        urlObj.searchParams.set('dtche[path]', 'products');
        urlObj.searchParams.set('dtche[search]', 'ace');
        return urlObj.toString();
      case 'plus-search':
        urlObj.pathname = basePathname + '/products';
        urlObj.search = '';
        urlObj.searchParams.set('search', 'ace');
        return urlObj.toString();
      case 'plus-brands-ace':
        urlObj.pathname = basePathname + '/products';
        urlObj.search = '';
        urlObj.searchParams.set('brands', 'ace');
        return urlObj.toString();
      case 'plus-brands-solventless':
        urlObj.pathname = basePathname + '/products';
        urlObj.search = '';
        urlObj.searchParams.set('brands', 'ace-solventless');
        return urlObj.toString();
      default:
        return baseUrl;
    }
  }

  /**
   * Main scrape method for Dutchie dispensaries
   * Uses saved config if available, otherwise tries formats and saves what works
   * Returns { products, detectedFormat } - detectedFormat can be used to update platform
   */
  async scrape(dispensary) {
    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // If no brand filter, just scrape normally
      if (!this.brandFilter) {
        const url = dispensary.menu_url;
        await this.navigateWithRetry(page, url, { waitUntil: 'networkidle2' });
        await this.wait(3000);
        await this.handleAgeGate(page);
        await this.wait(2000);
        const products = await this.extractProducts(page);
        return { products, detectedFormat: null };
      }

      // Check for saved config - use it directly if available (unless rediscover mode)
      const savedConfig = dispensary.scrape_config;
      if (this.rediscover && savedConfig?.url_format) {
        console.log(`  🔄 Rediscover mode - ignoring saved config: ${savedConfig.url_format}`);
      }
      if (savedConfig?.url_format && !this.rediscover) {
        console.log(`  ⚡ Using saved config: ${savedConfig.url_format}`);
        const url = this.buildUrlForFormat(dispensary.menu_url, savedConfig.url_format);

        try {
          const products = await this.tryScrapeUrl(page, url);
          if (products.length > 0) {
            console.log(`  ✅ Found ${products.length} Ace products with saved config`);
            return { products, detectedFormat: savedConfig.url_format, configWorked: true };
          }
          // Trust saved config - format worked, just no products
          console.log(`  ℹ️ Saved config worked, no Ace products at this location`);
          return { products: [], detectedFormat: savedConfig.url_format, configWorked: true };
        } catch (e) {
          // If navigation timed out, don't try other formats - site is down
          if (e.message?.includes('Navigation timeout')) {
            console.log(`  ❌ Site unreachable (timeout), skipping other formats`);
            throw e;
          }
          console.log(`  ⚠️ Saved config failed: ${e.message}, trying all formats...`);
        }
      }

      // Get URL formats to try
      let urlFormats = this.getFilteredUrls(dispensary.menu_url);

      // If plus mode, only try plus formats (skip iframe)
      if (this.plusMode) {
        console.log(`  ⚡ Plus mode - skipping iframe detection`);
        urlFormats = urlFormats.filter(f => f.type.startsWith('plus-'));
      }

      // Track first format that successfully loads (even with 0 products)
      let firstWorkingFormat = null;

      for (const { url, type } of urlFormats) {
        console.log(`  📡 Trying ${type}: ${url}`);

        try {
          const products = await this.tryScrapeUrl(page, url);

          // Track first format that works (loads without error)
          if (!firstWorkingFormat) {
            firstWorkingFormat = type;
          }

          if (products.length > 0) {
            console.log(`  ✅ Found ${products.length} Ace products with ${type} format`);
            return { products, detectedFormat: type, configWorked: false };
          }
          console.log(`  ⚠️ No Ace products with ${type}, trying next format...`);
        } catch (e) {
          // If navigation timed out, don't try other formats - site is down
          if (e.message?.includes('Navigation timeout')) {
            console.log(`  ❌ Site unreachable (timeout), skipping other formats`);
            throw e;
          }
          console.log(`  ⚠️ ${type} failed: ${e.message}, trying next...`);
        }
      }

      // No products found, but save first working format so we don't retry all formats next time
      if (firstWorkingFormat) {
        console.log(`  ℹ️ No Ace products found, but saving working format: ${firstWorkingFormat}`);
        return { products: [], detectedFormat: firstWorkingFormat, configWorked: false };
      }

      // All formats failed
      console.log(`  ❌ All URL formats failed`);
      return { products: [], detectedFormat: null };

    } finally {
      await browser.close();
    }
  }
}

module.exports = DutchieScraper;
