const { createClient } = require('@supabase/supabase-js');
const { normalizeProductName, extractEffectType } = require('./normalizer');
const { isExcludedProduct } = require('./exclusions');

/**
 * Canonicalize an effect type string from a scraper into one of the five
 * allowed values for product_availability.effect_type. Returns null for
 * unknown/empty inputs.
 */
function canonicalizeEffectType(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (!v) return null;

  if (/indica.*hybrid|hybrid.*indica|indica\s*dominant/.test(v)) return 'indica-hybrid';
  if (/sativa.*hybrid|hybrid.*sativa|sativa\s*dominant/.test(v)) return 'sativa-hybrid';
  if (v === 'hybrid' || /^hybrid$/.test(v)) return 'hybrid';
  if (v === 'indica') return 'indica';
  if (v === 'sativa') return 'sativa';
  return null;
}

/**
 * Infer a canonical category from the normalized product name. Runs as a
 * fallback when the scraper either didn't provide a category (many Jane/
 * Leafbridge cards) or wrote something unhelpful.
 *
 * Because this runs AFTER normalizeProductName, the input is always the
 * canonical ACE product string like "Jackpot Infused Syrup - Salted Caramel"
 * or "Sesh Stick Vape - Orange Pie" — which always contains a category
 * keyword. Order matters: sesh stick before "rosin"/"badder" so vapes
 * with "rosin" in the name don't get classified as Live Rosin.
 */
function inferCategoryFromNormalizedName(normalizedName) {
  if (!normalizedName) return null;
  const n = String(normalizedName).toLowerCase();
  if (n.includes('sesh stick') || n.includes('disposable') || n.includes('vape')) return 'Vape';
  if (n.includes('hash cone')) return 'Infused Preroll';
  if (n.includes('rosin jam') || n.includes('rosin thumbprint') || n.includes('thumbprint')) return 'Live Rosin';
  if (n.includes('cold cured live rosin') || n.includes('live rosin') || n.includes('badder')) return 'Live Rosin';
  if (n.includes('jackpot') || n.includes('syrup') || n.includes('liquid gold') || n.includes('hot sauce') || n.includes('sudden death')) return 'Edible';
  return null;
}

// Initialize Supabase client
function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  }

  return createClient(supabaseUrl, supabaseKey);
}

// Get all enabled dispensaries (all platforms)
// mode: 'fast' = only dispensaries with products, 'zeros' = only without products, 'full' = all
async function getEnabledDispensaries(platform = null, mode = 'full') {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('dispensaries')
    .select('*')
    .eq('scrape_enabled', true);

  // Optionally filter by platform
  if (platform) {
    query = query.eq('menu_platform', platform);
  }

  // Filter based on mode
  if (mode === 'fast') {
    // Only dispensaries that had products last scrape
    query = query.gt('last_product_count', 0);
  } else if (mode === 'zeros') {
    // Only dispensaries that had NO products last scrape (or null)
    query = query.or('last_product_count.eq.0,last_product_count.is.null');
  }
  // 'full' mode = no filter

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching dispensaries:', error);
    throw error;
  }

  return data;
}

// Get a single dispensary by ID
async function getDispensaryById(id) {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('dispensaries')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('Error fetching dispensary:', error);
    throw error;
  }

  return data;
}

// Update dispensary scrape status with consecutive zero protection
// Requires 2+ consecutive zero-product scrapes before setting last_product_count to 0
// This prevents transient scrape failures from excluding dispensaries from fast mode
async function updateDispensaryStatus(dispensaryId, status, errorMessage, productCount) {
  const supabase = getSupabaseClient();

  // First, get current state to check consecutive misses
  const { data: current, error: fetchError } = await supabase
    .from('dispensaries')
    .select('last_product_count, consecutive_misses')
    .eq('id', dispensaryId)
    .single();

  if (fetchError) {
    console.error('Error fetching dispensary:', fetchError);
    // Continue anyway with basic update
  }

  const currentMisses = current?.consecutive_misses || 0;
  const previousCount = current?.last_product_count || 0;

  const updateData = {
    last_scraped_at: new Date().toISOString(),
    last_scrape_status: status,
    last_scrape_error: errorMessage
  };

  // Handle product count updates with consecutive miss protection
  if (productCount !== undefined) {
    if (productCount > 0) {
      // Found products - update count and reset miss streak
      updateData.last_product_count = productCount;
      updateData.consecutive_misses = 0;
    } else {
      // Zero products - check if we should actually set to 0
      const newMissStreak = currentMisses + 1;
      updateData.consecutive_misses = newMissStreak;

      if (newMissStreak >= 2) {
        // Confirmed zero after 2+ consecutive scrapes
        updateData.last_product_count = 0;
        console.log(`  📉 ${newMissStreak} consecutive zero scrapes - confirmed no products`);
      } else if (previousCount > 0) {
        // First zero after having products - don't update yet, wait for confirmation
        console.log(`  ⏳ First zero scrape (had ${previousCount}) - waiting for confirmation`);
        // Don't update last_product_count - preserve previous value
      } else {
        // Already at 0, keep it
        updateData.last_product_count = 0;
      }
    }
  }

  const { error } = await supabase
    .from('dispensaries')
    .update(updateData)
    .eq('id', dispensaryId);

  if (error) {
    console.error('Error updating dispensary status:', error);
    throw error;
  }
}

