// Standalone scrape script for GitHub Actions
const { scrapeDispensary, scrapeDispensaryWithDiscovery, getSupportedPlatforms } = require('./lib/scrapers');
const { getSupabaseClient, getEnabledDispensaries, updateDispensaryStatus, upsertProductAvailability } = require('./lib/supabase');
const { loadVocabulary } = require('./lib/vocabulary');

// Parse CLI arguments
const mode = process.argv[2] || 'full';
if (!['fast', 'zeros', 'full'].includes(mode)) {
  console.error('Usage: node scrape.js [fast|zeros|full] [--rediscover]');
  console.error('  fast        - Only dispensaries WITH Ace products (hourly)');
  console.error('  zeros       - Only dispensaries WITHOUT Ace products (every 4h)');
  console.error('  full        - All enabled dispensaries (manual/troubleshooting)');
  console.error('  --rediscover - Force format rediscovery, ignore saved configs');
  process.exit(1);
}

// Check for --rediscover flag
const rediscover = process.argv.includes('--rediscover');

// Max concurrent scrapers (different domains can run in parallel)
// Reduced from 5 to 4 to prevent resource contention during parallel iframe scraping
const MAX_CONCURRENT = 4;

// Breather between dispensaries on the same domain. Sites like thekindgoods.com
// start refusing connections once a queue of 4 stores hammers them back to back,
// and the tail of the queue is what times out.
const SAME_DOMAIN_DELAY_MS = 5000;

// Errors that mean "the site didn't answer this time", not "this dispensary is
// misconfigured". These get a second pass at the end of the run and don't turn
// the whole workflow red on their own.
const TRANSIENT_ERROR_PATTERNS = [
  'Navigation timeout',
  'net::ERR_',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  'Target closed',
  'Session closed',
  'Protocol error'
];

function isTransientError(message = '') {
  return TRANSIENT_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract base domain from URL
 */
function getBaseDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url;
  }
}

/**
 * Group dispensaries by their base domain
 */
function groupByDomain(dispensaries) {
  const groups = {};
  for (const d of dispensaries) {
    const domain = getBaseDomain(d.menu_url);
    if (!groups[domain]) {
      groups[domain] = [];
    }
    groups[domain].push(d);
  }
  return groups;
}

/**
 * Scrape a single dispensary and handle results
 */
async function scrapeOne(dispensary, results, retryQueue, vocab, failureQueue = null) {
  console.log(`\n🏪 Scraping: ${dispensary.name} (${dispensary.menu_platform})`);

  try {
    const scraperOptions = { brandFilter: 'ace', rediscover };
    const { products, needsRetry } = await scrapeDispensary(dispensary, scraperOptions);

    // Upsert products (handles product-level out-of-stock with consecutive misses)
    await upsertProductAvailability(dispensary.id, products || [], vocab);

    // Always report the real count. updateDispensaryStatus has its own 2-strike
    // guard before it zeroes last_product_count, so a one-off bad scrape still
    // can't demote the dispensary — and unlike suppressing the count entirely,
    // this lets a genuinely sold-out store eventually settle at zero.
    await updateDispensaryStatus(dispensary.id, 'success', null, products?.length || 0);
    results.success++;

    const productCount = products?.length || 0;
    results.dispensaryResults.push({ name: dispensary.name, products: productCount, status: 'success' });

    if (productCount > 0) {
      results.products += productCount;
      console.log(`✅ ${dispensary.name}: Found ${productCount} products`);
    } else {
      console.log(`✅ ${dispensary.name}: No Ace products found`);
      // Queue for retry if saved config returned 0 products
      if (needsRetry && retryQueue) {
        retryQueue.push(dispensary);
      }
    }
  } catch (error) {
    const transient = isTransientError(error.message || '');
    console.error(`❌ ${dispensary.name}: ${error.message}`);
    await updateDispensaryStatus(dispensary.id, 'failed', error.message);
    results.failed++;
    results.dispensaryResults.push({ name: dispensary.name, products: 0, status: 'failed', error: error.message, transient });
    results.errors.push({
      dispensary: dispensary.name,
      error: error.message,
      transient
    });

    // Transient failures get one more shot after every domain queue has drained,
    // by which point the site has had time to recover.
    if (transient && failureQueue) {
      console.log(`  🕒 Transient error - queued for a second pass at end of run`);
      failureQueue.push(dispensary);
    }
  }
}

/**
 * Retry a dispensary with full format discovery
 */
