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
    // Max formats to try during discovery (0 = unlimited)
    this.maxFormats = options.maxFormats || 0;
  }

  /**
   * Generate multiple URL formats to try for Ace filtering
   * Returns array of URLs to try in order
   */
  getFilteredUrls(baseUrl) {
    const urls = [];
    const urlObj = new URL(baseUrl);
    const basePathname = urlObj.pathname.replace(/\/$/, '');

    // If the menu_url already has brand/filter params, try it as-is first
    // This respects URLs entered via the web UI with specific filters
    const existingDtchePath = urlObj.searchParams.get('dtche[path]');
    const existingSearch = urlObj.searchParams.get('dtche[search]') || urlObj.searchParams.get('search');
    const existingBrands = urlObj.searchParams.get('brands');
    const pathHasBrand = /\/brands\//.test(urlObj.pathname);
    if (existingDtchePath?.includes('brands/') || existingSearch || existingBrands || pathHasBrand) {
      urls.push({ url: baseUrl, type: 'original-filtered' });
    }

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

    // Format 7: Dutchie Plus with /brands/ace in path
    const plusUrl4 = new URL(baseUrl);
    plusUrl4.pathname = basePathname + '/brands/ace';
    plusUrl4.search = '';
    urls.push({ url: plusUrl4.toString(), type: 'plus-brand-path' });

    // Format 8: Dutchie Plus with /brands/ace-solventless in path
    const plusUrl5 = new URL(baseUrl);
    plusUrl5.pathname = basePathname + '/brands/ace-solventless';
    plusUrl5.search = '';
    urls.push({ url: plusUrl5.toString(), type: 'plus-brand-path-full' });

    return urls;
  }

  /**
   * Extract store slug from Dutchie embedded menu URL
   * e.g. https://dutchie.com/embedded-menu/sunrise-st-louis/brands/ace -> sunrise-st-louis
   */
  extractStoreSlug(url) {
    if (!url) return null;
    const match = url.match(/embedded-menu\/([^/]+)/);
    return match ? match[1] : null;
  }

  /**
   * Build direct Dutchie URL from store slug
   */
  buildDirectUrl(storeSlug, brandSlug = 'ace-solventless') {
    return `https://dutchie.com/embedded-menu/${storeSlug}/brands/${brandSlug}?brands=${brandSlug}`;
  }

  /**
   * Add filters to direct Dutchie URL (dutchie.com/embedded-menu/...)
   * @param {string} url - The iframe src URL
   * @param {string} brandSlug - Brand slug to use ('ace' or 'ace-solventless'), defaults to 'ace-solventless'
   */
  addAceFiltersToDirectUrl(url, brandSlug = 'ace-solventless') {
    const urlObj = new URL(url);
    let pathname = urlObj.pathname;

    // Handle carousel URLs - strip carousel path and go to brands page
    // e.g. /embedded-menu/store-name/carousels/abc123/products -> /embedded-menu/store-name/brands/ace-solventless
    if (pathname.includes('/carousels/')) {
      const match = pathname.match(/^(\/embedded-menu\/[^/]+)\//);
      if (match) {
        pathname = match[1] + '/brands/' + brandSlug;
        urlObj.pathname = pathname;
        urlObj.search = ''; // Clear carousel params
        urlObj.searchParams.set('brands', brandSlug);
        return urlObj.toString();
      }
    }

    // If URL already has /brands/xxx, it's a valid product listing - keep it as is
    if (pathname.includes('/brands/')) {
      // Just add the query param for extra filtering
      urlObj.searchParams.set('brands', brandSlug);
      return urlObj.toString();
    }

    // Otherwise, ensure we're on the products page with brand filter
    if (!pathname.includes('/products')) {
      pathname = pathname.replace(/\/$/, '') + '/products';
    }
    urlObj.pathname = pathname;
    urlObj.searchParams.set('brands', brandSlug);

    return urlObj.toString();
  }

  /**
   * Wait for any Dutchie iframe element to appear in the DOM
   * Returns true if found, false if timeout
   * Note: We exclude terpli.io iframes which may contain dtche in query params
   */
  async waitForIframeElement(page, timeout = 15000) {
    // Use only reliable selectors - avoid dtche which matches Terpli overlay iframes
    const combinedSelector = [
      'iframe[src*="dutchie.com"]',
      'iframe[src*="embedded-menu"]',
      'iframe[id*="dutchie"]',
      'iframe[class*="dutchie"]'
    ].join(', ');

    console.log('  ⏳ Waiting for Dutchie iframe to appear...');

    try {
      await page.waitForSelector(combinedSelector, { timeout });
      // Verify it's not a Terpli iframe
      const isTerpli = await page.evaluate((selector) => {
        const iframe = document.querySelector(selector);
        return iframe?.src?.includes('terpli.io');
      }, combinedSelector);

      if (isTerpli) {
        console.log('  ⚠️ Found Terpli overlay, not Dutchie iframe');
        return false;
      }

      console.log('  ✅ Iframe element detected');
      return true;
    } catch (e) {
      console.log('  ℹ️ No iframe detected (may be Dutchie Plus)');
      return false;
    }
  }

  /**
   * Find and switch to Dutchie iframe if present
   * Returns { frame, directUrl } - directUrl is set if iframe content is empty
   * Note: Excludes Terpli overlay iframes
   */
  async findDutchieFrame(page) {
    // Use only reliable selectors - avoid dtche which matches Terpli overlay iframes
    const iframeSelectors = [
      'iframe[src*="dutchie.com"]',
      'iframe[src*="embedded-menu"]',
      'iframe[id*="dutchie"]',
      'iframe[class*="dutchie"]'
    ];

    // Try specific selectors first
    for (const selector of iframeSelectors) {
      const iframeElement = await page.$(selector);
      if (iframeElement) {
        // Get the iframe src URL for potential direct loading
        const iframeSrc = await iframeElement.evaluate(el => el.src);

        // Skip Terpli overlay iframes
        if (iframeSrc && iframeSrc.includes('terpli.io')) {
          console.log(`  ⚠️ Skipping Terpli overlay iframe`);
          continue;
        }

        console.log(`  🖼️ Found Dutchie iframe: ${selector}`);

        const frame = await iframeElement.contentFrame();
        if (frame) {
          return { frame, iframeSrc };
        }
      }
    }

    // Check all frames by URL (skip main frame and Terpli)
    const frames = page.frames();
    const mainFrameUrl = page.url();
    console.log(`  🔍 Found ${frames.length} frames total`);
    for (const frame of frames) {
      const url = frame.url();
      // Skip the main frame - we want actual iframes
      if (url === mainFrameUrl) continue;
      // Skip Terpli overlay frames
      if (url.includes('terpli.io')) continue;
      // Check for Dutchie-related URLs (must be dutchie.com domain, not just dtche param)
      if (url.includes('dutchie.com') || url.includes('embedded-menu')) {
        console.log(`  🖼️ Found Dutchie frame by URL: ${url}`);
        return { frame, iframeSrc: url };
      }
    }

    // DEBUG: Log all iframe elements when detection fails
    const allIframes = await page.$$eval('iframe', iframes =>
      iframes.map(f => ({ src: f.src?.substring(0, 80) || '(empty)', id: f.id }))
    );
    if (allIframes.length > 0) {
      console.log(`  🔍 Iframes on page:`, allIframes.map(f => f.src));
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
        { timeout: 30000 }
      );
      console.log('  ✅ Iframe content rendered');
    } catch (e) {
      console.log('  ⚠️ Iframe render wait timed out, continuing...');
    }
    // Extra wait for dynamic content to fully load
    await this.wait(3000);
  }

  /**
   * Handle age gates inside the iframe context (not just main page)
   */
  async handleIframeAgeGate(frame) {
    try {
      const hasAgeGate = await frame.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('are you 21') || text.includes('verify your age');
      });

      if (hasAgeGate) {
        console.log('  🚪 Age gate inside iframe, bypassing...');
        await frame.evaluate(() => {
          const buttons = document.querySelectorAll('button, a');
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase();
            if (text === 'yes' || text.includes('21') || text.includes('enter')) {
              btn.click();
              return;
            }
          }
        });
        await this.wait(2000);
      }
    } catch (e) {
      console.log('  ⚠️ Iframe age gate error:', e.message);
    }
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
            '[class*="card__Name"], [class*="full-card__Name"], [class*="card-view__Name"], [class*="ProductName"], [data-testid="product-name"], h3, h4, [class*="product-name"], [class*="productName"]'
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
            '[class*="card__Brand"], [class*="full-card__Brand"], [class*="card-view__Brand"], [class*="ProductBrand"], [data-testid="product-brand"]'
          );
          let brand = getDirectText(brandEl) || null;

          // Price selectors (including Dutchie Plus)
          const priceEl = el.querySelector(
            '[class*="card__Price"], [class*="full-card__Details"], [class*="card-view__Details"], [class*="Price"], [data-testid="product-price"], [class*="price"]'
          );
          const priceText = priceEl?.textContent?.trim() || el.textContent;
          const priceMatch = priceText?.match(/\$[\d.]+/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace('$', '')) : null;

          // Category/strain selectors (including Dutchie Plus)
          const categoryEl = el.querySelector(
            '[class*="card__Strain"], [class*="card-view__Strain"], [class*="category"], [data-testid="product-category"], [class*="Category"], [class*="Strain"]'
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
   * Set up interceptor to capture product data (with prices) from Dutchie's GraphQL API
   * Must be called BEFORE navigating to the page
   */
  setupApiInterceptor(page) {
    const captured = { products: null };

    page.on('response', async (res) => {
      try {
        if (res.url().includes('FilteredProducts') && res.url().includes('/graphql')) {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            const json = await res.json();
            const products = json?.data?.filteredProducts?.products;
            if (products && products.length > 0) {
              captured.products = products;
            }
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    return captured;
  }

  /**
   * Enrich DOM-scraped products with prices from intercepted API data
   */
  enrichWithApiPrices(products, apiProducts) {
    const missingPrices = products.filter(p => p.price == null);
    if (missingPrices.length === 0) return products;
    if (!apiProducts) {
      console.log(`  💰 ${missingPrices.length}/${products.length} products missing prices (no API data captured)`);
      return products;
    }

    console.log(`  💰 ${missingPrices.length}/${products.length} products missing prices, enriching from API (${apiProducts.length} API products)...`);

    // Build a price lookup map from API results (by normalized name)
    const priceMap = new Map();
    for (const ap of apiProducts) {
      const price = ap.recPrices?.[0] || ap.Prices?.[0] || ap.medicalPrices?.[0] || null;
      const name = ap.Name || ap.name;
      if (price != null && name) {
        const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        priceMap.set(normalizedName, price);
      }
    }

    if (priceMap.size === 0) {
      console.log(`  ⚠️ No prices found in API data`);
      return products;
    }

    let enriched = 0;
    const enrichedProducts = products.map(p => {
      if (p.price != null) return p;

      // Try exact match by normalized name
      const normalizedName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const apiPrice = priceMap.get(normalizedName);
      if (apiPrice != null) {
        enriched++;
        return { ...p, price: apiPrice };
      }

      // Try fuzzy match
      for (const [apiName, price] of priceMap) {
        if (apiName.includes(normalizedName) || normalizedName.includes(apiName)) {
          enriched++;
          return { ...p, price };
        }
      }

      return p;
    });

    console.log(`  💰 Enriched ${enriched}/${missingPrices.length} products with API prices`);
    return enrichedProducts;
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
   * Get brand slug from format type
   * Default to 'ace-solventless' since that's the actual brand name
   * Only use 'ace' for formats that explicitly specify it
   */
  getBrandSlugFromFormat(formatType) {
    // Only use 'ace' if the format explicitly says so (like 'plus-brands-ace')
    if (formatType === 'plus-brands-ace') {
      return 'ace';
    }
    // Default to ace-solventless - it's the actual brand name
    return 'ace-solventless';
  }

  /**
   * Try scraping with a specific URL
   * Returns { products, usedBrandSlug } to track which brand slug worked
   */
  async tryScrapeUrl(page, url, formatType = null) {
    await this.navigateWithRetry(page, url, {
      waitUntil: 'networkidle2'
    });

    await this.wait(2000);
    await this.handleAgeGate(page);
    await this.wait(1500);

    let targetFrame = page;
    let dutchieFrame = null;
    let iframeSrc = null;
    let usedBrandSlug = this.getBrandSlugFromFormat(formatType);
    let usedDirectFallback = false;

    // Retry iframe detection up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      const iframeDetected = await this.waitForIframeElement(page, 10000);

      if (iframeDetected) {
        const result = await this.findDutchieFrame(page);
        dutchieFrame = result.frame;
        iframeSrc = result.iframeSrc;
        if (dutchieFrame) break;
      }

      if (attempt < 3) {
        console.log(`  ⏳ Retry ${attempt + 1}/3...`);
        await this.wait(3000);
        await this.handleAgeGate(page);
      }
    }

    if (dutchieFrame) {
      targetFrame = dutchieFrame;
      await this.handleIframeAgeGate(targetFrame);
      await this.waitForIframeContent(targetFrame);

      // Check if iframe content is empty - if so, load Dutchie URL directly
      // Note: Check for dutchie.com domain, not just 'dtche' which could match query params in other URLs
      const iframeEmpty = await this.isIframeEmpty(targetFrame);
      const isDutchieUrl = iframeSrc && (iframeSrc.includes('dutchie.com') || iframeSrc.startsWith('https://dtche.')) && !iframeSrc.includes('terpli.io');
      if (iframeEmpty && isDutchieUrl) {
        // Try with format's brand slug first, then fall back to ace-solventless if needed
        const directUrl = this.addAceFiltersToDirectUrl(iframeSrc, usedBrandSlug);
        console.log(`  ⚠️ Iframe empty, trying direct: ${directUrl}`);
        await this.navigateWithRetry(page, directUrl, { waitUntil: 'networkidle2' });
        await this.wait(8000); // Wait longer for direct Dutchie to load
        await this.handleAgeGate(page); // Handle any age gate on direct page
        targetFrame = page;
        usedDirectFallback = true;
      }
    }

    // Wait for products with multiple selector options
    await targetFrame.waitForSelector(
      '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
      { timeout: 30000 }
    ).catch(() => {});

    await this.wait(2000);

    let products = await this.extractProducts(targetFrame);
    products = this.filterProducts(products);

    // If direct fallback with initial brand slug returned 0 products, try the alternate slug
    const canTryDirect = iframeSrc && (iframeSrc.includes('dutchie.com') || iframeSrc.startsWith('https://dtche.')) && !iframeSrc.includes('terpli.io');
    if (products.length === 0 && usedDirectFallback && canTryDirect) {
      // Try the other brand slug
      const altBrandSlug = usedBrandSlug === 'ace-solventless' ? 'ace' : 'ace-solventless';
      usedBrandSlug = altBrandSlug;
      const directUrl = this.addAceFiltersToDirectUrl(iframeSrc, usedBrandSlug);
      console.log(`  ⚠️ No products with '${usedBrandSlug === 'ace' ? 'ace-solventless' : 'ace'}', trying '${usedBrandSlug}': ${directUrl}`);
      await this.navigateWithRetry(page, directUrl, { waitUntil: 'networkidle2' });
      await this.wait(8000);
      await this.handleAgeGate(page);

      await page.waitForSelector(
        '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
        { timeout: 30000 }
      ).catch(() => {});

      await this.wait(2000);
      products = await this.extractProducts(page);
      products = this.filterProducts(products);
    }

    // If iframe returned 0 products but we have a direct URL, try direct as fallback
    if (products.length === 0 && dutchieFrame && canTryDirect && targetFrame !== page && !usedDirectFallback) {
      usedDirectFallback = true;
      const directUrl = this.addAceFiltersToDirectUrl(iframeSrc, usedBrandSlug);
      console.log(`  ⚠️ Iframe had 0 products, trying direct: ${directUrl}`);
      await this.navigateWithRetry(page, directUrl, { waitUntil: 'networkidle2' });
      await this.wait(8000);
      await this.handleAgeGate(page);

      await page.waitForSelector(
        '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
        { timeout: 30000 }
      ).catch(() => {});

      await this.wait(2000);
      products = await this.extractProducts(page);
      products = this.filterProducts(products);

      // Try alternate brand slug if first didn't work
      if (products.length === 0) {
        const altBrandSlug = usedBrandSlug === 'ace-solventless' ? 'ace' : 'ace-solventless';
        usedBrandSlug = altBrandSlug;
        const directUrl2 = this.addAceFiltersToDirectUrl(iframeSrc, usedBrandSlug);
        console.log(`  ⚠️ No products with '${usedBrandSlug === 'ace' ? 'ace-solventless' : 'ace'}', trying '${usedBrandSlug}': ${directUrl2}`);
        await this.navigateWithRetry(page, directUrl2, { waitUntil: 'networkidle2' });
        await this.wait(8000);
        await this.handleAgeGate(page);

        await page.waitForSelector(
          '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
          { timeout: 30000 }
        ).catch(() => {});

        await this.wait(2000);
        products = await this.extractProducts(page);
        products = this.filterProducts(products);
      }
    }

    return { products, usedBrandSlug: products.length > 0 ? usedBrandSlug : null, usedDirectFallback, iframeSrc };
  }

  /**
   * Build URL for a specific format type
   */
  buildUrlForFormat(baseUrl, formatType) {
    const urlObj = new URL(baseUrl);
    const basePathname = urlObj.pathname.replace(/\/$/, '');

    switch (formatType) {
      case 'original-filtered':
        // Use the menu_url as-is (it already has filter params)
        return baseUrl;
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
      case 'plus-brand-path':
        urlObj.pathname = basePathname + '/brands/ace';
        urlObj.search = '';
        return urlObj.toString();
      case 'plus-brand-path-full':
        urlObj.pathname = basePathname + '/brands/ace-solventless';
        urlObj.search = '';
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

      // Set up API interceptor to capture product prices from GraphQL responses
      const apiData = this.setupApiInterceptor(page);

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

      // FAST PATH: If filtered_menu_url is set, use it directly (user provided pre-filtered URL)
      if (dispensary.filtered_menu_url) {
        console.log(`  🎯 Using filtered_menu_url: ${dispensary.filtered_menu_url}`);
        try {
          const result = await this.tryScrapeUrl(page, dispensary.filtered_menu_url, 'original-filtered');
          if (result.products.length > 0) {
            const enrichedProducts = this.enrichWithApiPrices(result.products, apiData.products);
            console.log(`  ✅ Found ${enrichedProducts.length} Ace products with filtered_menu_url`);
            return {
              products: enrichedProducts,
              detectedFormat: 'original-filtered',
              brandSlug: result.usedBrandSlug,
              configWorked: true
            };
          }
          console.log(`  ⚠️ filtered_menu_url returned 0 products, falling back to discovery...`);
        } catch (e) {
          if (e.message?.includes('Navigation timeout')) {
            console.log(`  ❌ Site unreachable (timeout)`);
            throw e;
          }
          console.log(`  ⚠️ filtered_menu_url failed: ${e.message}, falling back to discovery...`);
        }
      }

      // Check for saved config - use it directly if available (unless rediscover mode)
      const savedConfig = dispensary.scrape_config;
      if (this.rediscover && savedConfig?.store_slug) {
        console.log(`  🔄 Rediscover mode - ignoring saved store_slug: ${savedConfig.store_slug}`);
      }

      // FAST PATH: If we have store_slug, go directly to Dutchie (skip iframe detection entirely)
      if (savedConfig?.store_slug && !this.rediscover) {
        const savedBrandSlug = savedConfig.brand_slug || 'ace-solventless';
        const directUrl = this.buildDirectUrl(savedConfig.store_slug, savedBrandSlug);
        console.log(`  🚀 Direct URL: ${directUrl}`);

        try {
          await this.navigateWithRetry(page, directUrl, { waitUntil: 'networkidle2' });
          await this.wait(3000);
          await this.handleAgeGate(page);

          await page.waitForSelector(
            '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
            { timeout: 30000 }
          ).catch(() => {});

          await this.wait(2000);
          let products = await this.extractProducts(page);
          products = this.filterProducts(products);

          // Try alternate brand slug if first didn't work
          if (products.length === 0) {
            const altBrandSlug = savedBrandSlug === 'ace-solventless' ? 'ace' : 'ace-solventless';
            const altUrl = this.buildDirectUrl(savedConfig.store_slug, altBrandSlug);
            console.log(`  ⚠️ No products with '${savedBrandSlug}', trying '${altBrandSlug}'`);
            await this.navigateWithRetry(page, altUrl, { waitUntil: 'networkidle2' });
            await this.wait(3000);
            await this.handleAgeGate(page);
            await page.waitForSelector(
              '[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"], [class*="card__Wrapper"], [class*="ProductCard"], [class*="product-card"], a[href*="/product/"]',
              { timeout: 30000 }
            ).catch(() => {});
            await this.wait(2000);
            products = await this.extractProducts(page);
            products = this.filterProducts(products);

            if (products.length > 0) {
              // Enrich with API prices if any are missing
              products = this.enrichWithApiPrices(products, apiData.products);
              console.log(`  ✅ Found ${products.length} Ace products with direct URL`);
              return {
                products,
                detectedFormat: 'direct',
                brandSlug: altBrandSlug,
                storeSlug: savedConfig.store_slug,
                configWorked: true
              };
            }
          }

          if (products.length > 0) {
            // Enrich with API prices if any are missing
            products = this.enrichWithApiPrices(products, apiData.products);
            console.log(`  ✅ Found ${products.length} Ace products with direct URL`);
            return {
              products,
              detectedFormat: 'direct',
              brandSlug: savedBrandSlug,
              storeSlug: savedConfig.store_slug,
              configWorked: true
            };
          } else {
            // 0 products with direct URL - might be blocked/rate limited
            // Flag for retry with iframe discovery
            console.log(`  ⚠️ Direct URL returned 0 products, flagging for retry`);
            return {
              products: [],
              detectedFormat: 'direct',
              brandSlug: savedBrandSlug,
              storeSlug: savedConfig.store_slug,
              configWorked: false,
              needsRetry: true
            };
          }
        } catch (e) {
          if (e.message?.includes('Navigation timeout')) {
            console.log(`  ❌ Site unreachable (timeout)`);
            throw e;
          }
          console.log(`  ⚠️ Direct URL failed: ${e.message}, trying iframe discovery...`);
        }
      }

      // LEGACY PATH: Use iframe-based detection (for sites without store_slug)
      if (this.rediscover && savedConfig?.url_format) {
        console.log(`  🔄 Rediscover mode - ignoring saved config: ${savedConfig.url_format}`);
      }
      if (savedConfig?.url_format && !savedConfig?.store_slug && !this.rediscover) {
        const savedBrandSlug = savedConfig.brand_slug || this.getBrandSlugFromFormat(savedConfig.url_format);
        console.log(`  ⚡ Using saved config: ${savedConfig.url_format} (brand: ${savedBrandSlug})`);
        const url = this.buildUrlForFormat(dispensary.menu_url, savedConfig.url_format);

        try {
          const result = await this.tryScrapeUrl(page, url, savedConfig.url_format);
          if (result.products.length > 0) {
            // Enrich with API prices
            const enrichedProducts = this.enrichWithApiPrices(result.products, apiData.products);
            console.log(`  ✅ Found ${enrichedProducts.length} Ace products with saved config`);
            // Don't extract storeSlug from iframe - use discover-store-slugs.js instead
            // Shared iframes (like Kind Goods) would give wrong slugs to all locations
            return {
              products: enrichedProducts,
              detectedFormat: savedConfig.url_format,
              brandSlug: result.usedBrandSlug,
              configWorked: true
            };
          }
          // Saved config returned 0 - might be timing issue, flag for retry
          console.log(`  ⚠️ Saved config returned 0 products, flagging for retry`);
          return { products: [], detectedFormat: savedConfig.url_format, configWorked: false, needsRetry: true };
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

      // Limit formats if maxFormats is set (for faster retry)
      if (this.maxFormats > 0 && urlFormats.length > this.maxFormats) {
        console.log(`  ⚡ Limiting to ${this.maxFormats} formats for faster retry`);
        urlFormats = urlFormats.slice(0, this.maxFormats);
      }

      // Track first format that successfully loads (even with 0 products)
      let firstWorkingFormat = null;
      let firstWorkingBrandSlug = null;

      for (const { url, type } of urlFormats) {
        console.log(`  📡 Trying ${type}: ${url}`);

        try {
          const result = await this.tryScrapeUrl(page, url, type);

          // Track first format that works (loads without error)
          if (!firstWorkingFormat) {
            firstWorkingFormat = type;
            firstWorkingBrandSlug = result.usedBrandSlug;
          }

          if (result.products.length > 0) {
            // Enrich with API prices
            const enrichedProducts = this.enrichWithApiPrices(result.products, apiData.products);
            console.log(`  ✅ Found ${enrichedProducts.length} Ace products with ${type} format (brand: ${result.usedBrandSlug})`);
            // Don't extract storeSlug from iframe - use discover-store-slugs.js instead
            // Shared iframes (like Kind Goods) would give wrong slugs to all locations
            return {
              products: enrichedProducts,
              detectedFormat: type,
              brandSlug: result.usedBrandSlug,
              configWorked: false
            };
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
        // Don't save storeSlug from iframe discovery - use discover-store-slugs.js instead
        return { products: [], detectedFormat: firstWorkingFormat, brandSlug: firstWorkingBrandSlug, configWorked: false };
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
