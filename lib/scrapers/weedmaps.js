const BaseScraper = require('./base');

/**
 * Scraper for Weedmaps-powered dispensary menus (*.wm.store)
 * Uses search filter to find ACE products
 */
class WeedmapsScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || 'ace';
  }

  /**
   * Build the filtered URL for ACE products
   */
  buildFilteredUrl(baseUrl) {
    const url = new URL(baseUrl);
    // Weedmaps uses filter[match] for search
    url.searchParams.set('filter[match]', this.brandFilter);
    return url.toString();
  }

  /**
   * Extract products from the Weedmaps page
   */
  async extractProducts(page) {
    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, 500));
    await this.wait(1000);
    await page.evaluate(() => window.scrollTo(0, 1000));
    await this.wait(2000);

    return await page.evaluate(() => {
      const results = [];

      // Weedmaps uses styled-components with dynamic class names
      // Look for MenuItemWrapper or list items containing products
      const selectors = [
        '[class*="MenuItemWrapper"]',
        '[class*="menu-item-wrapper"]',
        'li:has([class*="DetailsWrap"])',
        'li:has(a[href*="/product/"])',
        '[class*="InsideWrapper"]'
      ];

      let productElements = [];
      for (const selector of selectors) {
        try {
          productElements = document.querySelectorAll(selector);
          if (productElements.length > 0) {
            break;
          }
        } catch (e) {
          // :has() may not be supported, continue
        }
      }

      // Fallback: find li elements with price and product info
      if (productElements.length === 0) {
        const listItems = document.querySelectorAll('li');
        productElements = Array.from(listItems).filter(li => {
          const text = li.textContent || '';
          return text.includes('$') && text.includes('ACE');
        });
      }

      productElements.forEach(el => {
        try {
          // Get the full text content
          const fullText = el.textContent || '';

          // Skip if doesn't look like a product
          if (!fullText.includes('$') || fullText.length > 500) return;

          // Try to find the name element
          const nameEl = el.querySelector(
            '[class*="Name-sc"], [class*="NameContainer"], [class*="product-name"], a[href*="/product/"]'
          );
          let name = nameEl?.textContent?.trim();

          // If no name element, try to extract from text
          if (!name) {
            // Pattern: CategoryBrand - ProductName$Price
            // e.g., "RosinACE - 2g Cold Cured Live Rosin - Sewer Water$100.00each"
            const match = fullText.match(/(?:Rosin|Vape|Edible|Concentrate)?(?:ACE\s*-?\s*)(.+?)(?:\$[\d.]+)/i);
            if (match) {
              name = 'ACE - ' + match[1].trim();
            }
          }

          if (!name) return;

          // Clean up name - remove category prefix and duplicates
          name = name.replace(/^(Rosin|Vape|Edibles?|Concentrate|Disposable|Cooking)\s*/i, '');

          // Remove duplicate ACE prefix (e.g., "ACE - sACE -" -> "ACE -")
          name = name.replace(/^ACE\s*-?\s*[a-z]?ACE\s*-?\s*/i, 'ACE - ');
          name = name.replace(/^[a-z]?ACE\s*-?\s*/i, 'ACE - ');

          // Clean up double dashes
          name = name.replace(/\s*-\s*-\s*/g, ' - ');
          name = name.trim();

          // Get price
          const priceMatch = fullText.match(/\$([\d.]+)/);
          const price = priceMatch ? parseFloat(priceMatch[1]) : null;

          // Get category from element or infer from text
          const categoryEl = el.querySelector('[class*="CategoryName"]');
          let category = null;
          if (categoryEl) {
            // Get only direct text, not nested elements
            const catText = categoryEl.childNodes[0]?.textContent?.trim();
            if (catText && catText.length < 30) {
              category = catText;
            }
          }
          // Infer category from product name/text
          if (!category) {
            const nameLower = name.toLowerCase();
            if (nameLower.includes('live rosin') || nameLower.includes('cold cure')) category = 'Concentrate';
            else if (nameLower.includes('sesh stick') || nameLower.includes('disposable')) category = 'Vape';
            else if (nameLower.includes('syrup') || nameLower.includes('jackpot')) category = 'Edible';
            else if (nameLower.includes('hot sauce')) category = 'Edible';
          }

          // Extract size from name
          const sizeMatch = name.match(/([\d.]+)\s*(g|mg|oz|ml)/i);
          const size = sizeMatch ? sizeMatch[0] : null;

          // Get URL
          let url = null;
          const linkEl = el.querySelector('a[href*="/product/"]');
          if (linkEl) url = linkEl.href;

          results.push({
            name,
            brand: 'ACE',
            price,
            category,
            size,
            url
          });
        } catch (e) {
          console.error('Error extracting product:', e);
        }
      });

      return results;
    });
  }

  /**
   * Filter products to only include ACE products
   */
  filterProducts(products) {
    if (!this.brandFilter) return products;

    const filterLower = this.brandFilter.toLowerCase();
    return products.filter(p => {
      const name = (p.name || '').toLowerCase();
      const brand = (p.brand || '').toLowerCase();

      // Check if ACE is in name or brand
      const isAce = name.includes('ace') ||
                    brand.includes('ace') ||
                    name.includes('ace solventless') ||
                    brand.includes('ace solventless');

      // Exclude distillate products (Ace only makes solventless)
      if (name.includes('distillate')) {
        return false;
      }

      return isAce;
    });
  }

  /**
   * Main scrape method
   */
  async scrape(dispensary) {
    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // Build URL with ACE filter
      const baseUrl = dispensary.menu_url || dispensary.filtered_menu_url;
      const filteredUrl = this.buildFilteredUrl(baseUrl);

      console.log(`  🔍 Searching for ACE products...`);
      await this.navigateWithRetry(page, filteredUrl, { waitUntil: 'networkidle2' });

      // Wait for page to fully load
      await this.wait(3000);

      // Handle any age gates
      await this.handleAgeGate(page);
      await this.wait(2000);

      // Wait for product cards to appear
      await page.waitForSelector(
        '[data-testid="menu-item-card"], [class*="ProductCard"], [class*="product-card"], [class*="menu-item"], [class*="listing-card"], a[href*="/product/"]',
        { timeout: 30000 }
      ).catch(() => {
        console.log('  ⚠️ No product cards found with standard selectors');
      });

      // Extra wait for dynamic content
      await this.wait(2000);

      // Extract products
      let products = await this.extractProducts(page);
      console.log(`  📦 Extracted ${products.length} products from page`);

      // Filter for ACE products
      products = this.filterProducts(products);
      console.log(`  ✅ Found ${products.length} ACE products`);

      return {
        products,
        detectedFormat: 'weedmaps-search',
        configWorked: true
      };

    } finally {
      await browser.close();
    }
  }
}

module.exports = WeedmapsScraper;
