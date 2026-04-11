// Discover and save store_slugs for all dutchie dispensaries
// Uses the real DutchieScraper with proper age gate handling and stealth

const DutchieScraper = require('./lib/scrapers/dutchie');
const { getSupabaseClient, updateScrapeConfig } = require('./lib/supabase');

// Dispensaries that share a single Dutchie iframe across all locations
// These should NOT have store_slug saved - they need iframe mode to get location-specific data
const SHARED_IFRAME_PATTERNS = [
  'kind goods'  // All Kind Goods locations share one Dutchie embed
];

async function main() {
  const supabase = getSupabaseClient();
  const args = process.argv.slice(2);
  const includeAll = args.includes('--all');
  const idsArg = args.find(arg => arg.startsWith('--ids='));
  const targetIds = idsArg
    ? idsArg.replace('--ids=', '').split(',').map(id => id.trim()).filter(Boolean)
    : [];

  // Get enabled dutchie dispensaries that don't have store_slug
  // Note: dutchie-plus uses GraphQL API with retailerId, not store_slug
  const { data: dispensaries, error } = await supabase
    .from('dispensaries')
    .select('*')
    .eq('menu_platform', 'dutchie')
    .eq('scrape_enabled', true);

  if (error) throw error;

  // Filter to those without store_slug, excluding shared-iframe dispensaries
  const excluded = [];
  const needsSlug = dispensaries.filter(d => {
    if (targetIds.length > 0) {
      return targetIds.includes(d.id);
    }

    if (!includeAll && d.scrape_config?.store_slug) return false;

    // Skip dispensaries that share iframes across locations
    const nameLower = d.name.toLowerCase();
    for (const pattern of SHARED_IFRAME_PATTERNS) {
      if (nameLower.includes(pattern)) {
        excluded.push(d.name);
        return false;
      }
    }
    return true;
  });

  const modeLabel = targetIds.length > 0
    ? `matching requested IDs (${targetIds.length})`
    : includeAll
      ? 'for rediscovery'
      : 'needing store_slug';

  console.log(`\n🔍 Found ${needsSlug.length} dutchie dispensaries ${modeLabel}`);
  if (excluded.length > 0) {
    console.log(`⏭️ Skipping ${excluded.length} shared-iframe dispensaries: ${excluded.join(', ')}`);
  }
  console.log('');

  let success = 0, failed = 0;

  for (const dispensary of needsSlug) {
    process.stdout.write(`${dispensary.name}... `);

    const scraper = new DutchieScraper({ brandFilter: 'ace' });
    const browser = await scraper.launchBrowser();

    try {
      const page = await scraper.createPage(browser);

      // Try filtered_menu_url first (more likely to have iframe params), then menu_url
      const sources = [
        { url: dispensary.filtered_menu_url, label: 'filtered_menu_url' },
        { url: dispensary.menu_url, label: 'menu_url' }
      ];

      let storeSlug = null;

      for (const source of sources) {
        if (!source.url) continue;

        try {
          const result = await scraper.discoverStoreSlug(page, source.url, source.label, null);
          if (result.storeSlug) {
            storeSlug = result.storeSlug;
            break;
          }
        } catch (e) {
          // Continue to next source on error
        }
      }

      if (storeSlug) {
        const newConfig = {
          ...dispensary.scrape_config,
          store_slug: storeSlug
        };
        await updateScrapeConfig(dispensary.id, newConfig);
        console.log(`✅ ${storeSlug}`);
        success++;
      } else {
        console.log(`⚠️ No iframe found`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      failed++;
    } finally {
      await browser.close();
    }
  }

  console.log(`\n✅ Done: ${success} discovered, ${failed} failed\n`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
