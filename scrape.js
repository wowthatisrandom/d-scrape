// Standalone scrape script for GitHub Actions
const { scrapeDispensary } = require('./lib/dutchie');
const { getEnabledDispensaries, updateDispensaryStatus, upsertProductAvailability } = require('./lib/supabase');

async function main() {
  console.log('🚀 Starting dispensary scrape...');
  const startTime = Date.now();

  try {
    // Get dispensaries to scrape
    const dispensaries = await getEnabledDispensaries();

    if (!dispensaries || dispensaries.length === 0) {
      console.log('ℹ️ No dispensaries to scrape');
      process.exit(0);
    }

    console.log(`📋 Found ${dispensaries.length} dispensaries to scrape`);

    const results = {
      success: 0,
      failed: 0,
      products: 0,
      errors: []
    };

    // Scrape each dispensary
    for (const dispensary of dispensaries) {
      console.log(`\n🏪 Scraping: ${dispensary.name}`);

      try {
        const products = await scrapeDispensary(dispensary);

        if (products && products.length > 0) {
          // Save products to database
          await upsertProductAvailability(dispensary.id, products);

          // Update dispensary status
          await updateDispensaryStatus(dispensary.id, 'success', null);

          results.success++;
          results.products += products.length;
          console.log(`✅ ${dispensary.name}: Found ${products.length} products`);
        } else {
          await updateDispensaryStatus(dispensary.id, 'partial', 'No products found');
          results.success++;
          console.log(`⚠️ ${dispensary.name}: No products found`);
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
