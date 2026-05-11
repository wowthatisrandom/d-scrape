/**
 * Find and remove product_availability rows that match the shared exclusion
 * list (Stellar collabs, employee samples, donations, etc.).
 *
 * Usage:
 *   node scripts/cleanup-excluded-products.js          # dry-run (default)
 *   node scripts/cleanup-excluded-products.js --apply  # actually delete
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { getSupabaseClient } = require('../lib/supabase');
const { isExcludedProduct } = require('../lib/exclusions');

const APPLY = process.argv.includes('--apply');

async function main() {
  const supabase = getSupabaseClient();

  // Pull the candidate set with a server-side ilike on the columns we care
  // about so we don't scan every row in the table. We then re-check each
  // candidate against the full exclusion list locally.
  const keywords = ['stellar', 'employee', 'staff sample', 'do not sell', 'demo', 'donation', 'internal use'];
  const orFilter = keywords
    .flatMap(k => [`scraped_product_name.ilike.%${k}%`, `scraped_brand.ilike.%${k}%`])
    .join(',');

  const { data, error } = await supabase
    .from('product_availability')
    .select('id, dispensary_id, scraped_product_name, scraped_brand, in_stock, scraped_price, last_seen_at')
    .or(orFilter);

  if (error) {
    console.error('Query error:', error);
    process.exit(1);
  }

  const matches = (data || []).filter(row =>
    isExcludedProduct(row.scraped_product_name, row.scraped_brand)
  );

  console.log('='.repeat(80));
  console.log(`Excluded product cleanup ${APPLY ? '(APPLY mode)' : '(DRY-RUN — pass --apply to delete)'}`);
  console.log('='.repeat(80));
  console.log(`Candidates returned by ilike pre-filter: ${data?.length || 0}`);
  console.log(`Confirmed exclusion matches:             ${matches.length}\n`);

  if (matches.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const row of matches) {
    const stock = row.in_stock ? 'IN STOCK ' : 'OUT      ';
    const price = row.scraped_price != null ? `$${row.scraped_price}` : '—';
    console.log(`${stock} ${price.padStart(8)}  brand="${row.scraped_brand || ''}"  name="${row.scraped_product_name}"  disp=${row.dispensary_id}`);
  }
  console.log('');

  if (!APPLY) {
    console.log(`Re-run with --apply to delete these ${matches.length} row(s).`);
    return;
  }

  const ids = matches.map(r => r.id);
  const { error: delError, count } = await supabase
    .from('product_availability')
    .delete({ count: 'exact' })
    .in('id', ids);

  if (delError) {
    console.error('Delete error:', delError);
    process.exit(1);
  }

  console.log(`✅ Deleted ${count ?? ids.length} row(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
