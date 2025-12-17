const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Use stealth plugin to avoid bot detection
puppeteer.use(StealthPlugin());

/**
 * Base scraper class that all platform scrapers extend
 * Provides common browser setup and utility methods
 */
class BaseScraper {
  constructor(options = {}) {
    this.options = {
      headless: 'new',
      timeout: 90000,
      ...options
    };
  }

  /**
   * Launch a Puppeteer browser with standard config and stealth
   */
  async launchBrowser() {
    return puppeteer.launch({
      headless: this.options.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080'
      ]
    });
  }

  /**
   * Create a new page with standard settings
   */
  async createPage(browser) {
    const page = await browser.newPage();

    await page.setViewport({ width: 1920, height: 1080 });

    return page;
  }

  /**
   * Wait for a specified duration
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Handle common age verification gates
   */
  async handleAgeGate(page) {
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

      const ageGate = await page.$('[class*="age-gate"], [class*="age-verification"], [class*="AgeGate"]');
      if (ageGate) {
        console.log('  🚪 Age gate detected, attempting to bypass...');

        for (const selector of ageGateSelectors) {
          try {
            const button = await page.$(selector);
            if (button) {
              await button.click();
              console.log(`  ✅ Clicked age gate button: ${selector}`);
              await this.wait(2000);
              break;
            }
          } catch (e) {
            // Continue trying other selectors
          }
        }

        // Try finding button by text content
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

        // Wait for page to fully load after bypassing age gate
        await this.wait(5000);
      }
    } catch (error) {
      console.log('  ⚠️ Age gate handling error:', error.message);
    }
  }

  /**
   * Main scrape method - must be implemented by subclasses
   * @param {Object} dispensary - The dispensary object from database
   * @returns {Promise<Array>} - Array of product objects
   */
  async scrape(dispensary) {
    throw new Error('scrape() must be implemented by subclass');
  }

  /**
   * Filter products - can be overridden by subclasses
   * Default implementation returns all products
   */
  filterProducts(products) {
    return products;
  }
}

module.exports = BaseScraper;
