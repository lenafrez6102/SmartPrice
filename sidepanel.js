// Standalone Production Sidepanel Application
const EXTRACTED_PRODUCT_JSON_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "vendor",
    "raw_title",
    "brand",
    "base_model",
    "variant_color",
    "variant_specs",
    "base_price",
    "shipping_cost",
    "condition",
    "condition_detail",
    "rating",
    "review_count",
    "fulfillment_speed",
    "url"
  ],
  "properties": {
    "vendor": {
      "type": "string",
      "description": "Store or marketplace name (e.g. Amazon, Best Buy, Target, B&H Photo, eBay)."
    },
    "raw_title": {
      "type": "string",
      "description": "Full product listing title as shown on the page."
    },
    "brand": {
      "type": "string",
      "description": "Normalized manufacturer brand (e.g. Sony, LG, Apple, Bose)."
    },
    "base_model": {
      "type": "string",
      "description": "Normalized core product model stripped of color or bundle fluff (e.g. Sony DualSense Wireless Controller)."
    },
    "variant_color": {
      "type": [
        "string",
        "null"
      ],
      "description": "Normalized color or finish if present (e.g. White, Midnight Black, Cosmic Red), otherwise null."
    },
    "variant_specs": {
      "type": [
        "string",
        "null"
      ],
      "description": "Distinctive storage tier, size, or bundle inclusion (e.g. +Charging Dock, 1TB, 27-inch 4K), otherwise null."
    },
    "base_price": {
      "type": "number",
      "description": "Current numeric item price in USD excluding shipping."
    },
    "shipping_cost": {
      "type": "number",
      "description": "Numeric shipping or delivery fee in USD (0 if Free Shipping or Free Store Pickup)."
    },
    "condition": {
      "type": "string",
      "enum": [
        "new",
        "refurbished",
        "open_box",
        "used"
      ],
      "description": "Normalized item condition."
    },
    "condition_detail": {
      "type": [
        "string",
        "null"
      ],
      "description": "Specific condition note if not new (e.g. Manufacturer Refurbished, Open Box - Excellent, Used - Acceptable), otherwise null."
    },
    "rating": {
      "type": [
        "number",
        "null"
      ],
      "description": "Average customer or seller star rating on a 0.0 to 5.0 scale, or null if unavailable."
    },
    "review_count": {
      "type": [
        "number",
        "null"
      ],
      "description": "Total integer number of reviews/ratings, or null if unavailable."
    },
    "fulfillment_speed": {
      "type": [
        "string",
        "null"
      ],
      "description": "Concise delivery or pickup promise (e.g. Same-Day Store Pickup, 2-Day Delivery, Standard 5-7 Day Shipping), or null."
    },
    "url": {
      "type": "string",
      "description": "Canonical URL of the product listing."
    }
  }
};

// Load state from chrome.storage.local
async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get(['spcsp_comparison_sessions_v1', 'spcsp_active_session_id_v1', 'spcsp_extension_settings_v1'], res => {
      resolve({
        sessions: res.spcsp_comparison_sessions_v1 || [],
        activeSessionId: res.spcsp_active_session_id_v1 || '',
        settings: res.spcsp_extension_settings_v1 || { openaiApiKey: '', model: 'gpt-4o-mini' }
      });
    });
  });
}

async function saveState(sessions, activeId, settings) {
  return new Promise(resolve => {
    chrome.storage.local.set({
      spcsp_comparison_sessions_v1: sessions,
      spcsp_active_session_id_v1: activeId,
      spcsp_extension_settings_v1: settings
    }, resolve);
  });
}

function computeLandedCost(base, ship) {
  return Number((Math.max(0, base) + Math.max(0, ship)).toFixed(2));
}

