// Content Script: Scrapes JSON-LD and visible product metadata from active shopping tab
function detectActiveBuyBoxPrice() {
  const buyBoxSelectors = [
    '[data-seo-id="hero-price"]',
    'span[itemprop="price"]',
    '[data-testid="price-wrap"]',
    '[data-testid="item-price"]',
    '[itemprop="offers"] [itemprop="price"]',
    '[data-test="product-price"]',
    'span[data-test="current-price"]',
    '.priceView-customer-price span[aria-hidden="true"]',
    '[data-testid="customer-price"]',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#apex_desktop .a-price .a-offscreen',
    'span.priceToPay span.a-offscreen'
  ];

  for (const sel of buyBoxSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      if (el.closest('[data-testid="swatch-group"], [aria-label*="swatch"], .swatches, .variant-options')) {
        continue;
      }
      const text = el.textContent || '';
      const m = text.match(/\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/) || text.match(/(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(val) && val > 0) return val;
      }
    }
  }

  const bodyText = document.body.innerText || '';
  const onlineMatch = bodyText.match(/price when purchased online[:\s]*\$?\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);
  if (onlineMatch) {
    const val = parseFloat(onlineMatch[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) return val;
  }

  const newOptionMatch = bodyText.match(/\bNew\s+\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);
  if (newOptionMatch) {
    const val = parseFloat(newOptionMatch[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) return val;
  }

  const nowMatch = bodyText.match(/\b(?:Now|Current Price:?)\s*\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);
  if (nowMatch) {
    const val = parseFloat(nowMatch[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) return val;
  }

  const metaPrice = document.querySelector('meta[itemprop="price"], meta[property="product:price:amount"]');
  if (metaPrice) {
    const val = parseFloat(metaPrice.getAttribute('content') || '');
    if (Number.isFinite(val) && val > 0) return val;
  }

  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(s.textContent || '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && item.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const offer of offers) {
            if (offer && offer.price) {
              const val = parseFloat(offer.price);
              if (Number.isFinite(val) && val > 0) return val;
            }
          }
        }
      }
    } catch {}
  }

  return null;
}

function scrapeProductTab() {
  const url = window.location.href;
  const hostname = window.location.hostname;
  const title = document.title || '';

  const metaDescEl = document.querySelector('meta[name="description"], meta[property="og:description"]');
  const metaDescription = metaDescEl ? metaDescEl.getAttribute('content') || '' : '';

  const detectedPrice = detectActiveBuyBoxPrice();

  // Collect schema.org JSON-LD
  const jsonLdBlocks = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    const raw = s.textContent || '';
    if (raw && /Product|Offer|AggregateRating/i.test(raw)) {
      jsonLdBlocks.push(raw.trim().slice(0, 3000));
    }
  });

  // Extract cleaned visible text
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, svg, nav, footer, iframe').forEach(el => el.remove());
  const visibleTextSnippet = (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6500);

  return {
    url,
    title,
    hostname,
    metaDescription,
    detectedPrice,
    structuredJsonLd: jsonLdBlocks.length > 0 ? jsonLdBlocks.join('\n---\n') : null,
    visibleTextSnippet
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'EXTRACT_PRODUCT_DOM') {
    try {
      const payload = scrapeProductTab();
      sendResponse(payload);
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }
});
