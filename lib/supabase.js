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

// Get all enabled Dutchie dispensaries
async function getEnabledDispensaries() {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('dispensaries')
    .select('*')
    .eq('scrape_enabled', true)
    .eq('menu_platform', 'dutchie');

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

// Upsert product availability data
async function upsertProductAvailability(dispensaryId, products) {
  const supabase = getSupabaseClient();

  // First, mark all existing products for this dispensary as out of stock
  // (we'll update the ones that are still available)
  const { error: updateError } = await supabase
    .from('product_availability')
    .update({ in_stock: false })
    .eq('dispensary_id', dispensaryId);

  if (updateError) {
    console.error('Error marking products out of stock:', updateError);
  }

  // Prepare records for upsert
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

  // Upsert in batches of 50
  const batchSize = 50;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    const { error } = await supabase
      .from('product_availability')
      .upsert(batch, {
        onConflict: 'dispensary_id,scraped_product_name',
        ignoreDuplicates: false
      });

    if (error) {
      console.error('Error upserting products:', error);
      throw error;
    }
  }

  return records.length;
}

module.exports = {
  getSupabaseClient,
  getEnabledDispensaries,
  getDispensaryById,
  updateDispensaryStatus,
  upsertProductAvailability
};