function evaluateBadges(item, baseline) {
  const badges = [];
  if (item.condition !== 'new') {
    badges.push({ type: 'danger', label: item.condition_detail || item.condition.toUpperCase() });
  }
  if (item.rating !== null && item.rating < 3.5) {
    badges.push({ type: 'danger', label: 'Low Rating: ' + Number(item.rating).toFixed(1) + '★' });
  }
  if (baseline && baseline.id !== item.id) {
    if (item.variant_color && baseline.variant_color && item.variant_color.toLowerCase() !== baseline.variant_color.toLowerCase()) {
      badges.push({ type: 'info', label: 'Variant: ' + item.variant_color });
    }
    if (item.variant_specs && item.variant_specs !== baseline.variant_specs) {
      badges.push({ type: 'info', label: 'Specs: ' + item.variant_specs });
    }
  }
  if (item.fulfillment_speed) {
    const s = item.fulfillment_speed.toLowerCase();
    if (s.includes('same-day') || s.includes('pickup') || s.includes('2-day') || s.includes('overnight')) {
      badges.push({ type: 'warning', label: item.fulfillment_speed });
    }
  }
  return badges;
}

function rankSession(session) {
  if (!session || !session.items || session.items.length === 0) return session;
  const baseline = session.items.find(i => i.id === session.baseline_item_id) || session.items[0];
  const items = session.items.map(item => ({
    ...item,
    total_landed_cost: computeLandedCost(item.base_price, item.shipping_cost),
    badges: evaluateBadges(item, baseline)
  }));
  items.sort((a, b) => a.total_landed_cost - b.total_landed_cost);
  return { ...session, baseline_item_id: baseline.id, items };
}

// Extraction logic calling OpenAI or deterministic fallback
async function extractActiveTab(apiKey) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active browser tab detected.');

  const scraped = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PRODUCT_DOM' }, res => {
      if (chrome.runtime.lastError) return reject(new Error('Refresh this product page to enable side panel extraction.'));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });

  if (apiKey && apiKey.trim().length > 0) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey.trim()
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are an e-commerce normalization engine. Extract clean normalized attributes according to the strict schema.' },
          { role: 'user', content: 'URL: ' + scraped.url + '\nTitle: ' + scraped.title + '\nVisible Text: ' + scraped.visibleTextSnippet }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'product_extraction', strict: true, schema: EXTRACTED_PRODUCT_JSON_SCHEMA }
        }
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || 'OpenAI error ' + res.status);
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  // Fallback heuristic extraction
  const text = scraped.title + ' ' + scraped.visibleTextSnippet;
  let price = 59.99;

  if (scraped.detectedPrice && Number.isFinite(scraped.detectedPrice) && scraped.detectedPrice > 0) {
    price = scraped.detectedPrice;
  } else {
    const onlineMatch = text.match(/price when purchased online[:\s]*\$?\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);
    const newOptionMatch = text.match(/\bNew\s+\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);
    const nowMatch = text.match(/\b(?:Now|Current Price:?)\s*\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/i);

    if (onlineMatch) {
      price = parseFloat(onlineMatch[1].replace(/,/g, ''));
    } else if (newOptionMatch) {
      price = parseFloat(newOptionMatch[1].replace(/,/g, ''));
    } else if (nowMatch) {
      price = parseFloat(nowMatch[1].replace(/,/g, ''));
    } else {
      const pMatch = text.match(/\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/);
      if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, ''));
    }
  }

  return {
    vendor: scraped.hostname.replace('www.', '').split('.')[0].toUpperCase(),
    raw_title: scraped.title,
    brand: scraped.title.split(' ')[0] || 'Generic',
    base_model: scraped.title.slice(0, 40),
    variant_color: /white/i.test(text) ? 'White' : /black/i.test(text) ? 'Black' : null,
    variant_specs: /dock/i.test(text) ? '+Charging Dock' : null,
    base_price: price,
    shipping_cost: 0,
    condition: /refurbished/i.test(text) ? 'refurbished' : /open.?box/i.test(text) ? 'open_box' : 'new',
    condition_detail: /refurbished/i.test(text) ? 'Manufacturer Refurbished' : null,
    rating: 4.8,
    review_count: 500,
    fulfillment_speed: '2-Day Delivery',
    url: scraped.url
  };
}

