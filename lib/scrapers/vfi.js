const BaseScraper = require('./base');

/**
 * Scraper for VFI Technology-powered dispensary menus
 * Used by Swade Cannabis and other VFI clients
 * Angular-based, no iframe - direct page scraping
 */
class VFIScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
  }

  /**
   * Add search/filter parameters to VFI URL
   */
  addFilters(url) {
    const urlObj = new URL(url);

    // Ensure we're on the categories/all page with search param
    // e.g., https://swadecannabis.com/kc/categories/all?search=ace
    let pathname = urlObj.pathname;

    // If path doesn't end with /categories/all, add it
    if (!pathname.includes('/categories/')) {
      // Remove trailing slash if present
      pathname = pathname.replace(/\/$/, '');
      pathname = `${pathname}/categories/all`;
    }

    urlObj.pathname = pathname;

    // Add search param for brand filter
    if (this.brandFilter && !urlObj.searchParams.has('search')) {
      urlObj.searchParams.set('search', this.brandFilter);
    }

    return urlObj.toString();
  }

  /**
   * Extract products from VFI-powered page
   */
  async extractProducts(page) {
    return page.evaluate(() => {
      const results = [];

      // VFI uses .innerbox for product cards (not .prdt_holder as originally thought)
      let productElements = document.querySelectorAll('.innerbox');
      console.log('Found .innerbox:', productElements.length);

      // Fallback selectors
      if (productElements.length === 0) {
        productElements = document.querySelectorAll('.prdt_holder, [class*="prdt_holder"]');
        console.log('Found .prdt_holder:', productElements.length);
      }

      productElements.forEach(el => {
        try {
          // Get all text content for parsing
          const fullText = el.innerText || el.textContent || '';

          // Skip if too short (probably not a product)
          if (fullText.length < 10) return;

          // Parse the text content - VFI format is typically:
          // "BRAND NAME Product Name STRAIN_TYPE THC/Terpene% SIZE $PRICE"
          // But may have sale badges like "20% OFF *" before brand
          const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

          // Skip sale/discount badges to find the real brand
          let brandIdx = 0;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            // Skip lines that look like sale badges
            if (line.includes('% off') || line.includes('sale') || line.includes('deal') ||
                line.includes('special') || line.includes('promo') || line.match(/^\d+%/)) {
              brandIdx = i + 1;
            } else {
              break;
            }
          }

          // Brand is the first non-sale line
          const brand = lines[brandIdx] || null;

          // Product name is the next line after brand
          let name = lines[brandIdx + 1] || null;

          // Extract price from anywhere in text
          const priceMatch = fullText.match(/\$[\d.]+/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace('$', '')) : null;

          // Extract size
          const sizeMatch = fullText.match(/(\d+(?:\.\d+)?)\s*(g|oz|mg|ml)/i);
          const size = sizeMatch ? sizeMatch[0] : null;

          // Extract THC/Terpene percentage
          const thcMatch = fullText.match(/(?:THC|Total Terpene)\s*([\d.]+)\s*%/i);
          const thc = thcMatch ? thcMatch[1] + '%' : null;

          // Extract strain type
          let category = null;
          const textLower = fullText.toLowerCase();
          if (textLower.includes('indica dominant')) category = 'Indica Dominant';
          else if (textLower.includes('sativa dominant')) category = 'Sativa Dominant';
          else if (textLower.includes('indica')) category = 'Indica';
          else if (textLower.includes('sativa')) category = 'Sativa';
          else if (textLower.includes('hybrid')) category = 'Hybrid';

          // Get URL from parent link if exists
          const linkEl = el.closest('a') || el.querySelector('a');
          const url = linkEl?.href || null;

          // Get image
          const imgEl = el.querySelector('img');
          const image = imgEl?.src || null;

          // Skip if no name
          if (!name) return;

          results.push({
            name,
            brand: brand || null,
            price: isNaN(price) ? null : price,
            category: category || null,
            size: size || null,
            thc: thc || null,
            url: url || null,
            image: image || null,
            raw: {
              text: fullText.substring(0, 300)
            }
          });
        } catch (e) {
          console.error('Error parsing VFI product:', e);
        }
      });

      return results;
    });
  }

  /**
   * Handle VFI-specific age gate popup
   */
  async handleVFIAgeGate(page) {
    try {
      // Check for VFI age gate
      const ageGate = await page.$('.wdh_age_rest_body, [class*="age_rest"], [class*="age-gate"], [class*="age_gate"]');

      if (ageGate) {
        console.log('  🚪 VFI age gate detected, attempting to bypass...');

        // Look for Yes/Enter/21+ buttons
        const clicked = await page.evaluate(() => {
          // Try various button patterns
          const selectors = [
            '.wdh_age_rest_body button',
            '[class*="age"] button',
            'button[class*="yes"]',
            'button[class*="enter"]',
            'button[class*="confirm"]'
          ];

          for (const sel of selectors) {
            const buttons = document.querySelectorAll(sel);
            for (const btn of buttons) {
              const text = btn.textContent?.toLowerCase() || '';
              if (text.includes('yes') || text.includes('enter') || text.includes('21') || text.includes('agree') || text.includes('confirm')) {
                btn.click();
                return true;
              }
            }
          }

          // Try clicking any button in age gate area
          const ageArea = document.querySelector('.wdh_age_rest_body, [class*="age_rest"]');
          if (ageArea) {
            const btn = ageArea.querySelector('button');
            if (btn) {
              btn.click();
              return true;
            }
          }

          return false;
        });

        if (clicked) {
          console.log('  ✅ Clicked age gate button');
          await this.wait(3000);
        } else {
          console.log('  ⚠️ Could not find age gate button to click');
        }
      }
    } catch (error) {
      console.log('  ⚠️ VFI age gate error:', error.message);
    }
  }

  /**
   * Filter products by brand if brandFilter is set
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

      // Must match brand filter (ace) or jackpot (Ace sub-brand) as whole word
      const matchesBrand = aceRegex.test(brand) || jackpotRegex.test(brand);
      const matchesName = aceRegex.test(name) || jackpotRegex.test(name);
      if (!matchesBrand && !matchesName) {
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
   * Main scrape method for VFI dispensaries
   */
  async scrape(dispensary) {
    // Add filters to URL if brand filter is set
    const menuUrl = this.brandFilter ? this.addFilters(dispensary.menu_url) : dispensary.menu_url;
    console.log(`  📡 Loading: ${menuUrl}`);

    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // Navigate to menu page with retry
      await this.navigateWithRetry(page, menuUrl, {
        waitUntil: 'networkidle2' // VFI needs more time for Angular to render
      });

      // Wait for initial load
      await this.wait(3000);

      // Handle VFI-specific age gate
      await this.handleVFIAgeGate(page);

      // Also try generic age gate
      await this.handleAgeGate(page);

      const pageTitle = await page.title();
      console.log(`  📄 Page title: ${pageTitle}`);

      // Debug: Check what's on the page
      const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
      console.log(`  📝 Page preview: ${bodyHTML.substring(0, 500)}...`);

      // Wait for product cards to appear
      // VFI uses .innerbox for product cards
      try {
        await page.waitForSelector('.innerbox', {
          timeout: 30000
        });
        console.log('  ✅ Product cards found (.innerbox)');
      } catch (e) {
        console.log('  ⚠️ No .innerbox found, trying scroll...');

        // Try scrolling to trigger lazy loading
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await this.wait(3000);
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await this.wait(3000);
      }

      // Scroll through page to load all lazy-loaded products
      await this.scrollToLoadAll(page);

      // Extract products
      const products = await this.extractProducts(page);
      console.log(`  📦 Found ${products.length} products (unfiltered)`);

      // Filter products
      const filteredProducts = this.filterProducts(products);
      if (this.brandFilter) {
        console.log(`  🎯 ${filteredProducts.length} products after filtering for "${this.brandFilter}"`);
      }

      return filteredProducts;

    } finally {
      await browser.close();
    }
  }

  /**
   * Scroll through page to load lazy-loaded content
   */
  async scrollToLoadAll(page) {
    console.log('  📜 Scrolling to load all products...');

    let previousHeight = 0;
    let currentHeight = await page.evaluate(() => document.body.scrollHeight);
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;

    while (previousHeight !== currentHeight && scrollAttempts < maxScrollAttempts) {
      previousHeight = currentHeight;

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      await this.wait(1500);

      currentHeight = await page.evaluate(() => document.body.scrollHeight);
      scrollAttempts++;
    }

    // Scroll back to top
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });

    await this.wait(1000);
    console.log(`  ✅ Scrolling complete (${scrollAttempts} scrolls)`);
  }
}

module.exports = VFIScraper;
