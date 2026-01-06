const { createClient } = require('@supabase/supabase-js');
const { normalizeProductName } = require('./normalizer');

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
async function getEnabledDispensaries(platform = null) {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('dispensaries')
    .select('*')
    .eq('scrape_enabled', true);

  // Optionally filter by platform
  if (platform) {
    query = query.eq('menu_platform', platform);
  }

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

// Update dispensary scrape status
async function updateDispensaryStatus(dispensaryId, status, errorMessage, productCount = null) {
  const supabase = getSupabaseClient();

  const updateData = {
    last_scraped_at: new Date().toISOString(),
    last_scrape_status: status,
    last_scrape_error: errorMessage
  };

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

  // Use existing size if available
  if (existingSize) {
    // Normalize edible sizes to mg format (convert .15g to 150mg, etc.)
    if (nameLower.startsWith('jackpot infused syrup')) {
      const mgMatch = existingSize.match(/(\d+)\s*mg/i);
      if (mgMatch) return mgMatch[1] + 'mg';
      // Convert grams to mg for edibles
      const gMatch = existingSize.match(/([\d.]+)\s*g/i);
      if (gMatch) return Math.round(parseFloat(gMatch[1]) * 1000) + 'mg';
    }
    return existingSize;
  }

  // Fall back to defaults for known product types
  if (nameLower.startsWith('jackpot infused syrup')) return '150mg';
  if (nameLower.startsWith('sesh stick vape')) return '.5g';
  if (nameLower.startsWith('hash cones')) return '2.5g';
  if (nameLower.startsWith('cold cured live rosin')) return '2g';

  return null;
}

// Generate unique product key for matching
function getProductKey(productName, size) {
  return `${productName}|${size || 'default'}`;
}

// Smart upsert: tracks product history instead of delete+insert
// Returns change summary for alerting system
async function upsertProductAvailability(dispensaryId, products) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  // Track changes for alerting
  const changes = {
    inserted: 0,
    updated: 0,
    markedOutOfStock: [],
    returnedInStock: []
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

  // 2. Prepare scraped products with normalized names
  const scrapedProducts = products.map(product => {
    const rawName = product.name;
    const size = product.size || null;
    const normalizedName = normalizeProductName(rawName, size);
    const finalSize = inferDefaultSize(normalizedName, size);

    return {
      dispensary_id: dispensaryId,
      scraped_product_name: normalizedName,
      scraped_brand: product.brand || null,
      scraped_category: product.category || null,
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

  // 3. Process each scraped product
  const toInsert = [];
  const toUpdate = [];

  for (const product of scrapedProducts) {
    const key = product.key;
    delete product.key; // Remove temporary key before DB operations
    foundKeys.add(key);

    const existing = existingMap.get(key);

    if (existing) {
      // Product exists - update it
      const updateData = {
        scraped_brand: product.scraped_brand,
        scraped_category: product.scraped_category,
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
