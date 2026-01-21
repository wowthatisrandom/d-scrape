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
      navigationRetries: 3,
      retryBaseDelay: 5000,
      retryMaxDelay: 30000,
      retryableErrors: ['Navigation timeout', 'net::ERR_', 'ECONNRESET', 'ETIMEDOUT'],
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
   * Check if an error is retryable (transient network/timeout issue)
   */
  isRetryableError(error) {
    const message = error.message || '';
    return this.options.retryableErrors.some(pattern => message.includes(pattern));
  }

  /**
   * Navigate to a URL with automatic retry for transient errors
   * Uses exponential backoff between attempts
   */
  async navigateWithRetry(page, url, options = {}) {
    const maxAttempts = this.options.navigationRetries;
    const baseDelay = this.options.retryBaseDelay;
    const maxDelay = this.options.retryMaxDelay;

    const navOptions = {
      waitUntil: 'networkidle2',
      timeout: this.options.timeout,
      ...options
    };

    console.log(`  Navigating to: ${url}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await page.goto(url, navOptions);
        if (attempt > 1) {
          console.log(`  ✅ Page loaded successfully on retry ${attempt}`);
        }
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        const isLastAttempt = attempt === maxAttempts;

        if (!isRetryable || isLastAttempt) {
          // Non-retryable error or exhausted all retries
          if (isLastAttempt && isRetryable) {
            console.log(`  ❌ Navigation failed after ${maxAttempts} attempts: ${error.message}`);
          }
          throw error;
        }

        // Calculate exponential backoff delay
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);

        console.log(`  ⚠️ Navigation failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
        console.log(`  ⏳ Retrying in ${delay / 1000}s...`);

        await this.wait(delay);

        console.log(`  🔄 Retry ${attempt + 1}/${maxAttempts}: Navigating to: ${url}`);
      }
    }
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
      // Check for age gate by various indicators
      const hasAgeGate = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('are you 21') ||
               text.includes('are you 18') ||
               text.includes('age verification') ||
               text.includes('verify your age') ||
               text.includes('21+') ||
               text.includes('18+') ||
               document.querySelector('[class*="age-gate"], [class*="age-verification"], [class*="AgeGate"]');
      });

      if (hasAgeGate) {
        console.log('  🚪 Age gate detected, attempting to bypass...');

        // Try clicking by text content first (most reliable)
        const clicked = await page.evaluate(() => {
          // Look for buttons and links
          const elements = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]');

          for (const el of elements) {
            const text = (el.textContent || el.value || '').toLowerCase().trim();
            const href = el.href || '';

            // Skip "No" or redirect links
            if (text.includes('no') || text.includes('nope') || text.includes('exit')) continue;
            if (href && !href.includes('#') && !href.includes(window.location.hostname)) continue;

            // Click affirmative buttons
            if (text === 'yes' ||
                text.includes('i am 21') ||
                text.includes('i am 18') ||
                text.includes('i\'m 21') ||
                text.includes('i\'m 18') ||
                text === 'enter' ||
                text.includes('enter site') ||
                text.includes('agree') ||
                text.includes('confirm') ||
                text.includes('continue')) {
              el.click();
              console.log('Clicked age gate element with text:', text);
              return true;
            }
          }

          // Fallback: click any element in an age gate container
          const ageGateContainer = document.querySelector('[class*="age-gate"], [class*="age-verification"], [class*="AgeGate"], [class*="modal"]');
          if (ageGateContainer) {
            const btns = ageGateContainer.querySelectorAll('button, a');
            for (const btn of btns) {
              const text = btn.textContent?.toLowerCase() || '';
              if (!text.includes('no') && !text.includes('exit')) {
                btn.click();
                return true;
              }
            }
          }

          return false;
        });

        if (clicked) {
          console.log('  ✅ Clicked age gate button');
        } else {
          console.log('  ⚠️ Could not find age gate button to click');
        }

        // Wait for page to fully load after bypassing age gate
        await this.wait(3000);

        // Check if age gate is still there and try again
        const stillHasGate = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('are you 21') || text.includes('are you 18');
        });

        if (stillHasGate) {
          console.log('  🔄 Age gate still present, trying again...');
          await page.evaluate(() => {
            const elements = document.querySelectorAll('button, a');
            for (const el of elements) {
              const text = (el.textContent || '').toLowerCase().trim();
              if (text === 'yes' || text.includes('enter') || text.includes('21') || text.includes('18')) {
                el.click();
                return;
              }
            }
          });
          await this.wait(3000);
        }
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