async function retryWithDiscovery(dispensary, results, vocab) {
  console.log(`\n🔄 Retrying: ${dispensary.name} (${dispensary.menu_platform})`);

  try {
    const scraperOptions = { brandFilter: 'ace' };
    const products = await scrapeDispensaryWithDiscovery(dispensary, scraperOptions);

    // Update if we found products
    if (products && products.length > 0) {
      await upsertProductAvailability(dispensary.id, products, vocab);
      await updateDispensaryStatus(dispensary.id, 'success', null, products.length);
      results.products += products.length;
      results.retryFound += products.length;

      // Update the dispensary result for the summary table
      const existing = results.dispensaryResults.find(d => d.name === dispensary.name);
      if (existing) {
        existing.products = products.length;
        existing.status = 'success';
      }

      console.log(`✅ ${dispensary.name}: Found ${products.length} products on retry!`);
    } else {
      console.log(`✅ ${dispensary.name}: Confirmed no Ace products`);
    }
  } catch (error) {
    console.error(`❌ ${dispensary.name} retry failed: ${error.message}`);
  }
}

/**
 * Second pass for a dispensary that failed with a transient network error.
 * Runs after every domain queue has drained, so the site has had time to recover.
 * On success it rewrites the earlier failure in the results so the summary and
 * exit code reflect the final state.
 */
async function retryFailedDispensary(dispensary, results, vocab) {
  console.log(`\n🔁 Second pass: ${dispensary.name} (${dispensary.menu_platform})`);

  try {
    const scraperOptions = { brandFilter: 'ace', rediscover };
    const { products } = await scrapeDispensary(dispensary, scraperOptions);
    await upsertProductAvailability(dispensary.id, products || [], vocab);
    await updateDispensaryStatus(dispensary.id, 'success', null, products?.length || 0);

    const productCount = products?.length || 0;
    results.failed--;
    results.success++;
    results.products += productCount;
    results.errors = results.errors.filter(e => e.dispensary !== dispensary.name);

    const existing = results.dispensaryResults.find(d => d.name === dispensary.name);
    if (existing) {
      existing.status = 'success';
      existing.products = productCount;
      delete existing.error;
      delete existing.transient;
    }

    console.log(`✅ ${dispensary.name}: recovered on second pass (${productCount} products)`);
    return true;
  } catch (error) {
    console.error(`❌ ${dispensary.name}: second pass also failed: ${error.message}`);
    await updateDispensaryStatus(dispensary.id, 'failed', error.message);

    // Keep the summary pointing at the most recent error.
    const entry = results.errors.find(e => e.dispensary === dispensary.name);
    if (entry) {
      entry.error = error.message;
      entry.transient = isTransientError(error.message || '');
    }
    const existing = results.dispensaryResults.find(d => d.name === dispensary.name);
    if (existing) {
      existing.error = error.message;
      existing.transient = isTransientError(error.message || '');
    }
    return false;
  }
}

/**
 * Process a domain queue sequentially (one dispensary at a time per domain)
 */
async function processDomainQueue(domain, dispensaries, results, retryQueue, vocab, failureQueue) {
  console.log(`\n📍 Starting domain: ${domain} (${dispensaries.length} dispensaries)`);
  for (const [index, dispensary] of dispensaries.entries()) {
    if (index > 0) {
      await sleep(SAME_DOMAIN_DELAY_MS);
    }
    await scrapeOne(dispensary, results, retryQueue, vocab, failureQueue);
  }
  console.log(`✅ Finished domain: ${domain}`);
}

