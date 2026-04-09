/**
 * Debug script to analyze what the scraper extracts vs what's in the database
 *
 * Usage:
 *   node scripts/debug-scrape.js --dispensary="Sunrise - Clinton"
 *   node scripts/debug-scrape.js --id=<dispensary-uuid>
 *
 * This script:
 * 1. Loads the dispensary from the database
 * 2. Runs the Dutchie scraper on it
 * 3. Logs each extracted product: raw name, normalized name, size, key
 * 4. Compares to what's currently in the database
 * 5. Identifies mismatches that could cause false positives
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { getSupabaseClient, getDispensaryById, getEnabledDispensaries } = require('../lib/supabase');
const { normalizeProductName } = require('../lib/normalizer');
const DutchieScraper = require('../lib/scrapers/dutchie');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  args.forEach(arg => {
    if (arg.startsWith('--dispensary=')) {
      options.dispensaryName = arg.replace('--dispensary=', '');
    } else if (arg.startsWith('--id=')) {
      options.dispensaryId = arg.replace('--id=', '');
    }
  });

  return options;
}

// Generate the same product key as supabase.js
function getProductKey(productName, size) {
  return `${productName}|${size || 'default'}`;
}

// Infer size (copied from supabase.js for consistency)
function inferDefaultSize(normalizedName, existingSize) {
  const nameLower = normalizedName.toLowerCase();

  // Hot sauce always has a fixed size
  if (nameLower.includes('hot sauce') || nameLower.includes('sudden death')) {
    return '8oz - 240mg';
  }

  if (existingSize) {
    // Jackpot syrups always show as 1oz - 150mg
    if (nameLower.startsWith('jackpot infused syrup')) {
      return '1oz - 150mg';
    }
    return existingSize;
  }

  if (nameLower.startsWith('jackpot infused syrup')) return '1oz - 150mg';
  if (nameLower.startsWith('sesh stick vape')) return '.5g';
  if (nameLower.startsWith('hash cones')) return '2.5g';
  if (nameLower.startsWith('cold cured live rosin')) return '2g';

  return null;
}

async function main() {
  const options = parseArgs();

  if (!options.dispensaryId && !options.dispensaryName) {
    console.log('Usage:');
    console.log('  node scripts/debug-scrape.js --dispensary="Sunrise - Clinton"');
    console.log('  node scripts/debug-scrape.js --id=<dispensary-uuid>');
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  let dispensary;

  // Find dispensary
  if (options.dispensaryId) {
    dispensary = await getDispensaryById(options.dispensaryId);
  } else {
    const { data, error } = await supabase
      .from('dispensaries')
      .select('*')
      .ilike('name', `%${options.dispensaryName}%`)
      .limit(1)
      .single();

    if (error || !data) {
      console.error(`Dispensary not found: ${options.dispensaryName}`);
      process.exit(1);
    }
    dispensary = data;
  }

  console.log('='.repeat(80));
  console.log('DEBUG SCRAPE: ' + dispensary.name);
  console.log('='.repeat(80));
  console.log(`ID: ${dispensary.id}`);
  console.log(`Website: ${dispensary.website}`);
  console.log(`Platform: ${dispensary.menu_platform}`);
  console.log('');

  // Step 1: Get existing products from database
  console.log('📊 STEP 1: Fetching existing products from database...');
  const { data: existingProducts, error: fetchError } = await supabase
    .from('product_availability')
    .select('*')
    .eq('dispensary_id', dispensary.id);

  if (fetchError) {
    console.error('Error fetching products:', fetchError);
    process.exit(1);
  }

  console.log(`Found ${existingProducts.length} products in database\n`);

  // Build lookup map
  const existingByKey = new Map();
  const existingByName = new Map();
  existingProducts.forEach(p => {
    const key = getProductKey(p.scraped_product_name, p.scraped_size);
    existingByKey.set(key, p);
    existingByName.set(p.scraped_product_name.toLowerCase(), p);
  });

  // Show existing products with their status
  console.log('Existing products:');
  existingProducts.forEach(p => {
    const status = p.in_stock ? '✅ IN STOCK' : '❌ OUT OF STOCK';
    const lastSeen = p.last_seen_at ? new Date(p.last_seen_at).toLocaleDateString() : 'never';
    const key = getProductKey(p.scraped_product_name, p.scraped_size);
    console.log(`  ${status} | ${p.scraped_product_name} | ${p.scraped_size || 'no size'}`);
    console.log(`           Last seen: ${lastSeen} | Key: "${key}"`);
    if (!p.in_stock) {
      console.log(`           Consecutive misses: ${p.consecutive_misses || 0}`);
    }
  });
  console.log('');

  // Step 2: Run the scraper
  console.log('🔍 STEP 2: Running scraper...');
  const scraper = new DutchieScraper({ brandFilter: 'ace' });

  try {
    const result = await scraper.scrape(dispensary);

    if (!result || !result.products) {
      console.log('❌ Scraper returned no results');
      await scraper.close();
      process.exit(1);
    }

    const scrapedProducts = result.products;
    console.log(`Scraped ${scrapedProducts.length} products\n`);

    // Step 3: Analyze each scraped product
    console.log('📋 STEP 3: Analyzing scraped products...');
    console.log('-'.repeat(80));

    const matchResults = {
      matched: [],
      notMatched: [],
      newProducts: []
    };

    scrapedProducts.forEach((product, index) => {
      const rawName = product.name;
      const rawSize = product.size;
      const normalizedName = normalizeProductName(rawName, rawSize);
      const finalSize = inferDefaultSize(normalizedName, rawSize);
      const key = getProductKey(normalizedName, finalSize);

      console.log(`\nProduct ${index + 1}:`);
      console.log(`  Raw name:        "${rawName}"`);
      console.log(`  Raw size:        "${rawSize || 'none'}"`);
      console.log(`  Normalized name: "${normalizedName}"`);
      console.log(`  Final size:      "${finalSize || 'default'}"`);
      console.log(`  Generated key:   "${key}"`);

      // Check if this matches an existing product
      const existingByExactKey = existingByKey.get(key);
      if (existingByExactKey) {
        console.log(`  ✅ MATCHES existing product by key`);
        matchResults.matched.push({ scraped: product, existing: existingByExactKey, key });
      } else {
        // Check for close matches by name
        const existingByNameMatch = existingByName.get(normalizedName.toLowerCase());
        if (existingByNameMatch) {
          console.log(`  ⚠️  NAME MATCHES but KEY DIFFERS`);
          console.log(`     Existing key: "${getProductKey(existingByNameMatch.scraped_product_name, existingByNameMatch.scraped_size)}"`);
          console.log(`     Scraped key:  "${key}"`);
          matchResults.notMatched.push({
            scraped: product,
            existing: existingByNameMatch,
            reason: 'size_mismatch',
            scrapedKey: key,
            existingKey: getProductKey(existingByNameMatch.scraped_product_name, existingByNameMatch.scraped_size)
          });
        } else {
          // Check if there's a similar product that SHOULD match
          let foundSimilar = false;
          for (const [existingKey, existingProduct] of existingByKey) {
            // Check if both are the same product type
            const existingNorm = existingProduct.scraped_product_name.toLowerCase();
            const scrapedNorm = normalizedName.toLowerCase();

            // Are they both jackpot syrups with same flavor?
            if (existingNorm.includes('jackpot') && scrapedNorm.includes('jackpot')) {
              // Extract flavors
              const existingFlavor = existingNorm.match(/- (\w+)$/)?.[1];
              const scrapedFlavor = scrapedNorm.match(/- (\w+)$/)?.[1];
              if (existingFlavor && scrapedFlavor && existingFlavor === scrapedFlavor) {
                console.log(`  ❌ SHOULD MATCH but doesn't!`);
                console.log(`     Existing: "${existingProduct.scraped_product_name}" | "${existingProduct.scraped_size}"`);
                console.log(`     Scraped:  "${normalizedName}" | "${finalSize}"`);
                matchResults.notMatched.push({
                  scraped: product,
                  existing: existingProduct,
                  reason: 'normalization_mismatch',
                  scrapedKey: key,
                  existingKey: existingKey
                });
                foundSimilar = true;
                break;
              }
            }
          }

          if (!foundSimilar) {
            console.log(`  🆕 NEW PRODUCT (no existing match)`);
            matchResults.newProducts.push({ scraped: product, key });
          }
        }
      }
    });

    // Step 4: Identify products in DB that weren't scraped (potential false positives)
    console.log('\n' + '='.repeat(80));
    console.log('📉 STEP 4: Products in DB that were NOT scraped (potential false positives):');
    console.log('-'.repeat(80));

    const scrapedKeys = new Set();
    scrapedProducts.forEach(p => {
      const normalizedName = normalizeProductName(p.name, p.size);
      const finalSize = inferDefaultSize(normalizedName, p.size);
      scrapedKeys.add(getProductKey(normalizedName, finalSize));
    });

    let notScrapedCount = 0;
    for (const [key, existingProduct] of existingByKey) {
      if (!scrapedKeys.has(key)) {
        notScrapedCount++;
        const status = existingProduct.in_stock ? '✅ IN STOCK' : '❌ OUT';
        console.log(`  ${status} | "${existingProduct.scraped_product_name}" | "${existingProduct.scraped_size}"`);
        console.log(`         Key: "${key}"`);
        console.log(`         Last seen: ${existingProduct.last_seen_at}`);
      }
    }

    if (notScrapedCount === 0) {
      console.log('  All existing products were found in scrape! ✅');
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY:');
    console.log('='.repeat(80));
    console.log(`  Products in database:    ${existingProducts.length}`);
    console.log(`  Products scraped:        ${scrapedProducts.length}`);
    console.log(`  Matched by key:          ${matchResults.matched.length}`);
    console.log(`  New products:            ${matchResults.newProducts.length}`);
    console.log(`  Key mismatches:          ${matchResults.notMatched.length}`);
    console.log(`  Not scraped (potential false pos): ${notScrapedCount}`);

    if (matchResults.notMatched.length > 0) {
      console.log('\n❗ KEY MISMATCHES REQUIRE ATTENTION:');
      matchResults.notMatched.forEach(({ reason, scrapedKey, existingKey }) => {
        console.log(`  Reason: ${reason}`);
        console.log(`    Existing: ${existingKey}`);
        console.log(`    Scraped:  ${scrapedKey}`);
      });
    }

    // Browser is closed automatically in scrape() finally block

  } catch (error) {
    console.error('Scraper error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
