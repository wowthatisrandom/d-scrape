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

// Replace product availability data (delete old, insert fresh)
async function upsertProductAvailability(dispensaryId, products) {
  const supabase = getSupabaseClient();

  // Delete all existing products for this dispensary
  const { error: deleteError } = await supabase
    .from('product_availability')
    .delete()
    .eq('dispensary_id', dispensaryId);

  if (deleteError) {
    console.error('Error deleting old products:', deleteError);
  }

  // Prepare fresh records with normalized names
  const records = products.map(product => {
    const rawName = product.name;
    const size = product.size || null;
    const normalizedName = normalizeProductName(rawName, size);
    const finalSize = inferDefaultSize(normalizedName, size);

    return {
      dispensary_id: dispensaryId,
      scraped_product_name: normalizedName, // Store normalized name
      scraped_brand: product.brand || null,
      scraped_category: product.category || null,
      scraped_price: product.price || null,
      scraped_size: finalSize,
      in_stock: true,
      menu_url: product.url || null,
      raw_data: { ...product.raw, originalName: rawName }, // Keep original in raw_data
      scraped_at: new Date().toISOString()
    };
  });

  // Insert in batches of 50
  const batchSize = 50;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    const { error } = await supabase
      .from('product_availability')
      .insert(batch);

    if (error) {
      console.error('Error inserting products:', error);
      throw error;
    }
  }

  return records.length;
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
