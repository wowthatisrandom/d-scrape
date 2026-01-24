// Disable dispensaries that are confirmed out of Ace products
const { getSupabaseClient } = require('./lib/supabase');

const DISPENSARIES_TO_DISABLE = [
  'Proper Cannabis - Kansas City',
  'Proper Cannabis - Bridgeton',
  'Proper Cannabis - Crestwood',
  'Proper Cannabis - South County',
  'Latitude - Eldon',
  'Missouri Health and Wellness - Kirksville',
  'Shangri-La - Columbia South'
];

async function main() {
  const supabase = getSupabaseClient();

  console.log('Disabling out-of-stock dispensaries...\n');

  for (const name of DISPENSARIES_TO_DISABLE) {
    const { data, error } = await supabase
      .from('dispensaries')
      .update({ scrape_enabled: false })
      .ilike('name', `%${name}%`)
      .select('name');

    if (error) {
      console.error(`Error disabling "${name}":`, error.message);
    } else if (data.length === 0) {
      console.log(`⚠️ No match found for: ${name}`);
    } else {
      data.forEach(d => console.log(`✅ Disabled: ${d.name}`));
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
