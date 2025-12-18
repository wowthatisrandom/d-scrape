const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // Use the filtered URL
  await page.goto('https://www.currentcanna.com/shop?brand.keyword=ACE+SOLVENTLESS', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  // Bypass age gate
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, a');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('21') || text.includes('yes')) { btn.click(); return; }
    }
  });

  await new Promise(r => setTimeout(r, 5000));

  // Get all products
  const products = await page.evaluate(() => {
    const cards = document.querySelectorAll('a[href*="/product/"]');
    const results = [];

    cards.forEach(card => {
      const nameEl = card.querySelector('[class*="product__name"]');
      const priceEl = card.querySelector('[class*="price__"]');
      const infoEls = card.querySelectorAll('[class*="product_info__"]');

      // Parse infos
      let brand = null, category = null, thc = null;
      infoEls.forEach(el => {
        const text = el.innerText.trim();
        if (text.includes('%') || text.includes('MG')) {
          if (text.includes('%')) thc = text;
        } else if (text === text.toUpperCase() && text.length > 2) {
          // All caps = brand or category
          if (!brand) brand = text;
          else if (!category) category = text;
        }
      });

      const name = nameEl?.innerText?.trim();
      const priceText = priceEl?.innerText || '';
      const priceMatch = priceText.match(/\$([\d.]+)/);
      const price = priceMatch ? parseFloat(priceMatch[1]) : null;

      results.push({
        name,
        brand,
        price,
        category,
        thc,
        url: card.href
      });
    });

    return results;
  });

  console.log('Found', products.length, 'ACE products:\n');
  products.forEach(p => {
    console.log('-', p.name);
    console.log('  Brand:', p.brand, '| Price:', p.price, '| Category:', p.category);
  });

  await browser.close();
})().catch(e => console.error('Error:', e.message));
