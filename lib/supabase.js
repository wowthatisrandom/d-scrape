const { createClient } = require('@supabase/supabase-js');

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

  // Prepare fresh records
  const records = products.map(product => ({
    dispensary_id: dispensaryId,
    scraped_product_name: product.name,
    scraped_brand: product.brand || null,
    scraped_category: product.category || null,
    scraped_price: product.price || null,
    scraped_size: product.size || null,
    in_stock: true,
    menu_url: product.url || null,
    raw_data: product.raw || null,
    scraped_at: new Date().toISOString()
  }));

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
