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
   * Extract products from VFI-powered page
   */
  async extractProducts(page) {
    return page.evaluate(() => {
      const results = [];

      // VFI uses .prdt_holder for product cards
      // The Angular _ngcontent attributes change, so we use the stable class names
      const productElements = document.querySelectorAll('.prdt_holder, [class*="prdt_holder"]');

      productElements.forEach(el => {
        try {
          // Product name - in .prdt_name h2
          const nameEl = el.querySelector('.prdt_name h2, .prdt_name');
          const name = nameEl?.textContent?.trim();

          if (!name) return;

          // Brand/Vendor - in .prdt_category (displays above product name)
          const brandEl = el.querySelector('.prdt_category');
          const brand = brandEl?.textContent?.trim();

          // Price - in .prdt_price (may have original + sale price)
          const priceEl = el.querySelector('.prdt_price');
          const priceText = priceEl?.textContent?.trim();
          // Extract the actual price (last price shown, which is the sale price if discounted)
          const priceMatches = priceText?.match(/\$[\d.]+/g);
          const price = priceMatches?.length > 0
            ? parseFloat(priceMatches[priceMatches.length - 1].replace('$', ''))
            : null;

          // THC percentage
          const thcEl = el.querySelector('.prd_thc');
          const thcText = thcEl?.textContent?.trim();
          const thcMatch = thcText?.match(/([\d.]+)\s*%/);
          const thc = thcMatch ? thcMatch[1] + '%' : null;

          // Category/strain type (Sativa, Indica, Hybrid) - from image alt or class
          const strainEl = el.querySelector('.prdt_mnt_holder img, [class*="strain"]');
          let category = strainEl?.alt?.trim() || null;

          // Try to get category from text if not in image
          if (!category) {
            const categoryText = el.querySelector('.prdt_mnt_holder')?.textContent?.trim();
            if (categoryText) {
              if (categoryText.toLowerCase().includes('sativa')) category = 'Sativa';
              else if (categoryText.toLowerCase().includes('indica')) category = 'Indica';
              else if (categoryText.toLowerCase().includes('hybrid')) category = 'Hybrid';
            }
          }

          // Size/weight - often in product details or name
          let size = null;
          const detailsText = el.textContent || '';
          const sizeMatch = detailsText.match(/(\d+(?:\.\d+)?)\s*(g|oz|mg|ml|pk|pack)/i);
          if (sizeMatch) {
            size = sizeMatch[0];
          }

          // Product URL - look for link wrapping the card
          const linkEl = el.querySelector('a[href*="/product"], a[href*="menu"]') ||
                        el.closest('a') ||
                        el.querySelector('a');
          const url = linkEl?.href;

          // Product image
          const imgEl = el.querySelector('.prdt_img_hld img, img');
          const image = imgEl?.src;

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
              html: el.innerHTML.substring(0, 500)
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
   * Filter products by brand if brandFilter is set
   */
  filterProducts(products) {
    if (!this.brandFilter) {
      return products;
    }

    const filterLower = this.brandFilter.toLowerCase();

    return products.filter(product => {
      const brand = (product.brand || '').toLowerCase();
      const name = (product.name || '').toLowerCase();

      return brand.includes(filterLower) || name.includes(filterLower);
    });
  }

  /**
   * Main scrape method for VFI dispensaries
   */
  async scrape(dispensary) {
    const menuUrl = dispensary.menu_url;
    console.log(`  📡 Loading: ${menuUrl}`);

    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      // Navigate to menu page
      await page.goto(menuUrl, {
        waitUntil: 'networkidle2', // VFI needs more time for Angular to render
        timeout: this.options.timeout
      });

      // Wait for initial load
      await this.wait(3000);

      // Handle age gate if present
      await this.handleAgeGate(page);

      const pageTitle = await page.title();
      console.log(`  📄 Page title: ${pageTitle}`);

      // Wait for product cards to appear
      // VFI uses Angular which may take time to hydrate
      try {
        await page.waitForSelector('.prdt_holder, [class*="prdt_holder"]', {
          timeout: 30000
        });
        console.log('  ✅ Product cards found');
      } catch (e) {
        console.log('  ⚠️ No product cards found with .prdt_holder selector');

        // Try scrolling to trigger lazy loading
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await this.wait(2000);
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await this.wait(2000);
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
