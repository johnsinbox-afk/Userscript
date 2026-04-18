// ==UserScript==
// @name         Etsy & eBay Listing Collector → Google Sheets
// @namespace    https://github.com/your-handle/userscripts
// @version      1.0.0
// @description  Floating overlay for Etsy & eBay search pages. Filter by keyword, filter by country, check off listings, and save them (with permanent Drive-hosted images) to a Google Sheet. Mobile friendly.
// @author       You
// @match        https://www.etsy.com/*search*
// @match        https://www.etsy.com/search*
// @match        https://www.etsy.com/c/*
// @match        https://www.etsy.com/market/*
// @match        https://www.ebay.com/sch/*
// @match        https://www.ebay.com/b/*
// @match        https://*.ebay.com/sch/*
// @match        https://*.etsy.com/*search*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

/* ============================================================================
 *  SETUP INSTRUCTIONS — READ ME FIRST
 * ============================================================================
 *
 *  This userscript sends the listings you tick to a Google Apps Script Web App
 *  which (a) uploads the main listing image to Google Drive, (b) appends a
 *  row to your Google Sheet using =IMAGE(driveUrl) so the thumbnail renders
 *  permanently inside the sheet, and (c) de-duplicates by listing URL.
 *
 *  You only need to do this once.
 *
 *  ── STEP 1 ─ Create a Google Sheet ─────────────────────────────────────────
 *  • Open https://sheets.new and rename it e.g. "Listing Collector".
 *  • Copy the ID from the URL:
 *        https://docs.google.com/spreadsheets/d/THIS_IS_THE_SHEET_ID/edit
 *  • Put it in CONFIG.SHEET_ID below.
 *
 *  ── STEP 2 ─ Create a Google Drive folder ──────────────────────────────────
 *  • Create a folder in Drive (e.g. "Listing Images").
 *  • Open it. Copy the ID from the URL:
 *        https://drive.google.com/drive/folders/THIS_IS_THE_FOLDER_ID
 *  • Put it in CONFIG.DRIVE_FOLDER_ID below.
 *
 *  ── STEP 3 ─ Deploy the Apps Script Web App ────────────────────────────────
 *  • In your Sheet go to Extensions → Apps Script.
 *  • Replace Code.gs with the script shown in the big comment block at the
 *    bottom of this file (search for "APPS SCRIPT — paste into Code.gs").
 *  • Click Deploy → New deployment → Type: Web app.
 *      – Execute as: Me
 *      – Who has access: Anyone  (it's unguessable & you can add a shared
 *        secret below if you want extra safety)
 *  • Copy the Web app URL — it looks like
 *        https://script.google.com/macros/s/AKfycbx.../exec
 *  • Put it in CONFIG.WEB_APP_URL below.
 *
 *  ── STEP 4 ─ (Optional) shared secret ──────────────────────────────────────
 *  • If you set SHARED_SECRET in the Apps Script, set the same string in
 *    CONFIG.SHARED_SECRET below. Leave both empty to disable.
 *
 *  ── STEP 5 ─ Install in Safari ─────────────────────────────────────────────
 *  • Use the "Userscripts" Safari extension (open-source) or Tampermonkey.
 *  • Create a new script, paste this whole file in, save.
 *  • Visit an Etsy or eBay search page — a small floating button appears.
 *
 *  That's it. Tick listings, choose countries, hit "Save Selected to Google
 *  Sheets". Duplicates (same listing URL) are skipped automatically.
 * ============================================================================
 */

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    //  CONFIG — EDIT THESE THREE VALUES
    // ────────────────────────────────────────────────────────────────────────
    const CONFIG = {
        SHEET_ID:        'PUT_YOUR_GOOGLE_SHEET_ID_HERE',
        DRIVE_FOLDER_ID: 'PUT_YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE',
        WEB_APP_URL:     'PUT_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE',
        SHARED_SECRET:   '' // optional; must match Apps Script if set
    };

    // List of countries shown in the country-filter checkbox group.
    // Feel free to add/remove. "Any" acts as a wildcard (no filtering).
    const COUNTRY_OPTIONS = [
        'Any',
        'United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand',
        'Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Belgium',
        'Ireland', 'Sweden', 'Norway', 'Denmark', 'Finland',
        'Poland', 'Portugal', 'Austria', 'Switzerland', 'Greece',
        'Japan', 'China', 'Hong Kong', 'South Korea', 'Taiwan',
        'India', 'Singapore', 'Thailand', 'Vietnam', 'Indonesia', 'Philippines',
        'Mexico', 'Brazil', 'Argentina', 'Chile',
        'Turkey', 'Israel', 'United Arab Emirates', 'South Africa'
    ];

    // ────────────────────────────────────────────────────────────────────────
    //  Cross-manager helpers (Tampermonkey & Safari "Userscripts" differ)
    // ────────────────────────────────────────────────────────────────────────
    const gmXHR = (typeof GM_xmlhttpRequest !== 'undefined')
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    const gmGet = (typeof GM_getValue !== 'undefined')
        ? (k, d) => GM_getValue(k, d)
        : (typeof GM !== 'undefined' && GM.getValue ? (k, d) => GM.getValue(k, d) : (k, d) => {
            try { const v = localStorage.getItem('ue_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
        });

    const gmSet = (typeof GM_setValue !== 'undefined')
        ? (k, v) => GM_setValue(k, v)
        : (typeof GM !== 'undefined' && GM.setValue ? (k, v) => GM.setValue(k, v) : (k, v) => {
            try { localStorage.setItem('ue_' + k, JSON.stringify(v)); } catch (e) {}
        });

    // ────────────────────────────────────────────────────────────────────────
    //  Site detection
    // ────────────────────────────────────────────────────────────────────────
    const SITE = /(^|\.)etsy\.com$/i.test(location.hostname) ? 'etsy'
               : /(^|\.)ebay\./i.test(location.hostname)     ? 'ebay'
               : null;
    if (!SITE) return;

    // ────────────────────────────────────────────────────────────────────────
    //  Styles — scoped with the "uec-" prefix so we don't clash with the host
    // ────────────────────────────────────────────────────────────────────────
    const CSS = `
    .uec-toggle{
        position:fixed; right:14px; bottom:14px; z-index:2147483646;
        width:56px; height:56px; border-radius:50%;
        background:#1f7ae0; color:#fff; border:none; cursor:pointer;
        font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        box-shadow:0 6px 18px rgba(0,0,0,.25);
        display:flex; align-items:center; justify-content:center;
        transition:transform .15s ease;
    }
    .uec-toggle:hover{transform:scale(1.05);}
    .uec-toggle .uec-count{
        position:absolute; top:-4px; right:-4px;
        background:#e0441f; color:#fff; border-radius:999px;
        font-size:11px; min-width:18px; height:18px; padding:0 5px;
        display:flex; align-items:center; justify-content:center;
        box-shadow:0 2px 4px rgba(0,0,0,.2);
    }

    .uec-panel{
        position:fixed; right:14px; bottom:80px; z-index:2147483646;
        width:340px; max-width:calc(100vw - 28px);
        max-height:calc(100vh - 110px);
        background:#fff; color:#222; border-radius:14px;
        box-shadow:0 12px 40px rgba(0,0,0,.28);
        font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        display:flex; flex-direction:column; overflow:hidden;
    }
    .uec-panel[hidden]{display:none;}
    .uec-head{
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 14px; background:#1f7ae0; color:#fff;
    }
    .uec-head h3{margin:0; font-size:14px; font-weight:600;}
    .uec-head button{
        background:transparent; color:#fff; border:none; font-size:18px;
        cursor:pointer; line-height:1; padding:4px 8px;
    }
    .uec-body{padding:12px 14px; overflow:auto; flex:1;}
    .uec-body label{font-weight:600; display:block; margin:0 0 6px;}
    .uec-body input[type=text]{
        width:100%; box-sizing:border-box; padding:8px 10px;
        border:1px solid #ccd2db; border-radius:8px; font:inherit;
    }
    .uec-country-box{
        max-height:140px; overflow:auto; border:1px solid #e4e7ee;
        border-radius:8px; padding:6px 8px; margin-top:4px; background:#fafbfd;
    }
    .uec-country-box label{
        font-weight:400; display:flex; align-items:center; gap:6px;
        padding:2px 0; margin:0; font-size:12.5px;
    }
    .uec-row{display:flex; gap:8px; align-items:center; margin-top:10px;}
    .uec-row button{
        flex:1; padding:8px 10px; border:1px solid #ccd2db; border-radius:8px;
        background:#f4f6fa; cursor:pointer; font:inherit;
    }
    .uec-row button.primary{
        background:#1f7ae0; color:#fff; border-color:#1f7ae0; font-weight:600;
    }
    .uec-row button:disabled{opacity:.6; cursor:not-allowed;}
    .uec-status{
        margin-top:10px; font-size:12px; color:#555; min-height:16px;
        white-space:pre-wrap;
    }
    .uec-log{
        margin-top:8px; font-size:11.5px; max-height:100px; overflow:auto;
        background:#0e1116; color:#cfd3dc; border-radius:8px; padding:6px 8px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    }
    .uec-log .ok{color:#7ee787;}
    .uec-log .err{color:#ff7b72;}
    .uec-log .warn{color:#f2cc60;}

    /* Per-listing checkbox */
    .uec-listing-check{
        position:absolute; top:6px; left:6px; z-index:50;
        width:26px; height:26px; border-radius:6px;
        background:rgba(255,255,255,.92); backdrop-filter:blur(6px);
        display:flex; align-items:center; justify-content:center;
        box-shadow:0 1px 4px rgba(0,0,0,.2);
        cursor:pointer;
    }
    .uec-listing-check input{
        width:18px; height:18px; margin:0; cursor:pointer; accent-color:#1f7ae0;
    }
    .uec-hidden-by-filter{display:none !important;}

    /* Mobile tweaks */
    @media (max-width: 520px){
        .uec-panel{right:6px; left:6px; width:auto; bottom:74px;}
        .uec-toggle{right:10px; bottom:10px; width:52px; height:52px;}
        .uec-listing-check{width:30px; height:30px;}
        .uec-listing-check input{width:22px; height:22px;}
    }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.documentElement.appendChild(styleEl);

    // ────────────────────────────────────────────────────────────────────────
    //  DOM helpers
    // ────────────────────────────────────────────────────────────────────────
    const h = (tag, attrs = {}, ...children) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') el.className = v;
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (v === true) el.setAttribute(k, '');
            else if (v !== false && v != null) el.setAttribute(k, v);
        }
        for (const c of children) {
            if (c == null) continue;
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return el;
    };

    // ────────────────────────────────────────────────────────────────────────
    //  Floating overlay UI
    // ────────────────────────────────────────────────────────────────────────
    const state = {
        keyword: '',
        countries: new Set(['Any']),
        selections: new Map() // url → listing object
    };

    const toggleBtn = h('button', { class: 'uec-toggle', title: 'Listing Collector' },
        'List',
        h('span', { class: 'uec-count', id: 'uec-count' }, '0')
    );

    const keywordInput = h('input', { type: 'text', placeholder: 'e.g. vintage lamp' });
    const countryBox   = h('div', { class: 'uec-country-box' });
    const statusEl     = h('div', { class: 'uec-status' }, 'Ready.');
    const logEl        = h('div', { class: 'uec-log' });

    const selectAllBtn = h('button', {}, 'Select all visible');
    const clearBtn     = h('button', {}, 'Clear');
    const saveBtn      = h('button', { class: 'primary' }, 'Save Selected to Google Sheets');

    const panel = h('div', { class: 'uec-panel', hidden: true },
        h('div', { class: 'uec-head' },
            h('h3', {}, (SITE === 'etsy' ? 'Etsy' : 'eBay') + ' Listing Collector'),
            h('button', { title: 'Close', onclick: () => togglePanel(false) }, '\u00d7')
        ),
        h('div', { class: 'uec-body' },
            h('label', {}, 'Filter by keyword'),
            keywordInput,
            h('label', { style: 'margin-top:10px;' }, 'Countries (ship-from / location)'),
            countryBox,
            h('div', { class: 'uec-row' }, selectAllBtn, clearBtn),
            h('div', { class: 'uec-row' }, saveBtn),
            statusEl,
            logEl
        )
    );

    document.documentElement.appendChild(toggleBtn);
    document.documentElement.appendChild(panel);

    function togglePanel(force) {
        const show = typeof force === 'boolean' ? force : panel.hasAttribute('hidden');
        if (show) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
    }
    toggleBtn.addEventListener('click', () => togglePanel());

    // Restore previous keyword/countries
    (async () => {
        try {
            const savedKw = await gmGet('keyword', '');
            const savedCs = await gmGet('countries', ['Any']);
            keywordInput.value = savedKw || '';
            state.keyword = keywordInput.value.trim().toLowerCase();
            state.countries = new Set(Array.isArray(savedCs) && savedCs.length ? savedCs : ['Any']);
        } catch (e) { /* ignore */ }
        buildCountryCheckboxes();
        applyFilters();
    })();

    function buildCountryCheckboxes() {
        countryBox.innerHTML = '';
        for (const c of COUNTRY_OPTIONS) {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = state.countries.has(c);
            cb.addEventListener('change', () => {
                if (c === 'Any') {
                    state.countries = new Set(cb.checked ? ['Any'] : []);
                } else {
                    if (cb.checked) state.countries.add(c); else state.countries.delete(c);
                    state.countries.delete('Any');
                    if (state.countries.size === 0) state.countries.add('Any');
                }
                buildCountryCheckboxes();
                gmSet('countries', Array.from(state.countries));
                applyFilters();
            });
            countryBox.appendChild(h('label', {}, cb, ' ' + c));
        }
    }

    keywordInput.addEventListener('input', () => {
        state.keyword = keywordInput.value.trim().toLowerCase();
        gmSet('keyword', keywordInput.value);
        applyFilters();
    });

    selectAllBtn.addEventListener('click', () => {
        for (const card of document.querySelectorAll('[data-uec-card]')) {
            if (card.classList.contains('uec-hidden-by-filter')) continue;
            const cb = card.querySelector('.uec-listing-check input');
            if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    });
    clearBtn.addEventListener('click', () => {
        for (const card of document.querySelectorAll('[data-uec-card]')) {
            const cb = card.querySelector('.uec-listing-check input');
            if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    //  Logging helpers
    // ────────────────────────────────────────────────────────────────────────
    function log(msg, cls) {
        const line = h('div', { class: cls || '' }, '• ' + msg);
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }
    function setStatus(s) { statusEl.textContent = s; }
    function updateCount() {
        document.getElementById('uec-count').textContent = String(state.selections.size);
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Listing extraction — Etsy & eBay
    // ────────────────────────────────────────────────────────────────────────
    /**
     * Return an array of {card, data} objects for every listing card on the
     * current page. The `card` is the root DOM node we attach the checkbox
     * to; `data` is {title, url, price, image, country, site}.
     */
    function findListings() {
        const results = [];

        if (SITE === 'etsy') {
            // Etsy search/category cards
            const nodes = document.querySelectorAll(
                'ul.responsive-listing-grid > li, li.wt-list-unstyled, li[data-palette-listing-id], div[data-listing-id]'
            );
            nodes.forEach(node => {
                const link = node.querySelector('a.listing-link, a[href*="/listing/"]');
                if (!link) return;
                const url = cleanUrl(link.href);
                if (!url) return;
                const title =
                    (node.querySelector('h3, .v2-listing-card__title, [data-listing-title]')?.textContent
                    || link.getAttribute('title') || link.textContent || '').trim();
                const price =
                    (node.querySelector('.currency-value, .n-listing-card__price, p.lc-price, span.currency-value')?.textContent
                    || node.querySelector('[class*="price"]')?.textContent || '').replace(/\s+/g, ' ').trim();
                const img = node.querySelector('img');
                const image = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
                // Etsy rarely shows country on the search card, but sometimes a
                // "ships from" line is present.
                const country = (node.querySelector('[data-listing-card-ship-from], .wt-text-caption.wt-text-gray')?.textContent || '').trim();
                results.push({
                    card: node,
                    data: { title, url, price, image: normalizeImage(image), country, site: 'etsy' }
                });
            });
        } else if (SITE === 'ebay') {
            const nodes = document.querySelectorAll('li.s-item, li.s-card, div.s-item__wrapper');
            nodes.forEach(node => {
                // Container we want to pin the checkbox to:
                const card = node.closest('li') || node;
                const link = card.querySelector('a.s-item__link, a.su-link, a[href*="/itm/"]');
                if (!link) return;
                const url = cleanUrl(link.href);
                if (!url || /ebay\.com\/itm\/123456$/.test(url)) return; // skip the fake "template" item
                const title = (card.querySelector('.s-item__title, .su-styled-text')?.textContent || '').trim();
                if (!title || /Shop on eBay/i.test(title)) return;
                const price = (card.querySelector('.s-item__price')?.textContent || '').trim();
                const img = card.querySelector('img');
                let image = '';
                if (img) {
                    image = img.getAttribute('src') || img.getAttribute('data-src') || '';
                    // eBay often uses a 1x1 placeholder with real URL in data-src
                    if (!image || /s-l1\.gif/.test(image)) {
                        image = img.getAttribute('data-src') || img.getAttribute('data-defer-load') || image;
                    }
                }
                const country = (card.querySelector('.s-item__location, .s-item__itemLocation')?.textContent
                              || '').replace(/^from\s+/i, '').trim();
                results.push({
                    card,
                    data: { title, url, price, image: normalizeImage(image), country, site: 'ebay' }
                });
            });
        }
        return results;
    }

    function cleanUrl(u) {
        try {
            const url = new URL(u, location.href);
            // Strip tracking junk so our "same URL" dedupe works.
            ['_gl', '_trkparms', '_trksid', 'hash', 'epid', 'var', 'amdata',
             'ref', 'pro', 'frs', 'sca_esv', 'logevent',
             'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
             'click_key', 'click_sum', 'plkey', 'bes', 'col'
            ].forEach(k => url.searchParams.delete(k));
            // Etsy listing URLs are canonical at /listing/<id>/<slug>
            const m = url.pathname.match(/\/listing\/(\d+)/);
            if (m) { url.pathname = '/listing/' + m[1]; url.search = ''; }
            const m2 = url.pathname.match(/\/itm\/(\d+)/);
            if (m2) { url.pathname = '/itm/' + m2[1]; url.search = ''; }
            url.hash = '';
            return url.toString();
        } catch (e) { return ''; }
    }

    function normalizeImage(src) {
        if (!src) return '';
        // Upgrade eBay thumbs (s-l140, s-l225) to the largest available.
        src = src.replace(/\/s-l\d+\./, '/s-l1600.');
        // Upgrade Etsy thumb sizes where possible.
        src = src.replace(/il_\d+x\d+\./, 'il_fullxfull.');
        src = src.replace(/il_\d+xN\./, 'il_fullxfull.');
        // Protocol-relative → https
        if (src.startsWith('//')) src = 'https:' + src;
        return src;
    }

    function matchesFilters(data) {
        if (state.keyword && !(data.title + ' ' + (data.price || '')).toLowerCase().includes(state.keyword)) {
            return false;
        }
        if (state.countries.has('Any') || state.countries.size === 0) return true;
        if (!data.country) return false;
        const hay = data.country.toLowerCase();
        for (const c of state.countries) {
            if (c === 'Any') continue;
            if (hay.includes(c.toLowerCase())) return true;
            // Accept common abbreviations
            if (c === 'United States' && /\b(usa|u\.s\.a?\.|united states)\b/i.test(hay)) return true;
            if (c === 'United Kingdom' && /\b(uk|u\.k\.|great britain|england|scotland|wales)\b/i.test(hay)) return true;
        }
        return false;
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Inject checkboxes + maintain them when the page re-renders
    // ────────────────────────────────────────────────────────────────────────
    function attachCheckboxes() {
        const listings = findListings();
        for (const { card, data } of listings) {
            if (!card || card.dataset.uecCard) continue;
            card.dataset.uecCard = '1';
            // Make the card a positioning context without disturbing layout
            const cs = getComputedStyle(card);
            if (cs.position === 'static') card.style.position = 'relative';

            const input = h('input', { type: 'checkbox' });
            input.checked = state.selections.has(data.url);
            input.addEventListener('click', e => e.stopPropagation());
            input.addEventListener('change', () => {
                if (input.checked) state.selections.set(data.url, data);
                else state.selections.delete(data.url);
                updateCount();
            });
            const wrap = h('div', { class: 'uec-listing-check', title: data.title }, input);
            wrap.addEventListener('click', e => {
                // If the click lands on the div rather than the input, toggle.
                if (e.target === wrap) {
                    e.preventDefault(); e.stopPropagation();
                    input.checked = !input.checked;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            card.appendChild(wrap);
            card._uecData = data;
        }
        applyFilters();
    }

    function applyFilters() {
        document.querySelectorAll('[data-uec-card]').forEach(card => {
            const d = card._uecData;
            if (!d) return;
            const ok = matchesFilters(d);
            card.classList.toggle('uec-hidden-by-filter', !ok);
        });
    }

    // Run once now, and re-run whenever the page mutates (eBay/Etsy both do
    // virtual pagination + lazy loading).
    const obs = new MutationObserver(throttle(attachCheckboxes, 400));
    obs.observe(document.body, { childList: true, subtree: true });
    attachCheckboxes();

    function throttle(fn, ms) {
        let t = 0, pending = false;
        return function () {
            const now = Date.now();
            if (now - t > ms) { t = now; fn(); }
            else if (!pending) {
                pending = true;
                setTimeout(() => { pending = false; t = Date.now(); fn(); }, ms);
            }
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Save flow
    // ────────────────────────────────────────────────────────────────────────
    saveBtn.addEventListener('click', async () => {
        if (!CONFIG.WEB_APP_URL || CONFIG.WEB_APP_URL.startsWith('PUT_YOUR_')) {
            setStatus('Please fill in CONFIG.WEB_APP_URL, SHEET_ID and DRIVE_FOLDER_ID at the top of the script.');
            return;
        }
        if (state.selections.size === 0) {
            setStatus('Nothing selected yet — tick some listings first.');
            return;
        }
        saveBtn.disabled = true;
        const items = Array.from(state.selections.values());
        setStatus(`Sending ${items.length} listing(s) to Google…`);
        log(`Starting upload of ${items.length} listing(s).`);

        let ok = 0, dup = 0, fail = 0;
        for (const item of items) {
            try {
                const result = await sendOne(item);
                if (result.status === 'added')       { ok++;  log(`✓ Added: ${trunc(item.title)}`, 'ok'); }
                else if (result.status === 'duplicate') { dup++; log(`= Duplicate skipped: ${trunc(item.title)}`, 'warn'); }
                else                                 { fail++; log(`✗ ${result.message || 'Error'}: ${trunc(item.title)}`, 'err'); }
            } catch (err) {
                fail++;
                log(`✗ Network error: ${err && err.message ? err.message : err}`, 'err');
            }
            setStatus(`Added ${ok} · Duplicates ${dup} · Errors ${fail} / ${items.length}`);
        }
        setStatus(`Done. Added ${ok}, duplicates ${dup}, errors ${fail}.`);
        saveBtn.disabled = false;
    });

    function trunc(s) { return (s || '').length > 50 ? s.slice(0, 47) + '…' : s; }

    function sendOne(item) {
        return new Promise((resolve, reject) => {
            if (!gmXHR) return reject(new Error('GM_xmlhttpRequest not available'));
            const payload = {
                secret:  CONFIG.SHARED_SECRET || '',
                sheetId: CONFIG.SHEET_ID,
                folderId:CONFIG.DRIVE_FOLDER_ID,
                listing: {
                    site:    item.site,
                    title:   item.title,
                    url:     item.url,
                    price:   item.price || '',
                    country: item.country || '',
                    image:   item.image || '',
                    capturedAt: new Date().toISOString(),
                    pageUrl: location.href
                }
            };
            gmXHR({
                method: 'POST',
                url: CONFIG.WEB_APP_URL,
                // Use text/plain to avoid Apps Script CORS preflight.
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                data: JSON.stringify(payload),
                timeout: 60000,
                onload: (r) => {
                    try {
                        const body = JSON.parse(r.responseText);
                        resolve(body);
                    } catch (e) {
                        resolve({ status: 'error', message: 'Bad response: ' + r.responseText?.slice(0, 120) });
                    }
                },
                onerror:   () => resolve({ status: 'error', message: 'Network error' }),
                ontimeout: () => resolve({ status: 'error', message: 'Timeout' })
            });
        });
    }
})();

/* ============================================================================
 *  APPS SCRIPT — paste into Code.gs of the Sheet-bound Apps Script project
 * ============================================================================
 *
 *  // Optional: set to a random string and copy the same value into
 *  // CONFIG.SHARED_SECRET in the userscript. Leave '' to disable.
 *  const SHARED_SECRET = '';
 *
 *  function doPost(e) {
 *    try {
 *      const body = JSON.parse(e.postData.contents);
 *      if (SHARED_SECRET && body.secret !== SHARED_SECRET) {
 *        return _json({ status: 'error', message: 'Bad secret' });
 *      }
 *      const ss = SpreadsheetApp.openById(body.sheetId);
 *      const sheet = ss.getSheets()[0];
 *      if (sheet.getLastRow() === 0) {
 *        sheet.appendRow([
 *          'Captured', 'Site', 'Title', 'URL', 'Price', 'Country', 'Image'
 *        ]);
 *        sheet.setFrozenRows(1);
 *      }
 *      // Dedupe by listing URL (column D)
 *      const urlCol = sheet.getRange(2, 4, Math.max(1, sheet.getLastRow() - 1), 1).getValues();
 *      for (let i = 0; i < urlCol.length; i++) {
 *        if (urlCol[i][0] === body.listing.url) {
 *          return _json({ status: 'duplicate' });
 *        }
 *      }
 *      // Upload image to Drive
 *      let driveUrl = '';
 *      if (body.listing.image) {
 *        try {
 *          const folder = DriveApp.getFolderById(body.folderId);
 *          const resp = UrlFetchApp.fetch(body.listing.image, { muteHttpExceptions: true });
 *          if (resp.getResponseCode() === 200) {
 *            const blob = resp.getBlob().setName(_safeName(body.listing) + _ext(resp));
 *            const file = folder.createFile(blob);
 *            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
 *            driveUrl = 'https://drive.google.com/uc?export=view&id=' + file.getId();
 *          }
 *        } catch (imgErr) {
 *          // Fall back to original URL so the sheet still has something
 *          driveUrl = body.listing.image;
 *        }
 *      }
 *      sheet.appendRow([
 *        body.listing.capturedAt,
 *        body.listing.site,
 *        body.listing.title,
 *        body.listing.url,
 *        body.listing.price,
 *        body.listing.country,
 *        driveUrl ? '=IMAGE("' + driveUrl.replace(/"/g,'""') + '")' : ''
 *      ]);
 *      // Give the image row a little height so it's visible
 *      const row = sheet.getLastRow();
 *      sheet.setRowHeight(row, 120);
 *      sheet.setColumnWidth(7, 140);
 *      return _json({ status: 'added' });
 *    } catch (err) {
 *      return _json({ status: 'error', message: String(err) });
 *    }
 *  }
 *
 *  function doGet() { return _json({ status: 'ok' }); }
 *
 *  function _json(obj) {
 *    return ContentService
 *      .createTextOutput(JSON.stringify(obj))
 *      .setMimeType(ContentService.MimeType.JSON);
 *  }
 *  function _safeName(l) {
 *    return (l.site + '_' + (l.title || 'listing')).replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,80);
 *  }
 *  function _ext(resp) {
 *    const ct = (resp.getHeaders()['Content-Type'] || '').toLowerCase();
 *    if (ct.indexOf('png')  !== -1) return '.png';
 *    if (ct.indexOf('webp') !== -1) return '.webp';
 *    if (ct.indexOf('gif')  !== -1) return '.gif';
 *    return '.jpg';
 *  }
 * ============================================================================
 */
