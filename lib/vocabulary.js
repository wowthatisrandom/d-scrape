/**
 * Brand vocabulary loader — fetches strain and flavor dictionaries from
 * Supabase so they live in one place instead of being hardcoded in two repos.
 *
 * Usage at an entry point (scrape.js, scrape-one.js, etc.):
 *
 *   const { getSupabaseClient } = require('./lib/supabase');
 *   const { loadVocabulary } = require('./lib/vocabulary');
 *
 *   const supabase = getSupabaseClient();
 *   const vocab = await loadVocabulary(supabase);
 *   // ... then pass vocab into upsertProductAvailability() etc.
 *
 * The promise is cached at module level, so repeated calls within a single
 * scraper run share one network fetch.
 */

let cachedPromise = null;

async function loadVocabulary(supabase) {
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    const { data, error } = await supabase
      .from('brand_vocabulary')
      .select('kind, name')
      .eq('active', true);

    if (error) {
      cachedPromise = null;
      throw new Error(`Failed to load brand_vocabulary: ${error.message}`);
    }

    const rows = data || [];
    return {
      strains: rows.filter(r => r.kind === 'strain').map(r => r.name),
      flavors: rows.filter(r => r.kind === 'flavor').map(r => r.name),
    };
  })();

  return cachedPromise;
}

function setVocabularyForTesting(vocab) {
  cachedPromise = Promise.resolve(vocab);
}

function resetVocabularyCache() {
  cachedPromise = null;
}

module.exports = {
  loadVocabulary,
  setVocabularyForTesting,
  resetVocabularyCache,
};
