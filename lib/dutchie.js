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
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Handle age verification gate if present
    try {
      const ageGateSelectors = [
        'button:has-text("Yes")',
        'button:has-text("I am 21")',
        'button:has-text("Enter")',
        '[class*="age-gate"] button',
        '[class*="age-verification"] button',
        '.age-gate button',
        'button[class*="enter"]',
        'a[class*="enter"]'
      ];

      // Check if age gate is present
      const ageGate = await page.$('[class*="age-gate"], [class*="age-verification"]');
      if (ageGate) {
        console.log('  🚪 Age gate detected, attempting to bypass...');

        // Try clicking various buttons
        for (const selector of ageGateSelectors) {
          try {
            const button = await page.$(selector);
            if (button) {
              await button.click();
              console.log(`  ✅ Clicked age gate button: ${selector}`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              break;
            }
          } catch (e) {
            // Continue trying other selectors
          }
        }

        // Also try finding button by text content
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, a');
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || '';
            if (text.includes('yes') || text.includes('enter') || text.includes('21') || text.includes('agree')) {
              btn.click();
              return true;
            }
          }
          return false;
        });

        // Wait for page to load after bypassing age gate
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (ageGateError) {
      console.log('  ⚠️ Age gate handling error:', ageGateError.message);
    }

    // Debug: Log page title and URL
    const pageTitle = await page.title();
    const currentUrl = page.url();
    console.log(`  📄 Page title: ${pageTitle}`);
    console.log(`  🔗 Current URL: ${currentUrl}`);

    // Debug: Get page content for analysis
    const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
    console.log(`  📝 Page preview: ${bodyHTML.substring(0, 500)}...`);

    // Wait for Dutchie menu to load
    // Use the actual Dutchie selectors we found
    await page.waitForSelector('[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"]', {
      timeout: 45000
    }).catch(() => {
      console.log('  ⚠️ No product cards found, trying alternative selectors...');
    });

    // Give extra time for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract products from the page
    const products = await page.evaluate(() => {
      const results = [];

      // Use actual Dutchie selectors we found from inspecting
      const selectors = [
        '[data-testid="product-list-item"]',
        '[data-testid="product-card"]',
        '[class*="full-card__Wrapper"]'
      ];

      let productElements = [];
      for (const selector of selectors) {
        productElements = document.querySelectorAll(selector);
        if (productElements.length > 0) {
          console.log(`Found ${productElements.length} products with selector: ${selector}`);
          break;
        }
      }

      productElements.forEach(el => {
        try {
          // Extract product name - Dutchie uses full-card__Name class
          const nameEl = el.querySelector(
            '[class*="full-card__Name"], [class*="ProductName"], [data-testid="product-name"], h3, h4'
          );
          const name = nameEl?.textContent?.trim();

          if (!name) return; // Skip if no name

          // Extract brand - Dutchie uses full-card__Brand class
          const brandEl = el.querySelector(
            '[class*="full-card__Brand"], [class*="ProductBrand"], [data-testid="product-brand"]'
          );
          const brand = brandEl?.textContent?.trim();

          // Extract price - look for price in details or price elements
          const priceEl = el.querySelector(
            '[class*="full-card__Details"], [class*="Price"], [data-testid="product-price"], [class*="price"]'
          );
          const priceText = priceEl?.textContent?.trim();
          // Extract first price found (e.g., "$25" or "$25.00")
          const priceMatch = priceText?.match(/\$[\d.]+/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace('$', '')) : null;

          // Extract category from details
          const categoryEl = el.querySelector(
            '[class*="category"], [data-testid="product-category"]'
          );
          const category = categoryEl?.textContent?.trim();

          // Extract size/weight from details
          const detailsEl = el.querySelector('[class*="full-card__Details"]');
          const detailsText = detailsEl?.textContent?.trim();
          // Try to extract weight (e.g., "1g", "3.5g", "1/8oz")
          const sizeMatch = detailsText?.match(/[\d.]+\s*(g|oz|mg|ml)/i);
          const size = sizeMatch ? sizeMatch[0] : null;

          // Extract product URL - Dutchie uses full-card__Anchor
          const linkEl = el.querySelector('a[href*="/product/"], [class*="full-card__Anchor"]');
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
