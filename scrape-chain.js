// Scrape all dispensaries matching a chain name pattern
const { scrapeDispensary } = require('./lib/scrapers');
const { getSupabaseClient, updateDispensaryStatus, upsertProductAvailability } = require('./lib/supabase');

async function listChains() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('dispensaries')
    .select('id, name, menu_platform, scrape_enabled, last_product_count, last_scrape_status')
    .eq('scrape_enabled', true)
    .order('name');

  if (error) throw error;

  // Group by chain (first part of name before " - ")
  const chains = {};
  data.forEach(d => {
    const chain = d.name.split(' - ')[0].trim();
    if (!chains[chain]) chains[chain] = [];
    chains[chain].push(d);
  });

  console.log('\n📋 Dispensary Chains:\n');
  Object.keys(chains).sort().forEach(chain => {
    const locations = chains[chain];
    const withProducts = locations.filter(l => l.last_product_count > 0).length;
    console.log(`${chain} (${locations.length} locations, ${withProducts} with products)`);
    locations.forEach(l => {
      const status = l.last_product_count > 0 ? `✅ ${l.last_product_count} products` : '⚪ 0 products';
      console.log(`   - ${l.name} [${l.menu_platform}] ${status}`);
    });
    console.log('');
  });
}

async function scrapeChain(chainPattern) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('dispensaries')
    .select('*')
    .eq('scrape_enabled', true)
    .ilike('name', `%${chainPattern}%`)
    .order('name');

  if (error) throw error;

  if (data.length === 0) {
    console.log(`❌ No dispensaries found matching "${chainPattern}"`);
    process.exit(1);
  }

  console.log(`\n🔍 Found ${data.length} dispensaries matching "${chainPattern}":\n`);
  data.forEach(d => console.log(`   - ${d.name} [${d.menu_platform}]`));
  console.log('');

  const results = { success: 0, failed: 0, products: 0 };

  // Track discovered format per platform to reuse for rest of chain
  let discoveredFormat = null;

  for (const dispensary of data) {
    console.log(`\n🏪 Scraping: ${dispensary.name} (${dispensary.menu_platform})`);
    console.log(`   URL: ${dispensary.menu_url}`);

    try {
      // First dispensary: rediscover format. Rest: use discovered format if available
      const scraperOptions = { brandFilter: 'ace' };

      if (discoveredFormat && dispensary.menu_platform === discoveredFormat.platform) {
        // Reuse the format we found for this chain
        console.log(`   📋 Using chain format: ${discoveredFormat.format} (brand: ${discoveredFormat.brandSlug || 'auto'})`);
        scraperOptions.useFormat = discoveredFormat.format;
        if (discoveredFormat.brandSlug) {
          scraperOptions.useBrandSlug = discoveredFormat.brandSlug;
        }
      } else {
        // First one or different platform - rediscover
        scraperOptions.rediscover = true;
      }

      const { products, usedFormat, brandSlug } = await scrapeDispensary(dispensary, scraperOptions);

      // If this was a rediscover and we found products, save the format for the chain
      if (scraperOptions.rediscover && products && products.length > 0 && usedFormat) {
        discoveredFormat = { platform: dispensary.menu_platform, format: usedFormat, brandSlug };
        console.log(`   🔗 Chain format discovered: ${usedFormat} (brand: ${brandSlug || 'auto'})`);
      }

      await upsertProductAvailability(dispensary.id, products || []);
      await updateDispensaryStatus(dispensary.id, 'success', null, products?.length || 0);

      if (products && products.length > 0) {
        console.log(`   ✅ Found ${products.length} products`);
        products.forEach(p => console.log(`      - ${p.name}`));
        results.products += products.length;
      } else {
        console.log(`   ⚪ No Ace products found`);
      }
      results.success++;
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}`);
      await updateDispensaryStatus(dispensary.id, 'failed', err.message);
      results.failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Done: ${results.success} succeeded, ${results.failed} failed, ${results.products} total products`);
}

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === '--list') {
    await listChains();
  } else {
    await scrapeChain(arg);
  }
}

main().catch(err => {
  console.error('💥 Error:', err.message);
  process.exit(1);
});
