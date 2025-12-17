const puppeteer = require('puppeteer');

// Scrape a Dutchie-powered dispensary menu
async function scrapeDispensary(dispensary) {
  console.log(`  📡 Loading: ${dispensary.menu_url}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080'
    ]
  });

  try {
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to menu page - use domcontentloaded for faster initial load
    await page.goto(dispensary.menu_url, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    // Wait a bit for JavaScript to render
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Wait for Dutchie menu to load
    // Dutchie menus typically have product cards or a product grid
    await page.waitForSelector('[data-testid="product-card"], .product-card, [class*="ProductCard"], [class*="product-tile"], [class*="menu-product"], .product, [data-product]', {
      timeout: 45000
    }).catch(() => {
      console.log('  ⚠️ No standard product cards found, trying alternative selectors...');
    });

    // Give extra time for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract products from the page
    const products = await page.evaluate(() => {
      const results = [];

      // Try multiple selectors that Dutchie might use
      const selectors = [
        '[data-testid="product-card"]',
        '.product-card',
        '[class*="ProductCard"]',
        '[class*="product-tile"]',
        '[class*="menu-product"]',
        '.menu-item',
        '[data-product]'
      ];

      let productElements = [];
      for (const selector of selectors) {
        productElements = document.querySelectorAll(selector);
        if (productElements.length > 0) break;
      }

      productElements.forEach(el => {
        try {
          // Extract product name
          const nameEl = el.querySelector(
            '[data-testid="product-name"], .product-name, [class*="ProductName"], [class*="product-title"], h3, h4, .name'
          );
          const name = nameEl?.textContent?.trim();

          if (!name) return; // Skip if no name

          // Extract brand
          const brandEl = el.querySelector(
            '[data-testid="product-brand"], .product-brand, [class*="ProductBrand"], [class*="brand"], .brand'
          );
          const brand = brandEl?.textContent?.trim();

          // Extract price
          const priceEl = el.querySelector(
            '[data-testid="product-price"], .product-price, [class*="ProductPrice"], [class*="price"], .price'
          );
          const priceText = priceEl?.textContent?.trim();
          const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

          // Extract category
          const categoryEl = el.querySelector(
            '[data-testid="product-category"], .product-category, [class*="category"], .category'
          );
          const category = categoryEl?.textContent?.trim();

          // Extract size/weight
          const sizeEl = el.querySelector(
            '[data-testid="product-size"], .product-size, [class*="size"], [class*="weight"], .size, .weight'
          );
          const size = sizeEl?.textContent?.trim();

          // Extract product URL if available
          const linkEl = el.querySelector('a[href]');
          const url = linkEl?.href;

          results.push({
            name,
            brand: brand || null,
            price: isNaN(price) ? null : price,
            category: category || null,
            size: size || null,
            url: url || null,
            raw: {
              html: el.innerHTML.substring(0, 500) // Store first 500 chars for debugging
            }
          });
        } catch (e) {
          console.error('Error parsing product:', e);
        }
      });

      return results;
    });

    console.log(`  📦 Found ${products.length} products`);
    return products;

  } catch (error) {
    console.error(`  ❌ Error scraping ${dispensary.name}:`, error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

// Filter products to only include Ace Solventless products
function filterAceProducts(products) {
  const aceKeywords = [
    'ace solventless',
    'ace',
    // Add more keywords/product names as needed
  ];

  return products.filter(product => {
    const searchText = `${product.name} ${product.brand || ''}`.toLowerCase();
    return aceKeywords.some(keyword => searchText.includes(keyword.toLowerCase()));
  });
}

module.exports = {
  scrapeDispensary,
  filterAceProducts
};
