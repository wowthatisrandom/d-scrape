const BaseScraper = require('./base');

/**
 * Scraper for Dutchie Plus sites (Flutter-based, uses GraphQL API)
 * These sites render to canvas and can't be DOM scraped
 */
class DutchiePlusScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
  }

  /**
   * Extract retailer ID from the page
   */
  async getRetailerId(page) {
    try {
      // Look for retailerId in page scripts
      const retailerId = await page.evaluate(() => {
        // Check window.__NEXT_DATA__
        const nextData = document.getElementById('__NEXT_DATA__');
        if (nextData) {
          try {
            const data = JSON.parse(nextData.textContent);
            if (data?.props?.pageProps?.retailerId) {
              return data.props.pageProps.retailerId;
            }
          } catch (e) {}
        }

        // Check for reactEnv
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          const match = text.match(/"retailerId"\s*:\s*"([^"]+)"/);
          if (match) return match[1];
        }

        return null;
      });

      return retailerId;
    } catch (e) {
      console.log('  ⚠️ Could not extract retailerId:', e.message);
      return null;
    }
  }

  /**
   * Fetch products from Dutchie GraphQL API
   */
  async fetchProductsFromAPI(retailerId, searchTerm = 'ace') {
    const query = `
      query FilteredProducts($retailerId: ID!, $pricingType: PricingType, $search: String) {
        filteredProducts(
          retailerId: $retailerId
          filter: { search: $search }
          pagination: { limit: 100, offset: 0 }
          pricingType: $pricingType
        ) {
          products {
            id
            name
            brand {
              name
            }
            category
            strainType
            potencyCbd {
              formatted
            }
            potencyThc {
              formatted
            }
            variants {
              id
              option
              priceMed
              priceRec
              quantity
            }
          }
        }
      }
    `;

    const response = await fetch('https://api.dutchie.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          retailerId,
          pricingType: 'RECREATIONAL',
          search: searchTerm
        }
      })
    });

    const data = await response.json();
    return data?.data?.filteredProducts?.products || [];
  }

  /**
   * Transform API products to our format
   */
  transformProducts(apiProducts) {
    return apiProducts.map(p => {
      const variant = p.variants?.[0];
      const size = variant?.option || null;
      const price = variant?.priceRec || variant?.priceMed || null;

      return {
        name: p.name,
        brand: p.brand?.name || null,
        price: price,
        category: p.category || null,
        size: size,
        thc: p.potencyThc?.formatted || null,
        url: null,
        raw: { apiId: p.id }
      };
    });
  }

  /**
   * Filter products
   */
  filterProducts(products) {
    if (!this.brandFilter) {
      return products;
    }

    return products.filter(product => {
      const brand = (product.brand || '').toLowerCase();
      const name = (product.name || '').toLowerCase();

      if (!brand.includes('ace')) {
        return false;
      }

      if (name.includes('distillate')) {
        return false;
      }

      return true;
    });
  }

  /**
   * Main scrape method
   */
  async scrape(dispensary) {
    console.log(`  📡 Loading: ${dispensary.menu_url}`);

    const browser = await this.launchBrowser();

    try {
      const page = await this.createPage(browser);

      await page.goto(dispensary.menu_url, {
        waitUntil: 'networkidle2',
        timeout: this.options.timeout
      });

      await this.wait(3000);

      // Get retailer ID from page
      const retailerId = await this.getRetailerId(page);

      if (!retailerId) {
        console.log('  ⚠️ Could not find retailerId, falling back to DOM scraping');
        // Could fall back to regular Dutchie scraper here
        return [];
      }

      console.log(`  🔑 Found retailerId: ${retailerId}`);

      // Fetch products from API
      const searchTerm = this.brandFilter || 'ace';
      console.log(`  🔍 Searching API for: ${searchTerm}`);

      const apiProducts = await this.fetchProductsFromAPI(retailerId, searchTerm);
      console.log(`  📦 API returned ${apiProducts.length} products`);

      // Transform to our format
      const products = this.transformProducts(apiProducts);

      // Filter products
      const filteredProducts = this.filterProducts(products);
      console.log(`  🎯 ${filteredProducts.length} products after filtering`);

      return filteredProducts;

    } finally {
      await browser.close();
    }
  }
}

module.exports = DutchiePlusScraper;