async function main() {
  console.log(`🚀 Starting ${mode.toUpperCase()} scrape...`);
  if (rediscover) {
    console.log(`🔄 REDISCOVER mode enabled - ignoring saved configs`);
  }
  console.log(`📦 Supported platforms: ${getSupportedPlatforms().join(', ')}`);
  console.log(`⚡ Max concurrent domains: ${MAX_CONCURRENT}`);
  const startTime = Date.now();

  try {
    // Load brand vocabulary once at startup — shared with all upsert calls
    const supabase = getSupabaseClient();
    const vocab = await loadVocabulary(supabase);
    console.log(`📖 Loaded brand vocabulary: ${vocab.strains.length} strains, ${vocab.flavors.length} flavors`);

    const dispensaries = await getEnabledDispensaries(null, mode);

    if (!dispensaries || dispensaries.length === 0) {
      console.log('ℹ️ No dispensaries to scrape');
      process.exit(0);
    }

    // Group by domain for parallel processing
    const domainGroups = groupByDomain(dispensaries);
    const domains = Object.keys(domainGroups);

    // Log stats
    const platformCounts = dispensaries.reduce((acc, d) => {
      acc[d.menu_platform] = (acc[d.menu_platform] || 0) + 1;
      return acc;
    }, {});
    console.log(`📋 Found ${dispensaries.length} dispensaries across ${domains.length} domains`);
    console.log(`   Platforms: ${Object.entries(platformCounts).map(([p, c]) => `${p}(${c})`).join(', ')}`);
    console.log(`   Domains: ${domains.map(d => `${d}(${domainGroups[d].length})`).join(', ')}`);

    const results = {
      success: 0,
      failed: 0,
      products: 0,
      errors: [],
      retryFound: 0,
      dispensaryResults: []  // Track per-dispensary results for summary
    };

    // Queue for dispensaries that need retry (saved config returned 0 products)
    // Skip retry queue in zeros mode - these are already the dispensaries without products
    const retryQueue = mode === 'zeros' ? null : [];

    // Dispensaries that failed with a transient network error - retried once at
    // the end of the run, in every mode.
    const failureQueue = [];

    // Process domains in parallel, but dispensaries within same domain sequentially
    // This avoids hitting the same site simultaneously while maximizing throughput
    const domainQueues = domains.map(domain => ({
      domain,
      dispensaries: domainGroups[domain]
    }));

    // Process up to MAX_CONCURRENT domains at a time
    const activePromises = [];
    let queueIndex = 0;

    while (queueIndex < domainQueues.length || activePromises.length > 0) {
      // Start new domain queues up to MAX_CONCURRENT
      while (activePromises.length < MAX_CONCURRENT && queueIndex < domainQueues.length) {
        const { domain, dispensaries: domainDispensaries } = domainQueues[queueIndex];
        const promise = processDomainQueue(domain, domainDispensaries, results, retryQueue, vocab, failureQueue)
          .then(() => {
            // Remove from active promises when done
            const idx = activePromises.indexOf(promise);
            if (idx > -1) activePromises.splice(idx, 1);
          });
        activePromises.push(promise);
        queueIndex++;
      }

      // Wait for at least one to complete before continuing
      if (activePromises.length > 0) {
        await Promise.race(activePromises);
      }
    }

    // Second pass for transient network failures, once every domain has cooled off
    if (failureQueue.length > 0) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🔁 Second pass: ${failureQueue.length} dispensaries that hit transient network errors`);
      await sleep(SAME_DOMAIN_DELAY_MS);

      for (const dispensary of failureQueue) {
        await retryFailedDispensary(dispensary, results, vocab);
      }
    }

    // Retry pass: re-scrape dispensaries that returned 0 with saved config
    // Skip in zeros mode - retrying would be redundant
    if (retryQueue && retryQueue.length > 0) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🔄 Retry pass: ${retryQueue.length} dispensaries to check with format discovery`);

      for (const dispensary of retryQueue) {
        await retryWithDiscovery(dispensary, results, vocab);
      }
    }

    const duration = Date.now() - startTime;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Scrape complete in ${Math.round(duration / 1000)}s`);
    console.log(`   Success: ${results.success}`);
    console.log(`   Failed: ${results.failed}`);
    console.log(`   Total Products: ${results.products}`);
    if (results.retryFound > 0) {
      console.log(`   Found on retry: ${results.retryFound}`);
    }

    const hardErrors = results.errors.filter(e => !e.transient);
    const transientErrors = results.errors.filter(e => e.transient);

    if (results.errors.length > 0) {
      console.log(`\n❌ Errors:`);
      results.errors.forEach(e => console.log(`   - ${e.dispensary}: ${e.error}${e.transient ? ' (transient)' : ''}`));
    }

    // Print detailed summary table
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 DETAILED RESULTS`);
    console.log(`${'='.repeat(50)}`);

    // Sort by name for consistent output
    const sorted = results.dispensaryResults.sort((a, b) => a.name.localeCompare(b.name));

    // Find max name length for alignment
    const maxLen = Math.max(...sorted.map(d => d.name.length));

    for (const d of sorted) {
      const padding = ' '.repeat(maxLen - d.name.length);
      if (d.status === 'failed') {
        console.log(`❌ ${d.name}${padding} | FAILED`);
      } else if (d.products === 0) {
        console.log(`⚪ ${d.name}${padding} | 0`);
      } else {
        console.log(`✅ ${d.name}${padding} | ${d.products}`);
      }
    }

    console.log(`${'='.repeat(50)}`);
    console.log(`Total: ${results.products} products across ${results.success} dispensaries`);

    // Fail the run for real problems (bad config, unhandled bugs) or a total
    // wipeout. A site that timed out twice while others scraped fine is a flaky
    // site, not a broken scraper - warn, but exit clean so the schedule stays green.
    const totalWipeout = results.success === 0 && results.failed > 0;
    if (hardErrors.length > 0 || totalWipeout) {
      process.exit(1);
    }

    if (transientErrors.length > 0) {
      console.log(`\n⚠️ ${transientErrors.length} dispensary(s) unreachable after a second pass - exiting 0 (transient site errors)`);
    }
    process.exit(0);

  } catch (error) {
    console.error('💥 Scrape failed:', error);
    process.exit(1);
  }
}

main();
