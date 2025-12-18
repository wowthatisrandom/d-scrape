// Standalone scrape script for GitHub Actions
const { scrapeDispensary, getSupportedPlatforms } = require('./lib/scrapers');
const { getEnabledDispensaries, updateDispensaryStatus, upsertProductAvailability } = require('./lib/supabase');

// Max concurrent scrapers (different domains can run in parallel)
const MAX_CONCURRENT = 5;

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
async function scrapeOne(dispensary, results) {
  console.log(`\n🏪 Scraping: ${dispensary.name} (${dispensary.menu_platform})`);

  try {
    const scraperOptions = { brandFilter: 'ace' };
    const products = await scrapeDispensary(dispensary, scraperOptions);

    if (products && products.length > 0) {
      await upsertProductAvailability(dispensary.id, products);
      await updateDispensaryStatus(dispensary.id, 'success', null, products.length);
      results.success++;
      results.products += products.length;
      console.log(`✅ ${dispensary.name}: Found ${products.length} products`);
    } else {
      await updateDispensaryStatus(dispensary.id, 'success', null, 0);
      results.success++;
      console.log(`✅ ${dispensary.name}: No Ace products found`);
    }
  } catch (error) {
    console.error(`❌ ${dispensary.name}: ${error.message}`);
    await updateDispensaryStatus(dispensary.id, 'failed', error.message);
    results.failed++;
    results.errors.push({
      dispensary: dispensary.name,
      error: error.message
    });
  }
}

/**
 * Process a domain queue sequentially (one dispensary at a time per domain)
 */
async function processDomainQueue(domain, dispensaries, results) {
  console.log(`\n📍 Starting domain: ${domain} (${dispensaries.length} dispensaries)`);
  for (const dispensary of dispensaries) {
    await scrapeOne(dispensary, results);
  }
  console.log(`✅ Finished domain: ${domain}`);
}

async function main() {
  console.log('🚀 Starting dispensary scrape...');
  console.log(`📦 Supported platforms: ${getSupportedPlatforms().join(', ')}`);
  console.log(`⚡ Max concurrent domains: ${MAX_CONCURRENT}`);
  const startTime = Date.now();

  try {
    const dispensaries = await getEnabledDispensaries();

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
      errors: []
    };

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
        const promise = processDomainQueue(domain, domainDispensaries, results)
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

    const duration = Date.now() - startTime;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Scrape complete in ${Math.round(duration / 1000)}s`);
    console.log(`   Success: ${results.success}`);
    console.log(`   Failed: ${results.failed}`);
    console.log(`   Total Products: ${results.products}`);

    if (results.errors.length > 0) {
      console.log(`\n❌ Errors:`);
      results.errors.forEach(e => console.log(`   - ${e.dispensary}: ${e.error}`));
    }

    process.exit(results.failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('💥 Scrape failed:', error);
    process.exit(1);
  }
}

main();
