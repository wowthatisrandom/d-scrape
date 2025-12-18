const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  await page.goto('https://www.currentcanna.com/shop', { waitUntil: 'networkidle2', timeout: 60000 });
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

  // Detailed element analysis
  const details = await page.evaluate(() => {
    const card = document.querySelector('a[href*="/product/"]');
    if (!card) return null;

    const nameEl = card.querySelector('[class*="product__name"]');
    const priceEl = card.querySelector('[class*="price__"]');
    const infoEls = card.querySelectorAll('[class*="product_info__"]');

    const infos = [];
    infoEls.forEach(el => {
      infos.push({ class: el.className, text: el.innerText });
    });

    return {
      name: nameEl?.innerText,
      nameClass: nameEl?.className,
      price: priceEl?.innerText,
      priceClass: priceEl?.className,
      infos: infos.slice(0, 10),
      fullText: card.innerText
    };
  });

  console.log('Name:', details.name);
  console.log('Name class:', details.nameClass);
  console.log('Price:', details.price);
  console.log('\nInfo elements:');
  details.infos.forEach(i => console.log(' -', i.text, '|', i.class.substring(0, 60)));
  console.log('\nFull text:', details.fullText);

  await browser.close();
})().catch(e => console.error('Error:', e.message));
