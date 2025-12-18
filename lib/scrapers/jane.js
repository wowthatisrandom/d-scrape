const BaseScraper = require('./base');

/**
 * Scraper for iHeartJane-powered dispensary menus
 * Jane uses Shadow DOM for rendering products
 */
class JaneScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
  }

  /**
   * Add search filter to Jane URL
   */
  addFilters(url) {
    const urlObj = new URL(url);

    if (this.brandFilter && !urlObj.searchParams.has('searchText')) {
      urlObj.searchParams.set('searchText', this.brandFilter);
    }

    return urlObj.toString();
  }

  /**
   * Handle Jane/WordPress age gate
   */
  async handleJaneAgeGate(page) {
    try {
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, input[type="submit"], a');
        for (const btn of buttons) {
          const text = (btn.textContent || btn.value || '').toLowerCase();
          if (text.includes('yes') || text.includes('enter') || text.includes('21') || text.includes('i am')) {
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
   * Wait for Jane Shadow DOM to load products
   */
  async waitForShadowContent(page) {
    console.log('  ⏳ Waiting for Jane Shadow DOM...');

    try {
      await page.waitForFunction(() => {
        const shadowHost = document.querySelector('#shadow-host');
        if (!shadowHost || !shadowHost.shadowRoot) return false;

        // Check if products have loaded
        const cards = shadowHost.shadowRoot.querySelectorAll('[class*="_card_"]');
        return cards.length > 0;
      }, { timeout: 30000 });

      console.log('  ✅ Shadow DOM content loaded');
    } catch (e) {
      console.log('  ⚠️ Shadow DOM load timeout, continuing...');
    }

    // Extra wait for all products to render
    await this.wait(3000);
  }

  /**
   * Extract products from Jane Shadow DOM
   */
  async extractProducts(page) {
    return page.evaluate(() => {
      const results = [];

      const shadowHost = document.querySelector('#shadow-host');
      if (!shadowHost || !shadowHost.shadowRoot) {
        console.log('No shadow DOM found');
        return results;
      }

      const shadowRoot = shadowHost.shadowRoot;

      // Jane uses _card_ class for product cards
      const cards = shadowRoot.querySelectorAll('[class*="_card_1"]');
      console.log('Found cards:', cards.length);

      cards.forEach(card => {
        try {
          const text = card.innerText || '';
          if (!text || text.length < 20) return;

          // Parse the card text - Jane format is typically:
          // Strain Type
          // Product Name [Size]
          // Brand
          // Category
          // (EACH)
          // THC XX%
          // $XX.XX
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

          if (lines.length < 3) return;

          // Find brand (usually "ACE Solventless" or similar)
          let brand = null;
          let name = null;
          let category = null;
          let thc = null;
          let price = null;
          let strainType = null;

          for (const line of lines) {
            // Price
            if (line.startsWith('$')) {
              price = parseFloat(line.replace('$', ''));
            }
            // THC percentage
            else if (line.includes('THC')) {
              thc = line;
            }
            // Skip "Add to bag", "(EACH)", etc
            else if (line === 'Add to bag' || line === '(EACH)' || line === 'SALE') {
              continue;
            }
            // Strain type (first line usually)
            else if (['Hybrid', 'Indica', 'Sativa', 'CBD'].includes(line)) {
              strainType = line;
            }
            // Brand detection (known brands or contains "Solventless")
            else if (line.toLowerCase().includes('solventless') ||
                     line.toLowerCase().includes('ace') ||
                     line === line.toUpperCase() && line.length > 3) {
              brand = line;
            }
            // Product name (usually contains size in brackets)
            else if (line.includes('[') || line.includes('mg') || line.includes('g]')) {
              name = line;
            }
            // Category
            else if (!name && !category) {
              // Could be name or category
              if (!name) name = line;
              else category = line;
            }
          }

          // If we didn't find a name, use the second line
          if (!name && lines.length > 1) {
            name = lines[1];
          }

          // Get URL from the link inside the card
          const link = card.querySelector('a[href*="product"]');
          const url = link ? link.href : null;

          // Extract size from name
          let size = null;
          const sizeMatch = (name || '').match(/\[([^\]]+)\]/) || (name || '').match(/(\d+(?:\.\d+)?)\s*(mg|g|oz|ml)/i);
          if (sizeMatch) {
            size = sizeMatch[1] || sizeMatch[0];
          }

          if (name) {
            results.push({
              name: name,
              brand: brand || null,
              price: isNaN(price) ? null : price,
              category: category || strainType || null,
              size: size || null,
              thc: thc || null,
              url: url || null,
              raw: { text: text.substring(0, 300) }
            });
          }
        } catch (e) {
          console.error('Error parsing Jane product:', e);
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

    const filterLower = this.brandFilter.toLowerCase();

    return products.filter(product => {
      const brand = (product.brand || '').toLowerCase();
      const name = (product.name || '').toLowerCase();

      // Must match brand filter in brand or name
      if (!brand.includes(filterLower) && !name.includes(filterLower)) {
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
   * Main scrape method for Jane dispensaries
   */
  async scrape(dispensary) {
    const menuUrl = this.brandFilter ? this.addFilters(dispensary.menu_url) : dispensary.menu_url;
    console.log(`  📡 Loading: ${menuUrl}`);

    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      await page.goto(menuUrl, {
        waitUntil: 'networkidle2',
        timeout: this.options.timeout
      });

      await this.wait(2000);

      // Handle age gate
      await this.handleJaneAgeGate(page);
      await this.handleAgeGate(page);

      // Wait for Shadow DOM to load
      await this.waitForShadowContent(page);

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
}

module.exports = JaneScraper;