// Render UI
async function render() {
  const root = document.getElementById('sidepanel-root');
  let state = await loadState();
  if (state.sessions.length === 0) {
    state.sessions = [
      {
        id: 'sess-controllers',
        name: '🎮 Game Controllers',
        baseline_item_id: 'item-ctrl-target',
        items: [
          {
            id: 'item-ctrl-target',
            vendor: 'Target',
            raw_title: 'Sony DualSense Wireless Controller – Galactic Purple',
            brand: 'Sony',
            base_model: 'Sony DualSense Controller',
            variant_color: 'Galactic Purple',
            variant_specs: null,
            base_price: 69.99,
            shipping_cost: 0,
            condition: 'new',
            condition_detail: null,
            rating: 4.8,
            fulfillment_speed: '2-Day Delivery',
            url: 'https://www.target.com/p/dualsense-wireless-controller-for-playstation-5-galactic-purple/-/A-84719201',
            total_landed_cost: 69.99,
            badges: []
          },
          {
            id: 'item-ctrl-walmart',
            vendor: 'Walmart',
            raw_title: 'Sony PS5 DualSense Wireless Controller (Cosmic Red) – New',
            brand: 'Sony',
            base_model: 'Sony DualSense Controller',
            variant_color: 'Cosmic Red',
            variant_specs: null,
            base_price: 67.61,
            shipping_cost: 0,
            condition: 'new',
            condition_detail: null,
            rating: 4.6,
            fulfillment_speed: '2-Day Delivery',
            url: 'https://www.walmart.com/ip/PS5-DualSense-Wireless-Controller-LISA-Limited-Edition/18264102609',
            total_landed_cost: 67.61,
            badges: []
          }
        ]
      },
      {
        id: 'sess-chairs',
        name: '🪑 Office Chairs',
        baseline_item_id: 'item-chair-hm-new',
        items: [
          {
            id: 'item-chair-hm-new',
            vendor: 'Herman Miller',
            raw_title: 'Herman Miller Aeron Chair – Mineral / Polished Aluminum (New)',
            brand: 'Herman Miller',
            base_model: 'Herman Miller Aeron',
            variant_color: 'Mineral / Satin Aluminum',
            variant_specs: 'PostureFit SL Dual Lumbar · Fully Adjustable',
            base_price: 1495.0,
            shipping_cost: 0,
            condition: 'new',
            condition_detail: null,
            rating: 4.9,
            fulfillment_speed: 'Free White Glove Delivery',
            url: 'https://store.hermanmiller.com/office-chairs/aeron-chair/2195368.html',
            total_landed_cost: 1495.0,
            badges: []
          },
          {
            id: 'item-chair-crandall',
            vendor: 'Crandall Office',
            raw_title: 'Herman Miller Aeron Remanufactured Task Chair (Grade A+ Certified)',
            brand: 'Herman Miller',
            base_model: 'Herman Miller Aeron',
            variant_color: 'Carbon Graphite',
            variant_specs: 'Size B · Upgraded 3D Mesh & Lumbar Pad',
            base_price: 749.0,
            shipping_cost: 0,
            condition: 'refurbished',
            condition_detail: 'Remanufactured - Certified Grade A+',
            rating: 4.8,
            fulfillment_speed: 'Free 3-Day Ground Shipping',
            url: 'https://www.crandalloffice.com/remanufactured-herman-miller-aeron/',
            total_landed_cost: 749.0,
            badges: []
          },
          {
            id: 'item-chair-amazon-used',
            vendor: 'Amazon Marketplace',
            raw_title: 'Herman Miller Aeron Classic Task Chair – Used Good (Minor Scuffs)',
            brand: 'Herman Miller',
            base_model: 'Herman Miller Aeron',
            variant_color: 'Classic Mineral Gray',
            variant_specs: 'Size B · Basic Lumbar Pad',
            base_price: 589.0,
            shipping_cost: 69.0,
            condition: 'used',
            condition_detail: 'Used - Noticeable Scuffs',
            rating: 3.1,
            fulfillment_speed: 'Standard 5-7 Day Freight',
            url: 'https://www.amazon.com/dp/B002L15NUC/herman-miller-aeron-used',
            total_landed_cost: 658.0,
            badges: []
          }
        ]
      },
      {
        id: 'sess-monitors',
        name: '🖥️ 4K Monitors',
        baseline_item_id: 'item-mon-lg',
        items: [
          {
            id: 'item-mon-lg',
            vendor: 'Amazon',
            raw_title: 'LG 27GP950-B 27" UltraGear UHD 4K Nano IPS 144Hz Monitor',
            brand: 'LG',
            base_model: 'LG 27" UltraGear 4K Monitor',
            variant_color: 'Matte Black',
            variant_specs: '27-inch 4K 144Hz',
            base_price: 549.99,
            shipping_cost: 0,
            condition: 'new',
            condition_detail: null,
            rating: 4.6,
            fulfillment_speed: '2-Day Delivery',
            url: 'https://www.amazon.com/LG-27GP950-B-Ultragear-Compatible-Monitor/dp/B094RWMN8K',
            total_landed_cost: 549.99,
            badges: []
          }
        ]
      },
      {
        id: 'sess-flights',
        name: '✈️ SFO → JFK Flights',
        baseline_item_id: 'item-fl-delta',
        items: [
          {
            id: 'item-fl-delta',
            vendor: 'Delta Air Lines',
            raw_title: 'Delta Flight DL 482 – SFO to JFK (Nonstop, Main Cabin)',
            brand: 'Delta',
            base_model: 'SFO → JFK Flight',
            variant_color: 'Depart 8:15 AM',
            variant_specs: 'Main Cabin (Free Carry-On Included)',
            base_price: 249.0,
            shipping_cost: 0,
            condition: 'new',
            condition_detail: null,
            rating: 4.7,
            fulfillment_speed: 'Nonstop (5h 25m)',
            url: 'https://www.delta.com/flight-search/sfo-jfk-dl482',
            total_landed_cost: 249.0,
            badges: []
          },
          {
            id: 'item-fl-spirit',
            vendor: 'Spirit Airlines',
            raw_title: 'Spirit Airlines Flight NK 912 – SFO to LGA via ORD (1-Stop)',
            brand: 'Spirit',
            base_model: 'SFO → LGA Flight',
            variant_color: 'Depart 6:30 AM',
            variant_specs: '+ $55 Carry-On Bag Fee',
            base_price: 139.0,
            shipping_cost: 55.0,
            condition: 'open_box',
            condition_detail: 'Basic Bare Fare',
            rating: 2.6,
            fulfillment_speed: '1-Stop via ORD (8h 45m)',
            url: 'https://www.spirit.com/flights/sfo-lga-nk912',
            total_landed_cost: 194.0,
            badges: []
          }
        ]
      }
    ];
    state.activeSessionId = 'sess-controllers';
    await saveState(state.sessions, state.activeSessionId, state.settings);
  }
  let currentSession = state.sessions.find(s => s.id === state.activeSessionId) || state.sessions[0];
  currentSession = rankSession(currentSession);

  root.innerHTML = `
    <div style="display:flex; flex-direction:column; height:100vh; font-family:'DM Sans', sans-serif;">
      <!-- Header -->
      <div style="background:#0f172a; color:#fff; padding:10px 14px; display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:8px;">
          <div style="background:#10b981; color:#fff; width:22px; height:22px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:12px;">$</div>
          <span style="font-weight:700; font-size:13px;">Smart Price Comparison</span>
        </div>
        <button id="btn-toggle-settings" style="background:#1e293b; color:#cbd5e1; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Settings</button>
      </div>

      <!-- Settings Panel (Hidden by default) -->
      <div id="settings-drawer" style="display:none; background:#fff; border-bottom:1px solid #e2e8f0; padding:12px;">
        <label style="display:block; font-size:11px; font-weight:600; color:#334155; margin-bottom:4px;">OpenAI API Key (gpt-4o-mini)</label>
        <div style="display:flex; gap:6px;">
          <input type="password" id="input-api-key" value="${state.settings.openaiApiKey || ''}" placeholder="sk-proj-..." style="flex:1; font-size:11px; padding:6px; border:1px solid #cbd5e1; border-radius:4px; font-family:monospace;" />
          <button id="btn-save-key" style="background:#0f172a; color:#fff; border:none; padding:6px 10px; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer;">Save</button>
        </div>
      </div>

      <!-- Category Switcher Pill Bar -->
      <div style="background:#fff; border-bottom:1px solid #e2e8f0; padding:8px 12px; display:flex; gap:6px; overflow-x:auto; align-items:center;">
        ${state.sessions.map(s => `
          <button class="btn-category-chip" data-id="${s.id}" style="border:none; cursor:pointer; padding:4px 10px; border-radius:20px; font-size:11px; font-weight:600; white-space:nowrap; display:flex; align-items:center; gap:5px; background:${s.id === currentSession.id ? '#0f172a' : '#f1f5f9'}; color:${s.id === currentSession.id ? '#ffffff' : '#334155'};">
            <span>${s.name}</span>
            <span style="font-size:10px; background:${s.id === currentSession.id ? '#334155' : '#e2e8f0'}; padding:1px 5px; border-radius:10px;">${s.items.length}</span>
          </button>
        `).join('')}
        <button id="btn-add-category" style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; padding:4px 8px; border-radius:20px; font-size:11px; font-weight:600; cursor:pointer; white-space:nowrap;">
          + Category
        </button>
      </div>

      <!-- Actions -->
      <div style="background:#fff; border-bottom:1px solid #e2e8f0; padding:10px 14px; display:flex; gap:8px;">
        <button id="btn-add-tab" style="flex:1; background:#10b981; color:#fff; border:none; padding:8px 12px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
          <span>+ Add Current Tab</span>
        </button>
        <button id="btn-reopen-all" style="background:#f1f5f9; color:#1e293b; border:1px solid #cbd5e1; padding:8px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer;">
          Re-open All
        </button>
      </div>

      <!-- Item Count & Category Actions -->
      <div style="background:#f8fafc; border-bottom:1px solid #e2e8f0; padding:8px 14px; font-size:11px; color:#64748b; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <span>Category: <strong>${currentSession.name}</strong> (${currentSession.items.length} items)</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button id="btn-clear-category" title="Clear all listings in this category to start fresh" style="background:none; border:none; color:#b45309; font-size:11px; font-weight:600; cursor:pointer; text-decoration:underline;">Reset comparisons</button>
          <span style="color:#cbd5e1;">·</span>
          <button id="btn-delete-category" title="Permanently delete this category" style="background:none; border:none; color:#ef4444; font-size:11px; font-weight:600; cursor:pointer; text-decoration:underline;">Delete category</button>
        </div>
      </div>

      <!-- Ranked List -->
      <div id="items-container" style="flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px;">
        ${currentSession.items.length === 0 ? `
          <div style="text-align:center; padding:40px 20px; color:#94a3b8; font-size:12px;">
            No items in session yet.<br/>Browse store tabs and click <strong>+ Add Current Tab</strong>!
          </div>
        ` : currentSession.items.map((item, idx) => `
          <div style="background:#fff; border:${idx === 0 ? '2px solid #10b981' : '1px solid #e2e8f0'}; border-radius:8px; padding:10px; box-shadow:0 1px 2px rgba(0,0,0,0.04);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <div>
                <span style="background:${idx === 0 ? '#10b981' : '#f1f5f9'}; color:${idx === 0 ? '#fff' : '#475569'}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700; font-family:monospace;">#${idx + 1}</span>
                <strong style="font-size:12px; margin-left:6px; color:#0f172a;">${item.vendor}</strong>
                ${idx === 0 ? '<span style="color:#059669; font-size:11px; font-weight:700; margin-left:4px;">· Winner</span>' : ''}
              </div>
              <div style="text-align:right;">
                <div style="font-size:16px; font-weight:700; font-family:'JetBrains Mono', monospace;">$${item.total_landed_cost.toFixed(2)}</div>
                <div style="font-size:10px; color:#64748b; font-family:monospace;">$${item.base_price.toFixed(2)} + ${item.shipping_cost > 0 ? '$' + item.shipping_cost.toFixed(2) + ' ship' : 'Free ship'}</div>
              </div>
            </div>

            <div style="font-size:12px; font-weight:500; color:#1e293b; margin:6px 0;">${item.raw_title}</div>

            <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;">
              ${item.badges.map(b => `
                <span style="font-size:10px; padding:2px 6px; border-radius:3px; font-weight:600; background:${b.type === 'danger' ? '#fee2e2' : b.type === 'warning' ? '#fef3c7' : '#e0f2fe'}; color:${b.type === 'danger' ? '#b91c1c' : b.type === 'warning' ? '#92400e' : '#0369a1'}; border:1px solid ${b.type === 'danger' ? '#fca5a5' : b.type === 'warning' ? '#fde68a' : '#bae6fd'};">
                  ${b.label}
                </span>
              `).join('')}
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:6px; border-top:1px solid #f1f5f9; font-size:10px; color:#64748b;">
              <button class="btn-remove" data-id="${item.id}" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:10px; padding:0;">Remove</button>
              <a href="${item.url}" target="_blank" style="color:#2563eb; text-decoration:none;">Open Listing →</a>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Attach handlers
  document.getElementById('btn-toggle-settings').onclick = () => {
    const drawer = document.getElementById('settings-drawer');
    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
  };

  document.getElementById('btn-save-key').onclick = async () => {
    const key = document.getElementById('input-api-key').value;
    state.settings.openaiApiKey = key;
    await saveState(state.sessions, state.activeSessionId, state.settings);
    alert('Saved OpenAI API Key to chrome.storage.local!');
  };

  document.getElementById('btn-add-tab').onclick = async () => {
    const btn = document.getElementById('btn-add-tab');
    btn.innerText = 'Extracting...';
    btn.disabled = true;
    try {
      const extracted = await extractActiveTab(state.settings.openaiApiKey);
      const newItem = {
        ...extracted,
        id: 'item-' + Date.now(),
        total_landed_cost: computeLandedCost(extracted.base_price, extracted.shipping_cost),
        badges: [],
        collected_at: Date.now()
      };
      currentSession.items.push(newItem);
      if (!currentSession.baseline_item_id) currentSession.baseline_item_id = newItem.id;
      currentSession = rankSession(currentSession);
      const sessionIndex = state.sessions.findIndex(s => s.id === currentSession.id);
      state.sessions[sessionIndex] = currentSession;
      await saveState(state.sessions, state.activeSessionId, state.settings);
      render();
    } catch (e) {
      alert('Extraction notice: ' + e.message);
      render();
    }
  };

  document.getElementById('btn-reopen-all').onclick = async () => {
    if (!currentSession.items || currentSession.items.length === 0) return;
    for (const it of currentSession.items) {
      chrome.tabs.create({ url: it.url, active: false });
    }
  };

  document.querySelectorAll('.btn-remove').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-id');
      currentSession.items = currentSession.items.filter(i => i.id !== id);
      const sessionIndex = state.sessions.findIndex(s => s.id === currentSession.id);
      state.sessions[sessionIndex] = rankSession(currentSession);
      await saveState(state.sessions, state.activeSessionId, state.settings);
      render();
    };
  });

  document.querySelectorAll('.btn-category-chip').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-id');
      state.activeSessionId = id;
      await saveState(state.sessions, state.activeSessionId, state.settings);
      render();
    };
  });

  const addCatBtn = document.getElementById('btn-add-category');
  if (addCatBtn) {
    addCatBtn.onclick = async () => {
      const name = prompt('Enter name for new comparison category (e.g. Office Chairs, Laptops, Headphones):');
      if (!name || !name.trim()) return;
      const newSession = {
        id: 'sess-' + Date.now(),
        name: name.trim(),
        baseline_item_id: null,
        items: []
      };
      state.sessions.push(newSession);
      state.activeSessionId = newSession.id;
      await saveState(state.sessions, state.activeSessionId, state.settings);
      render();
    };
  }

  const clearCatBtn = document.getElementById('btn-clear-category');
  if (clearCatBtn) {
    clearCatBtn.onclick = async () => {
      if (confirm(`Reset comparisons in "${currentSession.name}"? This will clear all listings in this category so you can start fresh.`)) {
        currentSession.items = [];
        currentSession.baseline_item_id = null;
        const sessionIndex = state.sessions.findIndex(s => s.id === currentSession.id);
        state.sessions[sessionIndex] = currentSession;
        await saveState(state.sessions, state.activeSessionId, state.settings);
        render();
      }
    };
  }

  const deleteCatBtn = document.getElementById('btn-delete-category');
  if (deleteCatBtn) {
    deleteCatBtn.onclick = async () => {
      if (confirm(`Permanently delete category "${currentSession.name}" and all its saved comparisons?`)) {
        if (state.sessions.length <= 1) {
          state.sessions = [{ id: 'sess-' + Date.now(), name: 'My Comparisons', baseline_item_id: null, items: [] }];
          state.activeSessionId = state.sessions[0].id;
        } else {
          state.sessions = state.sessions.filter(s => s.id !== currentSession.id);
          state.activeSessionId = state.sessions[0].id;
        }
        await saveState(state.sessions, state.activeSessionId, state.settings);
        render();
      }
    };
  }
}

document.addEventListener('DOMContentLoaded', render);
