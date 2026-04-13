/**
 * One-shot backfill for product_availability.effect_type on rows that were
 * scraped before the effect-type feature landed.
 *
 * For each row where effect_type IS NULL, this:
 *   1. Extracts an effect type from scraped_product_name via extractEffectType
 *   2. Strips leading/trailing effect tokens from scraped_product_name via stripEffectType
 *   3. If either changed, updates the row
 *
 * The original scraped name is preserved in raw_data.originalName — the
 * upsert layer writes it there on every scrape — so this backfill loses
 * no information.
 *
 * MUST run AFTER the Supabase migration that adds effect_type, and
 * BEFORE the next production scrape cycle. The scrape layer builds the
 * product-matching key from the normalized name, so letting a scrape
 * run first would cause duplicate product cards for ~2 cycles while old
 * rows with the stale name age out.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/backfill-effect-type.js --dry-run
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/backfill-effect-type.js
 *
 * --dry-run: print proposed changes, write nothing.
 */

const { getSupabaseClient } = require('../lib/supabase');
const { extractEffectType, stripEffectType } = require('../lib/normalizer');

const BATCH_SIZE = 50;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('🔍 DRY RUN — no writes');
  } else {
    console.log('✍️  LIVE RUN — will update rows');
  }

  const supabase = getSupabaseClient();

  // Page through rows where effect_type is null so we don't blow up memory
  // on a large table. Supabase's JS client has a 1000-row default limit.
  const PAGE_SIZE = 1000;
  let offset = 0;
  let totalScanned = 0;
  let totalWithEffect = 0;
  let totalWithNameChange = 0;
  const updates = [];

  while (true) {
    const { data, error } = await supabase
      .from('product_availability')
      .select('id, scraped_product_name')
      .is('effect_type', null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error('Fetch error:', error);
      process.exit(1);
    }

    if (!data || data.length === 0) break;

    for (const row of data) {
      totalScanned++;
      const originalName = row.scraped_product_name || '';
      const effect = extractEffectType(originalName);
      const newName = stripEffectType(originalName);

      const nameChanged = newName && newName !== originalName;
      const hasEffect = effect !== null;

      if (!hasEffect && !nameChanged) continue;

      if (hasEffect) totalWithEffect++;
      if (nameChanged) totalWithNameChange++;

      updates.push({
        id: row.id,
        effect_type: effect,
        scraped_product_name: nameChanged ? newName : originalName,
        _originalName: originalName,
      });
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`\n📊 Scan complete`);
  console.log(`   Rows scanned (effect_type IS NULL): ${totalScanned}`);
  console.log(`   Rows with detected effect_type:     ${totalWithEffect}`);
  console.log(`   Rows with name cleanup needed:      ${totalWithNameChange}`);
  console.log(`   Rows to update:                     ${updates.length}`);

  if (updates.length === 0) {
    console.log('\nNothing to backfill. Done.');
    return;
  }

  if (dryRun) {
    console.log('\n📋 Preview of first 20 changes:');
    for (const u of updates.slice(0, 20)) {
      const before = JSON.stringify(u._originalName);
      const after = JSON.stringify(u.scraped_product_name);
      const effect = u.effect_type || '(none)';
      console.log(`   effect=${effect}`);
      console.log(`     before: ${before}`);
      console.log(`     after:  ${after}`);
    }
    if (updates.length > 20) {
      console.log(`   ... and ${updates.length - 20} more`);
    }
    console.log('\nDry run — no writes. Re-run without --dry-run to apply.');
    return;
  }

  console.log(`\n✍️  Writing ${updates.length} updates in batches of ${BATCH_SIZE}...`);
  let written = 0;
  let failed = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (u) => {
      const { error } = await supabase
        .from('product_availability')
        .update({
          effect_type: u.effect_type,
          scraped_product_name: u.scraped_product_name,
        })
        .eq('id', u.id);

      if (error) {
        console.error(`Update failed for id=${u.id}:`, error.message);
        failed++;
      } else {
        written++;
      }
    }));

    console.log(`   ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length} done`);
  }

  console.log(`\n✅ Done. Wrote ${written}, failed ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('💥 Backfill failed:', err);
  process.exit(1);
});
