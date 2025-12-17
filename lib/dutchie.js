const puppeteer = require('puppeteer');

// Add Ace Solventless filter parameters to Dutchie URL
function addAceFilters(url) {
  const urlObj = new URL(url);

  // Dutchie filter parameters for Ace Solventless
  const aceParams = {
    'dtche[path]': 'products',
    'dtche[brands]': 'ace-solventless',
    'dtche[search]': 'ace'
  };

  // Only add params if not already present
  for (const [key, value] of Object.entries(aceParams)) {
    if (!urlObj.searchParams.has(key)) {
      urlObj.searchParams.set(key, value);
    }
  }

  return urlObj.toString();
}

// Scrape a Dutchie-powered dispensary menu
async function scrapeDispensary(dispensary) {
  // Add Ace Solventless filters to the URL
  const menuUrl = addAceFilters(dispensary.menu_url);
  console.log(`  📡 Loading: ${menuUrl}`);

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
    await page.goto(menuUrl, {
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

    // Check for Dutchie iframe and switch to it if found
    let targetFrame = page;
    try {
      // Look for Dutchie iframe
      const iframeSelectors = [
        'iframe[src*="dutchie"]',
        'iframe[src*="dtche"]',
        'iframe[id*="dutchie"]',
        'iframe[class*="dutchie"]',
        'iframe[src*="embedded-menu"]'
      ];

      for (const selector of iframeSelectors) {
        const iframeElement = await page.$(selector);
        if (iframeElement) {
          console.log(`  🖼️ Found Dutchie iframe: ${selector}`);
          const frame = await iframeElement.contentFrame();
          if (frame) {
            targetFrame = frame;
            console.log('  ✅ Switched to iframe context');
            // Wait for iframe React/Flutter app to render (not just load)
            console.log('  ⏳ Waiting for iframe content to render...');
            try {
              await frame.waitForFunction(
                () => {
                  const nextDiv = document.getElementById('__next');
                  const renderTarget = document.getElementById('render-target');
                  // Check if either React (__next) or Flutter (render-target) has content
                  return (nextDiv && nextDiv.children.length > 0) ||
                         (renderTarget && renderTarget.children.length > 0);
                },
                { timeout: 15000 }
              );
              console.log('  ✅ Iframe content rendered');
            } catch (e) {
              console.log('  ⚠️ Iframe render wait timed out, continuing...');
            }
            // Extra wait for dynamic content
            await new Promise(resolve => setTimeout(resolve, 3000));
            break;
          }
        }
      }

      // If no specific iframe found, check all iframes
      if (targetFrame === page) {
        const frames = page.frames();
        console.log(`  🔍 Found ${frames.length} frames total`);
        for (const frame of frames) {
          const url = frame.url();
          if (url.includes('dutchie') || url.includes('embedded-menu') || url.includes('dtche')) {
            console.log(`  🖼️ Found Dutchie frame by URL: ${url}`);
            targetFrame = frame;
            // Wait for this frame to render too
            console.log('  ⏳ Waiting for frame content to render...');
            try {
              await frame.waitForFunction(
                () => {
                  const nextDiv = document.getElementById('__next');
                  const renderTarget = document.getElementById('render-target');
                  return (nextDiv && nextDiv.children.length > 0) ||
                         (renderTarget && renderTarget.children.length > 0);
                },
                { timeout: 15000 }
              );
              console.log('  ✅ Frame content rendered');
            } catch (e) {
              console.log('  ⚠️ Frame render wait timed out, continuing...');
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
            break;
          }
        }
      }
    } catch (iframeError) {
      console.log('  ⚠️ Iframe detection error:', iframeError.message);
    }

    // Debug: Get page content for analysis
    const bodyHTML = await targetFrame.evaluate(() => document.body.innerHTML.substring(0, 2000));
    console.log(`  📝 Page preview: ${bodyHTML.substring(0, 500)}...`);

    // Wait for Dutchie menu to load
    // Use the actual Dutchie selectors we found
    await targetFrame.waitForSelector('[data-testid="product-list-item"], [data-testid="product-card"], [class*="full-card__Wrapper"]', {
      timeout: 45000
    }).catch(() => {
      console.log('  ⚠️ No product cards found, trying alternative selectors...');
    });

    // Give extra time for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract products from the page (or iframe)
    const products = await targetFrame.evaluate(() => {
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

          // Extract size/weight from option selector or details
          // Dutchie uses optionstyles__Option for size options
          const sizeEl = el.querySelector('[class*="optionstyles__Option"]');
          let size = sizeEl?.textContent?.trim() || null;

          // Fallback to extracting from details if option selector not found
          if (!size) {
            const detailsEl = el.querySelector('[class*="full-card__Details"]');
            const detailsText = detailsEl?.textContent?.trim();
            // Try to extract weight (e.g., "1g", "3.5g", "1/8oz")
            const sizeMatch = detailsText?.match(/[\d.]+\s*(g|oz|mg|ml)/i);
            size = sizeMatch ? sizeMatch[0] : null;
          }

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

    console.log(`  📦 Found ${products.length} products (unfiltered)`);

    // Filter to only Ace Solventless products (in case Dutchie filter didn't work)
    const aceProducts = filterAceProducts(products);
    console.log(`  🎯 ${aceProducts.length} Ace Solventless products after filtering`);

    return aceProducts;

  } catch (error) {
    console.error(`  ❌ Error scraping ${dispensary.name}:`, error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

// Filter products to only include Ace Solventless products
function filterAceProducts(products) {
  return products.filter(product => {
    const brand = (product.brand || '').toLowerCase();

    // Primary check: brand must be "ace solventless" or "ace"
    if (brand.includes('ace solventless') || brand === 'ace') {
      return true;
    }

    // Check for "ace" as standalone word in brand (e.g., "Ace Live Rosin")
    const acePattern = /\bace\b/i;
    if (acePattern.test(brand)) {
      return true;
    }

    // Fallback: check product name for "ace solventless" (some products may have it in name)
    const name = (product.name || '').toLowerCase();
    if (name.includes('ace solventless')) {
      return true;
    }

    return false;
  });
}

module.exports = {
  scrapeDispensary,
  filterAceProducts
};
