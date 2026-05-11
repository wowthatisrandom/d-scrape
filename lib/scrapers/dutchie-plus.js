const BaseScraper = require('./base');
const DutchieScraper = require('./dutchie');
const { isExcludedProduct } = require('../exclusions');

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
        strainType: p.strainType || null,
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

      if (name.toLowerCase().includes('distillate')) {
        return false;
      }

      if (isExcludedProduct(name, brand)) {
        return false;
      }

      return true;
    });
  }

  /**
   * Main scrape method
   *
   * The direct Dutchie API path is currently Cloudflare-blocked (returns 403
   * non-JSON regardless of retailerId), so the API call + retailerId fetch is
   * pure overhead — every plus scrape was loading the page, hitting 403, and
   * then handing off to the DOM fallback anyway. Skipping straight to the DOM
   * fallback avoids ~5s of wasted page load + API call per scrape.
   *
   * Re-enable the API path (see git history for the original implementation)
   * if/when Dutchie's API auth or Cloudflare rules change.
   */
  async scrape(dispensary) {
    return await this.fallbackScraper.scrape(dispensary);
  }
}

module.exports = DutchiePlusScraper;