// Infer/normalize size from normalized product name
// Uses scraped size when available, falls back to defaults for known product types
function inferDefaultSize(normalizedName, existingSize) {
  const nameLower = normalizedName.toLowerCase();

  // Hot sauce always has a fixed size
  if (nameLower.includes('hot sauce') || nameLower.includes('sudden death')) {
    return '8oz - 240mg';
  }

  // Use existing size if available
  if (existingSize) {
    // Jackpot syrups always show as 1oz - 150mg
    if (nameLower.startsWith('jackpot infused syrup')) {
      return '1oz - 150mg';
    }
    return existingSize;
  }

  // Fall back to defaults for known product types
  if (nameLower.startsWith('jackpot infused syrup')) return '1oz - 150mg';
  if (nameLower.startsWith('sesh stick vape')) return '.5g';
  if (nameLower.startsWith('hash cones')) return '2.5g';
  if (nameLower.startsWith('cold cured live rosin')) return '2g';
  if (nameLower.startsWith('rosin jam')) return '2g';
  if (nameLower.startsWith('rosin thumbprint')) return '2g';

  return null;
}

// Generate unique product key for matching
function getProductKey(productName, size) {
  return `${productName}|${size || 'default'}`;
}

// Smart upsert: tracks product history instead of delete+insert
// Returns change summary for alerting system
// `vocab` comes from loadVocabulary() — see lib/vocabulary.js
async function upsertProductAvailability(dispensaryId, products, vocab) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  // Track changes for alerting
  const changes = {
    inserted: 0,
    updated: 0,
    markedOutOfStock: [],
    returnedInStock: [],
    likelyScrapeFailure: false  // Flag to preserve last_product_count
  };

  // 1. Get existing products for this dispensary
  const { data: existingProducts, error: fetchError } = await supabase
    .from('product_availability')
    .select('id, scraped_product_name, scraped_size, in_stock, out_of_stock_since, consecutive_misses')
    .eq('dispensary_id', dispensaryId);

  if (fetchError) {
    console.error('Error fetching existing products:', fetchError);
    throw fetchError;
  }

  // Build map of existing products by key
  const existingMap = new Map();
  (existingProducts || []).forEach(p => {
    const key = getProductKey(p.scraped_product_name, p.scraped_size);
    existingMap.set(key, p);
  });

  // Safety net: drop excluded products (Stellar collabs, employee samples,
  // etc.) before any normalization or DB write happens.
  const beforeExclude = products.length;
  products = products.filter(p => !isExcludedProduct(p.name, p.brand));
  if (products.length !== beforeExclude) {
    console.log(`  🚫 Excluded ${beforeExclude - products.length} disallowed product(s) at upsert boundary`);
  }

  // 2. Prepare scraped products with normalized names
  const scrapedProducts = products.map(product => {
    const rawName = product.name;
    const size = product.size || null;
    const normalizedName = normalizeProductName(rawName, size, vocab);
    const finalSize = inferDefaultSize(normalizedName, size);

    // Effect type: prefer a structured value provided by the platform
    // scraper, fall back to regex extraction from the raw name.
    let effectType =
      canonicalizeEffectType(product.effectType || product.strainType) ||
      extractEffectType(rawName) ||
      null;

    // Category: prefer whatever the scraper provided (already canonicalized
    // on a per-platform basis), fall back to name-keyword inference on the
    // normalized name. The normalized name is always in canonical form so
    // the keywords ("sesh stick", "jackpot", "syrup", etc.) reliably match.
    const finalCategory = product.category || inferCategoryFromNormalizedName(normalizedName) || null;

    // Default: ACE edibles (Jackpot syrups, Sudden Death hot sauce) are
    // made in batches that often mix or rotate strain inputs, so most
    // dispensary menus don't display a strain-type pill for them. In
    // practice these are predominantly hybrid infusions, so when no
    // effect was captured from platform metadata AND the category is
    // Edible, default to hybrid so the UI badge isn't missing. Flower-
    // adjacent rows (concentrate, vape, preroll) stay null unless
    // detected from real data.
    if (!effectType && finalCategory === 'Edible') {
      effectType = 'hybrid';
    }

    return {
      dispensary_id: dispensaryId,
      scraped_product_name: normalizedName,
      scraped_brand: product.brand || null,
      scraped_category: finalCategory,
      effect_type: effectType,
      scraped_price: product.price || null,
      scraped_size: finalSize,
      in_stock: true,
      menu_url: product.url || null,
      raw_data: { ...product.raw, originalName: rawName },
      scraped_at: now,
      last_seen_at: now,
      key: getProductKey(normalizedName, finalSize) // Temporary for matching
    };
  });

  // Track which existing products were found in scrape
  const foundKeys = new Set();
  // Track products we've already processed in THIS scrape to prevent duplicates
  const processedInThisScrape = new Set();

  // 3. Process each scraped product
  const toInsert = [];
  const toUpdate = [];

  for (const product of scrapedProducts) {
    const key = product.key;
    delete product.key; // Remove temporary key before DB operations

    // Skip duplicates within the same scrape
    if (processedInThisScrape.has(key)) {
      continue;
    }
    processedInThisScrape.add(key);
    foundKeys.add(key);

    const existing = existingMap.get(key);

    if (existing) {
      // Product exists - update it
      const updateData = {
        scraped_brand: product.scraped_brand,
        scraped_category: product.scraped_category,
        effect_type: product.effect_type,
        scraped_price: product.scraped_price,
        menu_url: product.menu_url,
        raw_data: product.raw_data,
        scraped_at: now,
        last_seen_at: now,
        in_stock: true,
        out_of_stock_since: null, // Clear if was out of stock
        consecutive_misses: 0 // Reset miss counter when product is found
      };

      // Check if product is returning to stock
      if (!existing.in_stock && existing.out_of_stock_since) {
        changes.returnedInStock.push({
          name: product.scraped_product_name,
          size: product.scraped_size,
          wasOutOfStockSince: existing.out_of_stock_since
        });
      }

      toUpdate.push({ id: existing.id, data: updateData });
      changes.updated++;
    } else {
      // New product - insert it
      product.first_seen_at = now;
      toInsert.push(product);
      changes.inserted++;
    }
  }

  // 4. Mark products NOT in scrape as out of stock
  // SAFETY: If scrape returned 0 products but we had existing products,
  // this is likely a scrape failure - don't mark everything as out of stock
  const isLikelyScrapeFailure = scrapedProducts.length === 0 && existingMap.size > 0;

  if (isLikelyScrapeFailure) {
    console.log(`⚠️ Scrape returned 0 products but ${existingMap.size} existed - skipping out-of-stock marking (likely scrape failure)`);
    changes.likelyScrapeFailure = true;
  } else {
    for (const [key, existing] of existingMap) {
      if (!foundKeys.has(key)) {
        // Product was not in this scrape
        const currentMisses = (existing.consecutive_misses || 0) + 1;

        // DOUBLE VERIFICATION: Only mark out of stock after 2+ consecutive misses
        // This prevents false positives from single scrape failures
        if (currentMisses >= 2) {
          // Confirmed missing - mark as out of stock
          if (existing.in_stock) {
            const updateData = {
              in_stock: false,
              out_of_stock_since: existing.out_of_stock_since || now,
              consecutive_misses: currentMisses
            };

            toUpdate.push({ id: existing.id, data: updateData });

            changes.markedOutOfStock.push({
              name: existing.scraped_product_name,
              size: existing.scraped_size,
              outOfStockSince: now
            });
          } else if (currentMisses <= 3) {
            // Already out of stock - increment miss counter up to 3 then stop
            toUpdate.push({
              id: existing.id,
              data: { consecutive_misses: currentMisses }
            });
          }
        } else {
          // First miss - just increment counter, don't mark out of stock yet
          console.log(`  ⚠️ ${existing.scraped_product_name} not found (miss #${currentMisses}) - waiting for verification`);
          toUpdate.push({
            id: existing.id,
            data: { consecutive_misses: currentMisses }
          });
        }
      }
    }
  }

  // 5. Execute batch inserts
  if (toInsert.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      const { error } = await supabase
        .from('product_availability')
        .insert(batch);

      if (error) {
        console.error('Error inserting products:', error);
        throw error;
      }
    }
  }

  // 6. Execute batch updates
  for (const { id, data } of toUpdate) {
    const { error } = await supabase
      .from('product_availability')
      .update(data)
      .eq('id', id);

    if (error) {
      console.error('Error updating product:', error);
      // Don't throw - continue with other updates
    }
  }

  // Log summary
  if (changes.markedOutOfStock.length > 0) {
    console.log(`  📉 ${changes.markedOutOfStock.length} product(s) went out of stock`);
  }
  if (changes.returnedInStock.length > 0) {
    console.log(`  📈 ${changes.returnedInStock.length} product(s) back in stock`);
  }

  return {
    total: scrapedProducts.length,
    ...changes
  };
}

// Update dispensary platform (e.g., dutchie -> dutchie-plus)
async function updateDispensaryPlatform(dispensaryId, platform) {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('dispensaries')
    .update({ menu_platform: platform })
    .eq('id', dispensaryId);

  if (error) {
    console.error('Error updating dispensary platform:', error);
    throw error;
  }
}

// Save the working scrape config for a dispensary
async function updateScrapeConfig(dispensaryId, config) {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('dispensaries')
    .update({ scrape_config: config })
    .eq('id', dispensaryId);

  if (error) {
    console.error('Error updating scrape config:', error);
    throw error;
  }
}

module.exports = {
  getSupabaseClient,
  getEnabledDispensaries,
  getDispensaryById,
  updateDispensaryStatus,
  upsertProductAvailability,
  updateDispensaryPlatform,
  updateScrapeConfig
};
