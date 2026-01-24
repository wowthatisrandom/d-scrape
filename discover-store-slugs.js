// Quick script to discover and save store_slugs for all dutchie dispensaries
// Doesn't scrape products - just finds the iframe src and extracts the slug

const puppeteer = require('puppeteer');
const { getSupabaseClient, updateScrapeConfig } = require('./lib/supabase');

async function discoverStoreSlug(dispensary) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // Navigate to the dispensary page
    await page.goto(dispensary.menu_url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Try to click age gate if present
    try {
      const ageButton = await page.$('button[class*="age"], button:has-text("Enter"), button:has-text("Yes"), button:has-text("21")');
      if (ageButton) await ageButton.click();
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {}

    // Find Dutchie iframe
    const iframeSelectors = [
      'iframe[src*="dutchie.com"]',
      'iframe[src*="embedded-menu"]'
    ];

    for (const selector of iframeSelectors) {
      const iframe = await page.$(selector);
      if (iframe) {
        const src = await iframe.evaluate(el => el.src);
        if (src && src.includes('embedded-menu')) {
          const match = src.match(/embedded-menu\/([^/]+)/);
          if (match) {
            await browser.close();
            return match[1];
          }
        }
      }
    }

    await browser.close();
    return null;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

async function main() {
  const supabase = getSupabaseClient();

  // Get all dutchie dispensaries that don't have store_slug
  const { data: dispensaries, error } = await supabase
    .from('dispensaries')
    .select('*')
    .eq('menu_platform', 'dutchie')
    .eq('scrape_enabled', true);

  if (error) throw error;

  // Filter to those without store_slug
  const needsSlug = dispensaries.filter(d => !d.scrape_config?.store_slug);

  console.log(`\n🔍 Found ${needsSlug.length} dutchie dispensaries needing store_slug\n`);

  let success = 0, failed = 0;

  for (const dispensary of needsSlug) {
    process.stdout.write(`${dispensary.name}... `);

    try {
      const storeSlug = await discoverStoreSlug(dispensary);

      if (storeSlug) {
        // Save it
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
    }
  }

  console.log(`\n✅ Done: ${success} discovered, ${failed} failed\n`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
