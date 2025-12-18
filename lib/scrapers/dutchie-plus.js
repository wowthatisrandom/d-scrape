const BaseScraper = require('./base');
const DutchieScraper = require('./dutchie');

/**
 * Scraper for Dutchie Plus sites (Flutter-based, uses GraphQL API)
 * Falls back to regular Dutchie scraper if API is blocked
 */
class DutchiePlusScraper extends BaseScraper {
  constructor(options = {}) {
    super(options);
    this.brandFilter = options.brandFilter || null;
    // Create a fallback Dutchie scraper with plusMode
    this.fallbackScraper = new DutchieScraper({ ...options, plusMode: true });
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://dutchie.com',
        'Referer': 'https://dutchie.com/'
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

    // Check if response is HTML (error page) instead of JSON
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      console.log(`  ⚠️ API returned non-JSON response (${response.status}): ${text.substring(0, 100)}...`);
      return [];
    }

    const data = await response.json();

    if (data.errors) {
      console.log(`  ⚠️ API returned errors:`, data.errors);
      return [];
    }

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

      // Must have "ace" or "jackpot" (Ace sub-brand) in brand
      if (!brand.includes('ace') && !brand.includes('jackpot')) {
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

      // If API returned no products, fall back to DOM scraping
      if (filteredProducts.length === 0) {
        console.log('  🔄 API returned no products, falling back to DOM scraping...');
        await browser.close();
        return this.fallbackScraper.scrape(dispensary);
      }

      return filteredProducts;

    } finally {
      await browser.close();
    }
  }
}

module.exports = DutchiePlusScraper;
