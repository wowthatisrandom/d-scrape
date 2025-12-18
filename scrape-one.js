// Scrape a single dispensary by ID
const { scrapeDispensary } = require('./lib/scrapers');
const { getDispensaryById, updateDispensaryStatus, upsertProductAvailability } = require('./lib/supabase');

async function main() {
  const dispensaryId = process.argv[2];

  if (!dispensaryId) {
    console.error('Usage: node scrape-one.js <dispensary-id>');
    console.error('Example: node scrape-one.js 123e4567-e89b-12d3-a456-426614174000');
    process.exit(1);
  }

  console.log(`🔍 Fetching dispensary: ${dispensaryId}`);

  try {
    const dispensary = await getDispensaryById(dispensaryId);

    if (!dispensary) {
      console.error('❌ Dispensary not found');
      process.exit(1);
    }

    console.log(`🏪 Scraping: ${dispensary.name}`);
    console.log(`   URL: ${dispensary.menu_url}`);
    console.log(`   Platform: ${dispensary.menu_platform}`);

    const scraperOptions = {
      brandFilter: 'ace'
    };

    const products = await scrapeDispensary(dispensary, scraperOptions);

    if (products && products.length > 0) {
      console.log(`\n✅ Found ${products.length} products:`);
      products.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.name}`);
      });
    } else {
      console.log(`\n✅ Scrape succeeded - no Ace products found`);
    }

    // Always save to database (upsert deletes old products first)
    await upsertProductAvailability(dispensary.id, products || []);
    await updateDispensaryStatus(dispensary.id, 'success', null, products?.length || 0);
    console.log(`\n💾 Saved to database`);

    process.exit(0);

  } catch (error) {
    console.error(`\n❌ Scrape failed: ${error.message}`);

    if (dispensaryId) {
      await updateDispensaryStatus(dispensaryId, 'failed', error.message);
    }

    process.exit(1);
  }
}

main();
