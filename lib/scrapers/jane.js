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
          // Format A (flower/concentrate): Strain Type, Product Name [Size], Brand, Category
          // Format B (syrup): Product Name (Size), Brand, Category
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

          if (lines.length < 3) return;

          let brand = null;
          let name = null;
          let category = null;
          let thc = null;
          let price = null;
          let strainType = null;
          let size = null;

          // First pass: identify special lines
          for (const line of lines) {
            if (line.startsWith('$')) {
              price = parseFloat(line.replace(/[^0-9.]/g, ''));
            } else if (line.includes('THC')) {
              thc = line;
            } else if (line.toLowerCase().includes('solventless')) {
              brand = line;
            }
          }

          // Second pass: find name from the first few lines
          for (let i = 0; i < Math.min(lines.length, 4); i++) {
            const line = lines[i];

            // Skip strain types
            if (['Hybrid', 'Indica', 'Sativa', 'CBD'].includes(line)) {
              strainType = line;
              continue;
            }

            // Skip brand (already found)
            if (brand && line === brand) continue;

            // Skip meta lines
            if (line === 'Add to bag' || line === '(EACH)' || line === 'SALE') continue;
            if (line.startsWith('$') || line.includes('THC')) continue;

            // Skip standalone size (just numbers + unit)
            if (/^\d+(\.\d+)?\s*(mg|g|ml|oz)$/i.test(line)) {
              size = line;
              continue;
            }

            // Skip size in parentheses like "(3.5G)"
            if (/^\([^)]+\)$/.test(line)) continue;

            // This is likely the product name
            if (!name) {
              name = line;
              // Extract size from name if present
              const sizeMatch = line.match(/\[([^\]]+)\]/) || line.match(/\((\d+(?:\.\d+)?\s*(?:mg|g|ml|oz))\)/i);
              if (sizeMatch) {
                size = sizeMatch[1];
              }
            }
            // This might be the category
            else if (!category && !brand) {
              category = line;
            }
          }

          // If still no name, use second line (skip strain type)
          if (!name) {
            const startIdx = ['Hybrid', 'Indica', 'Sativa', 'CBD'].includes(lines[0]) ? 1 : 0;
            if (lines[startIdx]) {
              name = lines[startIdx];
            }
          }

          // Get URL from the link inside the card
          const link = card.querySelector('a[href*="product"]');
          const url = link ? link.href : null;

          // Skip if no valid name
          if (!name || /^\d+(\.\d+)?\s*(mg|g|ml|oz)$/i.test(name)) return;

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

    return products.filter(product => {
      const brand = (product.brand || '').toLowerCase();
      const name = (product.name || '').toLowerCase();

      // Must have "ace" or "jackpot" (Ace sub-brand) in brand
      if (!brand.includes('ace') && !brand.includes('jackpot')) {
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
