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
        '--window-size=1920x1080',
        // Use unique profile to avoid conflicts with parallel scrapers
        `--user-data-dir=/tmp/puppeteer_${Date.now()}_${Math.random().toString(36).slice(2)}`
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

        // First try Puppeteer's native click on known age gate selectors.
        // Native clicks fire trusted events (isTrusted: true) which some
        // age gate libraries (e.g. a11y-dialog on CP Lifted sites) require.
        let clicked = false;
        for (const selector of ['#age-gate-yes', '.age-gate-yes']) {
          try {
            const el = await page.$(selector);
            if (el) {
              await el.click();
              clicked = true;
              console.log('  ✅ Clicked age gate button');
              break;
            }
          } catch (e) { /* selector not found, try next */ }
        }

        // Fall back to text-based clicking via evaluate
        if (!clicked) {
          clicked = await page.evaluate(() => {
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
                  text.includes('yes i am') ||
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
        }

        // Wait for page to process the click
        await this.wait(3000);

        // Handle multi-step age gates (e.g. step 2 for location/menu-type selection)
        await this._handleAgeGateStep2(page);

        // Check if age gate is still there (verify element is actually visible, not just text on page)
        const stillHasGate = await page.evaluate(() => {
          const gate = document.querySelector('#age-gate, .age-gate, [class*="age-gate"], [class*="age-verification"], [class*="AgeGate"]');
          if (gate && gate.getAttribute('aria-hidden') === 'true') return false;
          if (gate && gate.offsetParent === null && getComputedStyle(gate).display === 'none') return false;
          const text = document.body.innerText.toLowerCase();
          return text.includes('are you 21') || text.includes('are you 18');
        });

        if (stillHasGate) {
          console.log('  🔄 Age gate still present, trying again...');
          // Try native click first, then fall back to evaluate
          let retryClicked = false;
          for (const selector of ['#age-gate-yes', '.age-gate-yes']) {
            try {
              const el = await page.$(selector);
              if (el) {
                await el.click();
                retryClicked = true;
                break;
              }
            } catch (e) {}
          }
          if (!retryClicked) {
            await page.evaluate(() => {
              const elements = document.querySelectorAll('button, a');
              for (const el of elements) {
                const text = (el.textContent || '').toLowerCase().trim();
                if (text === 'yes' || text.includes('yes i am') || text.includes('enter') || text.includes('21') || text.includes('18')) {
                  el.click();
                  return;
                }
              }
            });
          }
          await this.wait(3000);
          await this._handleAgeGateStep2(page);
        }
      }
    } catch (error) {
      console.log('  ⚠️ Age gate handling error:', error.message);
    }
  }

  /**
   * Handle step 2 of multi-step age gates (e.g. location or rec/med selection)
   * Used by CP Lifted / cannabis WordPress themes with a11y-dialog
   */
  async _handleAgeGateStep2(page) {
    try {
      const step2Info = await page.evaluate(() => {
        const step2 = document.querySelector('#age-gate-step-2, .age-gate-step.step-2, [class*="age-gate-step"]:nth-child(2)');
        if (!step2) return null;
        // Check if step 2 is visible
        const style = getComputedStyle(step2);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        return { visible: true };
      });

      if (step2Info) {
        console.log('  📋 Age gate step 2 detected, selecting menu...');
        // Try clicking rec/recreational button, or any continue/enter/shop button
        let clicked = false;
        // Try native click on known step 2 selectors
        for (const selector of ['.age-gate-step.step-2 button', '#age-gate-step-2 button', '#age-gate-step-2 a']) {
          try {
            const el = await page.$(selector);
            if (el) {
              await el.click();
              clicked = true;
              console.log('  ✅ Clicked through age gate step 2');
              break;
            }
          } catch (e) {}
        }
        if (!clicked) {
          // Fall back to evaluate-based click targeting rec/continue/enter text
          clicked = await page.evaluate(() => {
            const step2 = document.querySelector('#age-gate-step-2, .age-gate-step.step-2');
            if (!step2) return false;
            const btns = step2.querySelectorAll('button, a, [role="button"]');
            for (const btn of btns) {
              const text = (btn.textContent || '').toLowerCase().trim();
              if (text.includes('rec') || text.includes('enter') || text.includes('continue') || text.includes('shop') || text.includes('21')) {
                btn.click();
                return true;
              }
            }
            // Click first button if none matched by text
            if (btns.length > 0) { btns[0].click(); return true; }
            return false;
          });
          if (clicked) console.log('  ✅ Clicked through age gate step 2');
        }
        if (clicked) await this.wait(2000);
      }
    } catch (e) {
      // Step 2 handling is best-effort
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
