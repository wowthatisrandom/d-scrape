// Standalone scrape script for GitHub Actions
const { scrapeDispensary, scrapeDispensaryWithDiscovery, getSupportedPlatforms } = require('./lib/scrapers');
const { getEnabledDispensaries, updateDispensaryStatus, upsertProductAvailability } = require('./lib/supabase');

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
async function scrapeOne(dispensary, results, retryQueue) {
  console.log(`\n🏪 Scraping: ${dispensary.name} (${dispensary.menu_platform})`);

  try {
    const scraperOptions = { brandFilter: 'ace', rediscover };
    const { products, needsRetry } = await scrapeDispensary(dispensary, scraperOptions);

    // Upsert products (handles product-level out-of-stock with consecutive misses)
    const upsertResult = await upsertProductAvailability(dispensary.id, products || []);

    // Update status - consecutive zero protection is built into updateDispensaryStatus
    // It requires 2+ consecutive zero scrapes before setting last_product_count to 0
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
    console.error(`❌ ${dispensary.name}: ${error.message}`);
    await updateDispensaryStatus(dispensary.id, 'failed', error.message);
    results.failed++;
    results.dispensaryResults.push({ name: dispensary.name, products: 0, status: 'failed', error: error.message });
    results.errors.push({
      dispensary: dispensary.name,
      error: error.message
    });
  }
}

/**
 * Retry a dispensary with full format discovery
 */
async function retryWithDiscovery(dispensary, results) {
  console.log(`\n🔄 Retrying: ${dispensary.name} (${dispensary.menu_platform})`);

  try {
    const scraperOptions = { brandFilter: 'ace' };
    const products = await scrapeDispensaryWithDiscovery(dispensary, scraperOptions);

    // Update if we found products
    if (products && products.length > 0) {
      await upsertProductAvailability(dispensary.id, products);
      await updateDispensaryStatus(dispensary.id, 'success', null, products.length);
      results.products += products.length;
      results.retryFound += products.length;
      console.log(`✅ ${dispensary.name}: Found ${products.length} products on retry!`);
    } else {
      console.log(`✅ ${dispensary.name}: Confirmed no Ace products`);
    }
  } catch (error) {
    console.error(`❌ ${dispensary.name} retry failed: ${error.message}`);
  }
}

/**
 * Process a domain queue sequentially (one dispensary at a time per domain)
 */
async function processDomainQueue(domain, dispensaries, results, retryQueue) {
  console.log(`\n📍 Starting domain: ${domain} (${dispensaries.length} dispensaries)`);
  for (const dispensary of dispensaries) {
    await scrapeOne(dispensary, results, retryQueue);
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
        const promise = processDomainQueue(domain, domainDispensaries, results, retryQueue)
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

    // Retry pass: re-scrape dispensaries that returned 0 with saved config
    // Skip in zeros mode - retrying would be redundant
    if (retryQueue && retryQueue.length > 0) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🔄 Retry pass: ${retryQueue.length} dispensaries to check with format discovery`);

      for (const dispensary of retryQueue) {
        await retryWithDiscovery(dispensary, results);
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

    if (results.errors.length > 0) {
      console.log(`\n❌ Errors:`);
      results.errors.forEach(e => console.log(`   - ${e.dispensary}: ${e.error}`));
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

    process.exit(results.failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('💥 Scrape failed:', error);
    process.exit(1);
  }
}

main();
