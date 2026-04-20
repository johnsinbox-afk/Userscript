// ==UserScript==
// @name         Etsy & eBay & Facebook Listing / Ad Collector → Google Sheets
// @namespace    https://github.com/your-handle/userscripts
// @version      2.1.0
// @description  Floating overlay for Etsy, eBay search, eBay stores, eBay Seller Hub Research, Facebook Ad Library, and Facebook feed. Filter, tick, copy, save. Mobile friendly.
// @author       You
// @match        https://www.etsy.com/*search*
// @match        https://www.etsy.com/search*
// @match        https://www.etsy.com/c/*
// @match        https://www.etsy.com/market/*
// @match        https://www.etsy.com/shop/*
// @match        https://*.etsy.com/*search*
// @match        https://www.ebay.com/sch/*
// @match        https://*.ebay.com/sch/*
// @match        https://www.ebay.com/b/*
// @match        https://www.ebay.com/str/*
// @match        https://*.ebay.com/str/*
// @match        https://www.ebay.com/sh/research*
// @match        https://www.ebay.com/sh/research/*
// @match        https://www.facebook.com/*
// @match        https://*.facebook.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      googleusercontent.com
// @connect      www.ebay.com
// @connect      ebay.com
// @connect      m.ebay.com
// @connect      www.etsy.com
// @connect      etsy.com
// @connect      i.etsystatic.com
// @connect      www.facebook.com
// @connect      facebook.com
// @connect      *.fbcdn.net
// @run-at       document-idle
// ==/UserScript==

/* ============================================================================
 *  SETUP INSTRUCTIONS — READ ME FIRST
 * ============================================================================
 *
 *  This script does two things on Etsy / eBay search / eBay store / eBay
 *  Seller Hub Research pages:
 *
 *    1. Adds a clean floating overlay that lets you filter by keyword
 *       (AND / OR / NOT) and by country, tick individual listings, and
 *       copy rich tables (with images) or IDs / URLs to your clipboard.
 *
 *    2. "Save Selected to Google Sheets" button → POSTs each selection to a
 *       Google Apps Script Web App that uploads the main image to a Drive
 *       folder and appends a row using =IMAGE(...) so the image renders
 *       permanently. De-duplicates by listing URL + item number.
 *
 *  You only need to do the Google side ONCE.
 *
 *  ── STEP 1 ─ Create a Google Sheet ─────────────────────────────────────────
 *  • https://sheets.new — rename it (e.g. "Listing Collector").
 *  • Copy the ID from the URL between /d/ and /edit — this is SHEET_ID.
 *
 *  ── STEP 2 ─ Create a Drive folder ─────────────────────────────────────────
 *  • https://drive.google.com → New → Folder → open it.
 *  • Copy the ID after /folders/ — this is DRIVE_FOLDER_ID.
 *
 *  ── STEP 3 ─ Deploy the Apps Script Web App ────────────────────────────────
 *  • In your Sheet → Extensions → Apps Script.
 *  • Replace Code.gs with the server script from the block labelled
 *    "APPS SCRIPT — paste into Code.gs" at the bottom of this file.
 *  • Save → Deploy → New deployment → Type: Web app
 *         Execute as: Me
 *         Who has access: Anyone
 *  • Authorize (click Advanced → Go to … (unsafe) → Allow on first run).
 *  • Copy the Web app URL ending in /exec — this is WEB_APP_URL.
 *
 *  ── STEP 4 ─ (Optional) shared secret ──────────────────────────────────────
 *  • Set SHARED_SECRET in Apps Script and CONFIG.SHARED_SECRET below to the
 *    same random string for a tiny bit of extra safety. Leave '' to skip.
 *
 *  ── STEP 5 ─ Install in Safari / Tampermonkey / Violentmonkey ──────────────
 *  • Paste this entire file into a new userscript. Save. Visit a supported
 *    page. A round "List" button appears bottom-right.
 *
 *  That's it. Tick listings, choose countries, press "Save Selected to
 *  Google Sheets". Duplicates are skipped automatically.
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
        SHARED_SECRET:   '',                 // optional
        OPEN_PANEL_BY_DEFAULT: false,        // auto-open the overlay on load
        COPY_TABLE_ROW_HEIGHT_PX: 210,       // height used for Copy Table rows so images render nicely in Sheets
        ENRICH_CONCURRENCY: 3,               // max parallel item-page fetches
        // Default state of the "Enrich before save" toggle in the panel.
        // You can flip this in the panel at any time; this is just the start-up value.
        ENRICH_BEFORE_SAVE_DEFAULT: false
    };

    // ────────────────────────────────────────────────────────────────────────
    //  Cross-manager helpers (Tampermonkey vs Safari "Userscripts" differ)
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
    //  Site / mode detection
    //  SITE  : 'etsy' | 'ebay'
    //  MODE  : 'etsy-search' | 'ebay-search' | 'ebay-store' | 'ebay-research'
    // ────────────────────────────────────────────────────────────────────────
    const host = location.hostname.toLowerCase();
    const isEtsy = /(^|\.)etsy\.com$/i.test(host);
    const isEbay = /(^|\.)ebay\./i.test(host);
    if (!isEtsy && !isEbay) return;

    // Per-mode selector map. Auto-detection picks the first mode whose
    // "card" selector has a matching element on the page.
    const MODES = {
        'etsy-search': {
            site: 'etsy',
            card:  '.v2-listing-card[data-listing-id]',
            title: 'h3, h2, a.listing-link, [data-listing-card-title]',
            price: '.currency-value, [data-listing-price], [data-buy-box-region="price"] .currency-value',
            image: 'img[srcset], img[src]'
        },
        'ebay-research': {
            site: 'ebay',
            card:  'tr.research-table-row',
            title: '.research-table-row__product-info-name span[data-item-id], span[data-item-id]',
            price: '.research-table-row__avgSoldPrice',
            image: 'img'
        },
        'ebay-store': {
            site: 'ebay',
            card:  'article.StoreFrontItemCard, article.str-item-card.StoreFrontItemCard',
            title: '.str-card-title .str-text-span, .str-item-card__property-title .str-text-span',
            price: '.str-item-card__property-displayPrice',
            image: 'img[data-testid="str-img"], .str-image img, img.zoom'
        },
        'ebay-search': {
            site: 'ebay',
            card:  '.su-card-container',
            title: '.s-card__title',
            price: '.s-card__price',
            image: 'img.s-card__image'
        }
    };

    function detectMode() {
        if (isEtsy) return 'etsy-search';
        // eBay has three layouts that can share a host — probe the DOM.
        for (const m of ['ebay-research', 'ebay-store', 'ebay-search']) {
            if (document.querySelector(MODES[m].card)) return m;
        }
        return 'ebay-search';
    }
    let MODE   = detectMode();
    let CFG    = MODES[MODE];
    const SITE = CFG.site;

    // Re-detect on DOM mutation (eBay sometimes lazy-renders after page load).
    function maybeUpgradeMode() {
        if (MODE !== 'ebay-search') return;
        for (const m of ['ebay-research', 'ebay-store']) {
            if (document.querySelector(MODES[m].card)) { MODE = m; CFG = MODES[m]; return; }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Styles
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
        width:360px; max-width:calc(100vw - 28px);
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
    .uec-head .uec-mode{font-size:11px; opacity:.85; font-weight:400;}
    .uec-head button{
        background:transparent; color:#fff; border:none; font-size:18px;
        cursor:pointer; line-height:1; padding:4px 8px;
    }
    .uec-body{padding:12px 14px; overflow:auto; flex:1;}
    .uec-body label.uec-lbl{font-weight:600; display:block; margin:0 0 6px;}
    .uec-body input[type=text]{
        width:100%; box-sizing:border-box; padding:8px 10px;
        border:1px solid #ccd2db; border-radius:8px; font:inherit;
    }
    .uec-hint{font-size:11.5px; color:#666; margin-top:4px;}
    .uec-country-box{
        max-height:130px; overflow:auto; border:1px solid #e4e7ee;
        border-radius:8px; padding:6px 8px; margin-top:4px; background:#fafbfd;
    }
    .uec-country-box label{
        font-weight:400; display:flex; align-items:center; gap:6px;
        padding:2px 0; margin:0; font-size:12.5px;
    }
    .uec-row{display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;}
    .uec-row button{
        flex:1 1 auto; padding:8px 10px; border:1px solid #ccd2db; border-radius:8px;
        background:#f4f6fa; cursor:pointer; font:inherit; min-width:0;
    }
    .uec-row button.primary{
        background:#1f7ae0; color:#fff; border-color:#1f7ae0; font-weight:600;
    }
    .uec-row button.success{ background:#107c10; color:#fff; border-color:#107c10; font-weight:600; }
    .uec-row button.warn   { background:#ffc107; color:#222;  border-color:#ffc107; }
    .uec-row button.violet { background:#6f42c1; color:#fff; border-color:#6f42c1; }
    .uec-row button:disabled{opacity:.6; cursor:not-allowed;}
    .uec-status{ margin-top:10px; font-size:12px; color:#555; min-height:16px; white-space:pre-wrap; }
    .uec-log{
        margin-top:8px; font-size:11.5px; max-height:110px; overflow:auto;
        background:#0e1116; color:#cfd3dc; border-radius:8px; padding:6px 8px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    }
    .uec-log .ok{color:#7ee787;}
    .uec-log .err{color:#ff7b72;}
    .uec-log .warn{color:#f2cc60;}

    /* Per-listing checkbox */
    .uec-listing-check{
        position:absolute; top:6px; left:6px; z-index:50;
        width:28px; height:28px; border-radius:6px;
        background:rgba(255,255,255,.92); backdrop-filter:blur(6px);
        display:flex; align-items:center; justify-content:center;
        box-shadow:0 1px 4px rgba(0,0,0,.2);
        cursor:pointer;
    }
    .uec-listing-check input{
        width:20px; height:20px; margin:0; cursor:pointer; accent-color:#1f7ae0;
    }
    .uec-ship-badge{
        position:absolute; top:40px; left:6px; z-index:50;
        font-size:10.5px; background:rgba(0,0,0,.75); color:#fff;
        padding:2px 6px; border-radius:4px; pointer-events:none;
        max-width:160px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .uec-hidden-by-filter{display:none !important;}

    /* Mobile tweaks */
    @media (max-width: 520px){
        .uec-panel{right:6px; left:6px; width:auto; bottom:74px;}
        .uec-toggle{right:10px; bottom:10px; width:52px; height:52px;}
        .uec-listing-check{width:32px; height:32px;}
        .uec-listing-check input{width:22px; height:22px;}
    }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.documentElement.appendChild(styleEl);

    // ────────────────────────────────────────────────────────────────────────
    //  Tiny DOM helper
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
    const textOf = el => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

    // ────────────────────────────────────────────────────────────────────────
    //  URL / image normalization
    // ────────────────────────────────────────────────────────────────────────
    function cleanUrl(u) {
        if (!u) return '';
        try {
            const url = new URL(u, location.href);
            // Strip common tracking params so dedupe by URL is stable.
            ['_gl','_trkparms','_trksid','hash','epid','var','amdata','ref','pro','frs',
             'sca_esv','logevent','utm_source','utm_medium','utm_campaign','utm_content',
             'utm_term','click_key','click_sum','plkey','bes','col'
            ].forEach(k => url.searchParams.delete(k));
            const m1 = url.pathname.match(/\/listing\/(\d+)/);
            if (m1) { url.pathname = '/listing/' + m1[1]; url.search = ''; }
            const m2 = url.pathname.match(/\/itm\/(\d+)/);
            if (m2) { url.pathname = '/itm/' + m2[1]; url.search = ''; }
            url.hash = '';
            return url.toString();
        } catch (e) { return u; }
    }
    function absUrl(u) {
        if (!u) return '';
        if (u.startsWith('//')) return 'https:' + u;
        if (u.startsWith('/'))  return location.origin + u;
        return u;
    }
    function normalizeImgSrc(img) {
        if (!img) return '';
        let src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-defer-load') || '';
        if (!src) {
            const srcset = img.getAttribute('srcset') || '';
            const last = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean).pop();
            if (last) src = last;
        }
        if (!src) return '';
        src = absUrl(src);
        // eBay: upgrade any s-l<size> thumbnail to s-l1600
        src = src.replace(/\/s-l\d+\./, '/s-l1600.');
        // Etsy: upgrade il_<WxH> to il_fullxfull
        src = src.replace(/il_\d+x\d+\./, 'il_fullxfull.');
        src = src.replace(/il_\d+xN\./,   'il_fullxfull.');
        // Drop query after extension so URL is clean and cacheable
        const m = src.match(/^(.*?\.(?:jpe?g|png|webp|gif))(?:\?|$)/i);
        if (m) src = m[1];
        return src;
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Seller / country / tooltip helpers
    // ────────────────────────────────────────────────────────────────────────
    function cleanSellerText(s) {
        if (!s) return '';
        s = s.replace(/\s{2,}/g, ' ').trim().replace(/\s+Top Rated Plus$/i, '').trim();
        const cuts = [/\s+\d{1,3}(?:\.\d)?%\s*positive.*/i, /\s+positive.*/i, /\s*\(.*/];
        for (const r of cuts) if (r.test(s)) { s = s.replace(r, '').trim(); break; }
        return s;
    }
    function looksLikeSeller(v) {
        if (!v) return false;
        const s = v.toLowerCase();
        if (/(^item:|positive|top rated|sponsored|free returns|almost gone|sold\b|available\b|located in)/i.test(s)) return false;
        if (/^\d+(?:\.\d+)?%$/.test(s)) return false;
        return true;
    }
    function getEtsySeller(card) {
        let seller = '';
        const shopNameEl = card.querySelector('span.clickable-shop-name[data-seller-name-link]');
        if (shopNameEl) seller = textOf(shopNameEl);
        if (!seller) {
            const a = card.querySelector('a[href*="/shop/"]');
            if (a) seller = textOf(a);
        }
        if (!seller) {
            const ds = (card.getAttribute('data-shop-name') || (card.dataset && card.dataset.shopName) || '').trim();
            if (ds) seller = ds;
        }
        return seller;
    }
    function getEbaySearchSeller(card) {
        let seller = cleanSellerText(textOf(
            card.querySelector('.s-card__program-badge-container.s-card__program-badge-container--sellerOrStoreInfo [class*="su-styled-text"]')
            || card.querySelector('.su-card-container__attributes__secondary .s-card__attribute-row [class*="su-styled-text"].default')
        ));
        if (!looksLikeSeller(seller)) seller = '';
        if (!seller) {
            const tert = card.querySelector('.su-card-container__attributes__tertiary .s-card__attribute-row');
            if (tert) {
                for (const sp of tert.querySelectorAll('span.su-styled-text')) {
                    const cand = cleanSellerText(textOf(sp));
                    if (looksLikeSeller(cand)) { seller = cand; break; }
                }
            }
        }
        if (!seller) {
            const a = card.querySelector('a[href*="_ssn="]');
            const m = a && a.href.match(/[_?&]_ssn=([^&]+)/);
            if (m) seller = decodeURIComponent(m[1]);
        }
        return seller;
    }
    function getEbayStoreSeller() {
        try {
            const a = document.querySelector('a[href*="_ssn="]');
            let m = a && a.href.match(/[_?&]_ssn=([^&]+)/);
            if (!m) m = location.href.match(/[_?&]_ssn=([^&]+)/);
            if (m) return decodeURIComponent(m[1]);
            // str/<seller>/... pattern
            const m2 = location.pathname.match(/\/str\/([^\/?]+)/);
            if (m2) return decodeURIComponent(m2[1]);
        } catch (e) {}
        return '';
    }
    function parseEtsyTooltip(card) {
        // Etsy search sometimes has a shop-popover tooltip with owner + age + sales + country.
        const out = { owner: '', accountAge: '', totalSales: '', country: '' };
        const tip = card.querySelector('button.shop-popover-tooltip[role=tooltip], button[role=tooltip][data-shop-popover-link]');
        if (!tip) return out;
        const locDiv = tip.querySelector('.shop-popover-seller-details div');
        if (locDiv) out.country = textOf(locDiv);
        const strong = tip.querySelector('p.wt-text-body strong');
        if (strong) out.owner = textOf(strong).replace(/,\s*$/, '');
        const txt = textOf(tip.querySelector('.shop-popover-seller-details') || tip);
        const age = txt.match(/(\d+\s+(?:months?|years?))\s+on Etsy/i);
        if (age) out.accountAge = age[1];
        const sales = txt.match(/(\d+(?:\.\d+)?k?)\s*sales/i);
        if (sales) {
            const raw = (sales[1] || '').toLowerCase();
            out.totalSales = raw.endsWith('k') ? String(Math.round(parseFloat(raw) * 1000)) : raw;
        }
        return out;
    }
    function getEtsyCountry(card) {
        const el = Array.from(card.querySelectorAll('span, p')).find(e => /Ships from/i.test(e.textContent || ''));
        if (el) return (el.textContent || '').replace(/^.*?:\s*/, '').replace(/^Ships from\s*/i, '').trim();
        const tipLoc = card.querySelector('button.shop-popover-tooltip .shop-popover-seller-details div');
        if (tipLoc) return textOf(tipLoc);
        return '';
    }
    function getEbaySearchCountry(card) {
        // Desktop eBay markup
        let el = Array.from(card.querySelectorAll('.su-card-container__attributes__primary .s-card__attribute-row span.su-styled-text.secondary.large'))
            .find(s => /Located in/i.test(s.textContent || ''));
        if (el) return textOf(el).replace(/^Located in\s*/i, '').trim();
        // Mobile / alternate markup: any span or div in the card containing "Located in …"
        const containers = [card, card.closest('li.s-item'), card.closest('li.s-card')].filter(Boolean);
        for (const c of containers) {
            const alt = Array.from(c.querySelectorAll('span, div, p'))
                .find(n => /Located in\s+/i.test((n.textContent || '').replace(/\s+/g, ' ').trim()) &&
                           !n.querySelector('span, div, p'));
            if (alt) {
                const m = (alt.textContent || '').match(/Located in\s+([^.\n]+?)(?:\s{2,}|$)/i);
                if (m) return m[1].trim();
            }
            // "from <country>" on the s-item__location element
            const loc = c.querySelector && c.querySelector('.s-item__location, .s-item__itemLocation');
            if (loc) return textOf(loc).replace(/^from\s+/i, '').trim();
        }
        return '';
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Exclusion zones (skip "Recommended for you", carousels, below-pagination)
    // ────────────────────────────────────────────────────────────────────────
    const RECS_PATTERNS = /recommended for you|you may also like|similar items|more ideas|popular now|more from this shop|pick up where you left off|recent(ly)?\s+viewed/i;
    function findPaginationBottom() {
        const cands = Array.from(document.querySelectorAll(
            'nav[aria-label*="pagination" i], nav[role="navigation"][aria-label*="pagination" i], .wt-action-group__list--pagination, nav.pagination, [data-pagination]'
        )).filter(el => el.offsetParent !== null);
        let bottom = -Infinity;
        cands.forEach(el => { const r = el.getBoundingClientRect(); bottom = Math.max(bottom, r.bottom + window.scrollY); });
        return bottom > -Infinity ? bottom : Infinity;
    }
    let PAG_BOTTOM = Infinity;
    function isBelowPagination(card) {
        if (!isFinite(PAG_BOTTOM)) return false;
        const r = card.getBoundingClientRect();
        return (r.top + window.scrollY) > PAG_BOTTOM + 5;
    }
    function isUnderExcludedHeading(card) {
        let node = card;
        for (let d = 0; d < 8 && node; d++) {
            const heading = node.querySelector && node.querySelector('h2, h3, [role="heading"], .wt-text-title, .module-title, .title');
            if (heading && RECS_PATTERNS.test(heading.textContent || '')) return true;
            const aria = (node.getAttribute && node.getAttribute('aria-label')) || '';
            if (RECS_PATTERNS.test(aria)) return true;
            node = node.parentElement;
        }
        return false;
    }
    function isInCarouselOrSrpAnswer(card) {
        return !!(card.closest && (
            card.closest('li.srp-river-answer') ||
            card.closest('.s-card-carousel') ||
            card.closest('.carousel') ||
            card.closest('[aria-roledescription="Carousel"]')
        ));
    }
    const ETSY_SEARCH_ROOTS = () => (isEtsy ? Array.from(document.querySelectorAll('div[data-search-results-container], div[data-search-results]')) : []);
    function isEtsyCardInScope(card) {
        const roots = ETSY_SEARCH_ROOTS();
        if (roots.length) return roots.some(r => r.contains(card));
        const hasShopCards = !!document.querySelector('.v2-listing-card[data-page-type="shop"][data-listing-id]');
        if (hasShopCards) {
            const pt = card.getAttribute('data-page-type') || (card.dataset && card.dataset.pageType) || '';
            return String(pt).toLowerCase() === 'shop';
        }
        return true;
    }
    function isCardEligible(card) {
        if (isBelowPagination(card)) return false;
        if (isUnderExcludedHeading(card)) return false;
        if (isInCarouselOrSrpAnswer(card)) return false;
        if (isEtsy && !isEtsyCardInScope(card)) return false;
        return true;
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Per-mode field extraction
    //  Returns { title, url, image, price, seller, owner, accountAge,
    //            totalSales, itemNumber, country, avgPrice, avgShipping,
    //            totalSold, sales, lastSold, available, sold }
    // ────────────────────────────────────────────────────────────────────────
    function extractEtsy(card) {
        const titleEl = card.querySelector(CFG.title);
        const title = textOf(titleEl) || '[No Title]';
        let a = card.querySelector('a[href*="/listing/"]');
        let url = a && a.href ? cleanUrl(a.href) : '';
        const image = normalizeImgSrc(card.querySelector(CFG.image));
        let price = '';
        const pEl = card.querySelector(CFG.price);
        if (pEl) {
            const sym = pEl.previousElementSibling && /[$€£¥]/.test(pEl.previousElementSibling.textContent || '') ? pEl.previousElementSibling : null;
            price = ((sym ? sym.textContent : '') + pEl.textContent).trim() || textOf(pEl);
        }
        const seller = getEtsySeller(card);
        const tip    = parseEtsyTooltip(card);
        let itemNumber = '';
        if (a && a.href) { const m = a.href.match(/\/listing\/(\d+)/); if (m) itemNumber = m[1]; }
        if (!itemNumber && card.dataset && card.dataset.listingId) itemNumber = String(card.dataset.listingId).trim();
        const country = getEtsyCountry(card) || tip.country || '';
        return {
            title, url, image, price, seller,
            owner: tip.owner, accountAge: tip.accountAge, totalSales: tip.totalSales,
            itemNumber, country,
            avgPrice:'', avgShipping:'', totalSold:'', sales:'', lastSold:'',
            available:'', sold:'',
            // Enrichment (filled by enrichOne when "Enrich" is pressed or
            // "Enrich before save" is ticked):
            shopSales:'', shopRating:'', shopReviews:'', shopAdmirers:'',
            favorites:'', tags:'', materials:'', shopLocation:'',
            condition:'', handlingTime:'', returns:'',
            sellerFeedbackScore:'', sellerPositivePct:''
        };
    }
    function extractEbaySearch(card) {
        const titleEl = card.querySelector(CFG.title);
        const title = textOf(titleEl) || '[No Title]';
        let url = '';
        const linkFromTitle = titleEl && titleEl.closest('a');
        if (linkFromTitle && linkFromTitle.href) url = cleanUrl(linkFromTitle.href);
        if (!url) {
            const a = card.querySelector('a[href*="/itm/"]');
            if (a && a.href) url = cleanUrl(a.href);
        }
        const image = normalizeImgSrc(card.querySelector(CFG.image));
        const price = textOf(card.querySelector(CFG.price));
        const seller = getEbaySearchSeller(card);
        // Prefer li[data-listingid] (12-digit id) when present.
        let itemNumber = '';
        const liWithId = card.closest && card.closest('li[data-listingid]');
        if (liWithId) itemNumber = (liWithId.getAttribute('data-listingid') || '').trim();
        if (!/^\d{6,}$/.test(itemNumber)) itemNumber = '';
        if (!itemNumber) {
            const m = (url || '').match(/\/itm\/(\d+)/); if (m) itemNumber = m[1];
        }
        if (!itemNumber) {
            const txt = textOf(Array.from(card.querySelectorAll('.su-card-container__attributes__secondary .s-card__attribute-row span.su-styled-text.secondary.large'))
                .find(s => /Item\s*:/.test(s.textContent || '')) || null);
            const m = txt.match(/Item\s*:\s*(\d+)/i); if (m) itemNumber = m[1];
        }
        const country = getEbaySearchCountry(card);
        return {
            title, url, image, price, seller,
            owner:'', accountAge:'', totalSales:'',
            itemNumber, country,
            avgPrice:'', avgShipping:'', totalSold:'', sales:'', lastSold:'',
            available:'', sold:'',
            shopSales:'', shopRating:'', shopReviews:'', shopAdmirers:'',
            favorites:'', tags:'', materials:'', shopLocation:'',
            condition:'', handlingTime:'', returns:'',
            sellerFeedbackScore:'', sellerPositivePct:''
        };
    }
    function extractEbayStore(card) {
        const titleEl = card.querySelector(CFG.title);
        const title = textOf(titleEl) || '[No Title]';
        const a = card.querySelector('a[href*="/itm/"]') || card.querySelector('a.str-item-card__link');
        let url = a && a.href ? cleanUrl(a.href) : '';
        const image = normalizeImgSrc(card.querySelector(CFG.image));
        const price = textOf(card.querySelector(CFG.price));
        const seller = getEbayStoreSeller();
        let itemNumber = '';
        if (a && a.href) { const m = a.href.match(/\/itm\/(\d+)/); if (m) itemNumber = m[1]; }
        if (!itemNumber) {
            const dt = (card.getAttribute('data-testid') || '') + ((card.dataset && card.dataset.testid) || '');
            const m = dt.match(/(\d{6,})/); if (m) itemNumber = m[1];
        }
        return {
            title, url, image, price, seller,
            owner:'', accountAge:'', totalSales:'',
            itemNumber, country:'',
            avgPrice:'', avgShipping:'', totalSold:'', sales:'', lastSold:'',
            available:'', sold:'',
            shopSales:'', shopRating:'', shopReviews:'', shopAdmirers:'',
            favorites:'', tags:'', materials:'', shopLocation:'',
            condition:'', handlingTime:'', returns:'',
            sellerFeedbackScore:'', sellerPositivePct:''
        };
    }
    function extractEbayResearch(row) {
        const idEl = row.querySelector('span[data-item-id]');
        const itemNumber = idEl ? (idEl.getAttribute('data-item-id') || '').trim() : '';
        const titleEl = row.querySelector('.research-table-row__product-info-name span[data-item-id]') || idEl;
        const title = textOf(titleEl);
        const url = itemNumber ? 'https://www.ebay.com/itm/' + itemNumber : '';
        const image = normalizeImgSrc(row.querySelector('img'));
        // The research table row has its own cells with pre-formatted text.
        const firstDivText = sel => {
            const el = row.querySelector(sel);
            if (!el) return '';
            const d = el.querySelector('div');
            return textOf(d || el);
        };
        const avgPrice    = firstDivText('.research-table-row__avgSoldPrice');
        const avgShipping = firstDivText('.research-table-row__avgShippingCost');
        const totalSold   = firstDivText('.research-table-row__totalSoldCount');
        const sales       = firstDivText('.research-table-row__totalSalesValue');
        const lastSold    = firstDivText('.research-table-row__dateLastSold');
        // Seller is discovered asynchronously elsewhere and stashed on the row.
        const seller = (row.dataset && row.dataset.uecSeller) || '';
        // Policy-violation rows flagged by previous sibling.
        const prev = row.previousElementSibling;
        const policy = !!(prev && prev.classList && prev.classList.contains('policyViolationMessageRow'));
        return {
            title, url, image,
            price: avgPrice,
            seller: seller || (policy ? 'Policy Violation' : ''),
            owner:'', accountAge:'', totalSales:'',
            itemNumber, country:'',
            avgPrice, avgShipping, totalSold, sales, lastSold,
            available:'', sold:'',
            shopSales:'', shopRating:'', shopReviews:'', shopAdmirers:'',
            favorites:'', tags:'', materials:'', shopLocation:'',
            condition:'', handlingTime:'', returns:'',
            sellerFeedbackScore:'', sellerPositivePct:''
        };
    }
    function extract(card) {
        switch (MODE) {
            case 'etsy-search':   return extractEtsy(card);
            case 'ebay-search':   return extractEbaySearch(card);
            case 'ebay-store':    return extractEbayStore(card);
            case 'ebay-research': return extractEbayResearch(card);
        }
        return {};
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Search expression language:
    //    AND by space, OR by comma, - for NOT, "quotes" for phrase, (parens)
    // ────────────────────────────────────────────────────────────────────────
    function parseExpression(q) {
        const tokens = []; let i = 0; const s = (q || '').trim(); const len = s.length;
        const isSpace = ch => /\s/.test(ch);
        while (i < len) {
            const ch = s[i];
            if (isSpace(ch)) { i++; continue; }
            if (ch === '(' || ch === ')' || ch === ',' || ch === '-') { tokens.push({ type: ch }); i++; continue; }
            if (ch === '"') {
                i++; let buf = '';
                while (i < len && s[i] !== '"') { buf += s[i++]; }
                if (i < len && s[i] === '"') i++;
                tokens.push({ type: 'PHRASE', value: buf.toLowerCase() }); continue;
            }
            let buf2 = '';
            while (i < len && !isSpace(s[i]) && ![',', '(', ')'].includes(s[i])) buf2 += s[i++];
            if (buf2) tokens.push({ type: 'WORD', value: buf2.toLowerCase() });
        }
        let t = 0;
        const peek = () => tokens[t];
        const take = () => tokens[t++];
        function primary() {
            const tok = peek();
            if (!tok) return { type: 'TRUE' };
            if (tok.type === '(') { take(); const n = orExpr(); if (peek() && peek().type === ')') take(); return n; }
            if (tok.type === 'PHRASE' || tok.type === 'WORD') { take(); return { type: 'TERM', value: tok.value }; }
            return { type: 'TRUE' };
        }
        function unary() { const tok = peek(); if (tok && tok.type === '-') { take(); return { type: 'NOT', child: primary() }; } return primary(); }
        function andExpr() {
            const kids = [unary()];
            while (true) { const n = peek(); if (!n || n.type === ',' || n.type === ')') break; kids.push(unary()); }
            return kids.length === 1 ? kids[0] : { type: 'AND', children: kids };
        }
        function orExpr() {
            let n = andExpr();
            while (peek() && peek().type === ',') { take(); n = { type: 'OR', children: [n, andExpr()] }; }
            return n;
        }
        return orExpr();
    }
    function evalExpr(ast, text) {
        switch (ast.type) {
            case 'TRUE': return true;
            case 'TERM': return text.includes(ast.value);
            case 'NOT':  return !evalExpr(ast.child, text);
            case 'AND':  return ast.children.every(c => evalExpr(c, text));
            case 'OR':   return ast.children.some(c => evalExpr(c, text));
            default:     return false;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Persistent state (selections + cache) scoped per site+path
    // ────────────────────────────────────────────────────────────────────────
    const BASE_SCOPE = (() => {
        let s = location.origin + location.pathname;
        if (MODE === 'ebay-store') { const sn = getEbayStoreSeller(); if (sn) s += ':ssn=' + sn; }
        return s;
    })();
    const STATE_KEY = 'uec_state:' + MODE + ':' + BASE_SCOPE;
    function loadState() {
        try {
            const o = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {};
            o.selectedIds = Array.isArray(o.selectedIds) ? o.selectedIds : [];
            o.query       = typeof o.query === 'string' ? o.query : '';
            o.countries   = Array.isArray(o.countries) ? o.countries : ['Any'];
            o.cache       = (o.cache && typeof o.cache === 'object') ? o.cache : {};
            o.autoMode    = (o.autoMode === 'query' || o.autoMode === 'manual') ? o.autoMode : 'manual';
            return o;
        } catch (e) { return { selectedIds: [], query: '', countries: ['Any'], cache: {}, autoMode: 'manual' }; }
    }
    function saveState() {
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify({
                selectedIds: state.selectedIds,
                query:       state.query,
                countries:   Array.from(state.countries),
                cache:       state.cache,
                autoMode:    state.autoMode
            }));
        } catch (e) {}
    }
    const state = (() => {
        const o = loadState();
        return {
            selectedIds: new Set(o.selectedIds),
            query:       o.query,
            countries:   new Set(o.countries),
            cache:       o.cache,
            autoMode:    o.autoMode
        };
    })();
    function idFor(card) {
        try { const f = extract(card); return String((f.itemNumber || f.url || f.title || '').trim()); }
        catch (e) { return ''; }
    }
    function rememberSelection(id, data) {
        if (!id) return;
        state.selectedIds.add(id);
        state.cache[id] = Object.assign({ __savedAt: Date.now() }, data);
        saveState();
    }
    function forgetSelection(id) {
        if (!id) return;
        state.selectedIds.delete(id);
        delete state.cache[id];
        saveState();
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Overlay
    // ────────────────────────────────────────────────────────────────────────
    const toggleBtn = h('button', { class: 'uec-toggle', title: 'Listing Collector' },
        'List', h('span', { class: 'uec-count', id: 'uec-count' }, '0')
    );
    const keywordInput = h('input', { type: 'text', placeholder: 'AND by space · OR by comma · "quoted phrase" · -exclude · (parens)' });
    const keywordHint  = h('div',  { class: 'uec-hint' }, 'Filters visible cards by title.');
    const countryBox   = h('div',  { class: 'uec-country-box' });
    const countryHint  = h('div',  { class: 'uec-hint' }, 'Tick none to show all. Countries are discovered from the page.');
    const statusEl     = h('div',  { class: 'uec-status' }, 'Ready.');
    const logEl        = h('div',  { class: 'uec-log' });
    const selectAllBtn = h('button', {}, 'Select visible');
    const clearBtn     = h('button', {}, 'Clear');
    const copyTableBtn = h('button', { class: 'primary' }, 'Copy Table');
    const copyIdsBtn   = h('button', { class: 'warn'    }, isEtsy ? 'Copy Listing IDs' : 'Copy Item Numbers');
    const copySellerBtn= h('button', { class: 'success' }, 'Copy Seller+Item');
    const copyUrlsBtn  = h('button', { class: 'violet'  }, 'Copy URLs');
    const enrichBtn    = h('button', { class: 'violet'  }, 'Enrich now');
    const enrichToggle = h('input',  { type: 'checkbox', id: 'uec-enrich-chk' });
    enrichToggle.checked = !!CONFIG.ENRICH_BEFORE_SAVE_DEFAULT;
    const enrichLbl    = h('label', { for: 'uec-enrich-chk', style: 'font-size:12px;color:#333;display:flex;align-items:center;gap:6px;flex:1 1 auto;' },
        enrichToggle, 'Enrich before save (opens each item/shop page in background)'
    );
    const saveBtn      = h('button', { class: 'primary' }, 'Save Selected to Google Sheets');

    const modeLabel =
        MODE === 'etsy-search'   ? 'Etsy search' :
        MODE === 'ebay-search'   ? 'eBay search' :
        MODE === 'ebay-store'    ? 'eBay store'  :
        MODE === 'ebay-research' ? 'eBay research' : MODE;

    const panel = h('div', { class: 'uec-panel', hidden: !CONFIG.OPEN_PANEL_BY_DEFAULT },
        h('div', { class: 'uec-head' },
            h('div', {},
                h('h3', {}, 'Listing Collector'),
                h('div', { class: 'uec-mode' }, modeLabel)
            ),
            h('button', { title: 'Close', onclick: () => togglePanel(false) }, '\u00d7')
        ),
        h('div', { class: 'uec-body' },
            h('label', { class: 'uec-lbl' }, 'Search & Select (filters cards)'),
            keywordInput, keywordHint,
            h('label', { class: 'uec-lbl', style: 'margin-top:10px;' }, 'Countries'),
            countryBox, countryHint,
            h('div', { class: 'uec-row' }, selectAllBtn, clearBtn),
            h('div', { class: 'uec-row' }, copyTableBtn, copyIdsBtn),
            h('div', { class: 'uec-row' }, copySellerBtn, copyUrlsBtn),
            h('div', { class: 'uec-row' }, enrichBtn),
            h('div', { class: 'uec-row' }, enrichLbl),
            h('div', { class: 'uec-row' }, saveBtn),
            statusEl, logEl
        )
    );
    document.documentElement.appendChild(toggleBtn);
    document.documentElement.appendChild(panel);
    function togglePanel(force) {
        const show = typeof force === 'boolean' ? force : panel.hasAttribute('hidden');
        if (show) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
    }
    toggleBtn.addEventListener('click', () => togglePanel());
    keywordInput.value = state.query || '';
    let keywordTimer = null;
    keywordInput.addEventListener('input', () => {
        clearTimeout(keywordTimer);
        keywordTimer = setTimeout(() => {
            state.query    = keywordInput.value.trim();
            state.autoMode = state.query ? 'query' : 'manual';
            saveState();
            applyFilters();
            if (state.autoMode === 'query') applyQuerySelection();
        }, 200);
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
        state.selectedIds.clear(); state.cache = {}; state.query = ''; state.autoMode = 'manual';
        keywordInput.value = '';
        saveState(); updateCount();
        setStatus('Selection cleared.');
    });

    // ────────────────────────────────────────────────────────────────────────
    //  Log / status helpers
    // ────────────────────────────────────────────────────────────────────────
    function log(msg, cls)   { logEl.appendChild(h('div', { class: cls || '' }, '\u2022 ' + msg)); logEl.scrollTop = logEl.scrollHeight; }
    function setStatus(s)    { statusEl.textContent = s; }
    function updateCount()   { document.getElementById('uec-count').textContent = String(state.selectedIds.size); }
    function trunc(s)        { return (s || '').length > 60 ? s.slice(0, 57) + '\u2026' : s; }

    // ────────────────────────────────────────────────────────────────────────
    //  Country filter — built dynamically from visible cards
    // ────────────────────────────────────────────────────────────────────────
    function rebuildCountryBox() {
        const found = new Set();
        document.querySelectorAll('[data-uec-card]').forEach(c => {
            const v = (c._uecData && c._uecData.country) || '';
            if (v) found.add(v);
        });
        const list = ['Any', ...Array.from(found).sort()];
        countryBox.innerHTML = '';
        for (const c of list) {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = state.countries.has(c);
            cb.addEventListener('change', () => {
                if (c === 'Any') state.countries = new Set(cb.checked ? ['Any'] : []);
                else {
                    if (cb.checked) state.countries.add(c); else state.countries.delete(c);
                    state.countries.delete('Any');
                }
                if (state.countries.size === 0) state.countries.add('Any');
                saveState();
                rebuildCountryBox();
                applyFilters();
            });
            countryBox.appendChild(h('label', {}, cb, ' ' + c));
        }
    }

    function matchesCountry(data) {
        if (state.countries.has('Any') || state.countries.size === 0) return true;
        if (!data.country) return false;
        const hay = data.country.toLowerCase();
        for (const c of state.countries) {
            if (c === 'Any') continue;
            if (hay.includes(c.toLowerCase())) return true;
            if (c === 'United States'  && /\b(usa|u\.s\.a?\.|united states)\b/i.test(hay)) return true;
            if (c === 'United Kingdom' && /\b(uk|u\.k\.|great britain|england|scotland|wales)\b/i.test(hay)) return true;
        }
        return false;
    }
    function matchesKeyword(data) {
        if (!state.query) return true;
        const ast = parseExpression(state.query);
        return evalExpr(ast, (data.title + ' ' + (data.price || '')).toLowerCase());
    }
    function applyFilters() {
        document.querySelectorAll('[data-uec-card]').forEach(card => {
            const d = card._uecData; if (!d) return;
            const ok = matchesKeyword(d) && matchesCountry(d);
            card.classList.toggle('uec-hidden-by-filter', !ok);
        });
    }
    function applyQuerySelection() {
        // Mirror the bookmarklets: when an expression is active, it auto-ticks
        // all visible matching cards (manual ticks still stick across pages).
        if (!state.query) return;
        const ast = parseExpression(state.query);
        let matched = 0;
        document.querySelectorAll('[data-uec-card]').forEach(card => {
            const d = card._uecData; if (!d) return;
            if (card.classList.contains('uec-hidden-by-filter')) return;
            const cb = card.querySelector('.uec-listing-check input');
            if (!cb) return;
            const ok = evalExpr(ast, (d.title + ' ' + (d.price || '')).toLowerCase());
            if (ok && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); matched++; }
        });
        if (matched) setStatus(`Search auto-selected ${matched} card(s).`);
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Inject per-card checkboxes + ships-from badge
    // ────────────────────────────────────────────────────────────────────────
    function ensureCheckboxes() {
        PAG_BOTTOM = findPaginationBottom();
        maybeUpgradeMode();

        const nodes = document.querySelectorAll(CFG.card);
        nodes.forEach(card => {
            if (!isCardEligible(card)) return;
            if (card.dataset.uecCard) return;

            if (MODE === 'ebay-research') {
                decorateResearchRow(card);
                card.dataset.uecCard = '1';
                const data = extract(card);
                card._uecData = data;
                if (data.itemNumber && state.selectedIds.has(data.itemNumber) ||
                    data.url && state.selectedIds.has(data.url)) {
                    const cb = card.querySelector('.uec-listing-check input');
                    if (cb) cb.checked = true;
                }
                return;
            }

            // Normal search/store card
            const cs = getComputedStyle(card);
            if (cs.position === 'static') card.style.position = 'relative';
            card.dataset.uecCard = '1';
            const data = extract(card);
            card._uecData = data;

            const input = h('input', { type: 'checkbox' });
            const key = data.itemNumber || data.url || '';
            if (key && state.selectedIds.has(key)) input.checked = true;
            input.addEventListener('click', e => e.stopPropagation());
            input.addEventListener('change', () => {
                const id = data.itemNumber || data.url || '';
                if (input.checked) rememberSelection(id, data);
                else               forgetSelection(id);
                state.autoMode = 'manual';
                saveState();
                updateCount();
            });
            const wrap = h('div', { class: 'uec-listing-check', title: data.title }, input);
            wrap.addEventListener('click', e => {
                if (e.target === wrap) {
                    e.preventDefault(); e.stopPropagation();
                    input.checked = !input.checked;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            card.appendChild(wrap);

            if (data.country) {
                const badge = h('div', { class: 'uec-ship-badge' }, data.country);
                card.appendChild(badge);
            }
        });

        rebuildCountryBox();
        applyFilters();
        if (state.autoMode === 'query' && state.query) applyQuerySelection();
        updateCount();
    }

    // ────────────────────────────────────────────────────────────────────────
    //  eBay Seller Hub Research mode — async seller lookup + row decoration
    // ────────────────────────────────────────────────────────────────────────
    const researchSellerCache = new Map();
    function decorateResearchRow(row) {
        const thumb = row.querySelector('.research-table-row__thumbnail') || row;
        if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';

        const idEl = row.querySelector('span[data-item-id]');
        const itemNumber = idEl ? idEl.getAttribute('data-item-id') : '';

        const input = h('input', { type: 'checkbox' });
        const key = itemNumber || '';
        if (key && state.selectedIds.has(key)) input.checked = true;
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('change', () => {
            row._uecData = extract(row);
            const id = row._uecData.itemNumber || row._uecData.url || '';
            if (input.checked) rememberSelection(id, row._uecData);
            else               forgetSelection(id);
            updateCount();
        });
        const wrap = h('div', { class: 'uec-listing-check', title: 'Select for export' }, input);
        wrap.style.top = '6px'; wrap.style.left = '6px';
        thumb.appendChild(wrap);

        // Kick off seller lookup in the background; store the result on the
        // row dataset so extract() picks it up later.
        if (itemNumber) {
            fetchResearchSellerName(itemNumber, row).then(name => {
                row.dataset.uecSeller = name || '';
                row._uecData = extract(row);
                // If the row was already cached/selected, refresh its cache so
                // the new seller goes into the sheet.
                if (state.selectedIds.has(itemNumber)) {
                    state.cache[itemNumber] = Object.assign({ __savedAt: Date.now() }, row._uecData);
                    saveState();
                }
                const labelEl = row.querySelector('.uec-research-label');
                if (labelEl) labelEl.textContent = name || '';
            });
        }

        // Small "seller + open" overlay next to the thumbnail, same spirit as
        // the third bookmarklet.
        const label = h('div', { class: 'uec-research-label', style: 'position:absolute;left:40px;top:6px;font-size:11.5px;background:rgba(255,255,255,.92);padding:2px 6px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.15);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:50;' }, '\u2026');
        thumb.appendChild(label);
    }
    function fetchResearchSellerName(itemNumber, row) {
        if (researchSellerCache.has(itemNumber)) return Promise.resolve(researchSellerCache.get(itemNumber));
        const prev = row.previousElementSibling;
        if (prev && prev.classList && prev.classList.contains('policyViolationMessageRow')) {
            researchSellerCache.set(itemNumber, 'Policy Violation');
            return Promise.resolve('Policy Violation');
        }
        return new Promise(resolve => {
            if (!gmXHR) { researchSellerCache.set(itemNumber, ''); return resolve(''); }
            gmXHR({
                method: 'GET',
                url: 'https://www.ebay.com/itm/' + itemNumber,
                timeout: 20000,
                onload: r => {
                    let name = '';
                    try {
                        const doc = new DOMParser().parseFromString(r.responseText || '', 'text/html');
                        name = parseSellerFromItemPage(doc);
                    } catch (e) {}
                    researchSellerCache.set(itemNumber, name || 'Unknown');
                    resolve(name || 'Unknown');
                },
                onerror:   () => { researchSellerCache.set(itemNumber, ''); resolve(''); },
                ontimeout: () => { researchSellerCache.set(itemNumber, ''); resolve(''); }
            });
        });
    }
    function parseSellerFromItemPage(doc) {
        const tryPatterns = u => {
            if (!u) return null;
            let m = u.match(/[?&]sid=([^&]+)/);       if (m) return decodeURIComponent(m[1]);
            m = u.match(/[?&]_ssn=([^&]+)/);           if (m) return decodeURIComponent(m[1]);
            m = u.match(/[?&]requested=([^&]+)/);      if (m) return decodeURIComponent(m[1]);
            m = u.match(/\/sch\/([^\/?]+)/);           if (m) return decodeURIComponent(m[1]);
            m = u.match(/\/str\/([^\/?]+)/);           if (m) return decodeURIComponent(m[1]);
            return null;
        };
        const cvipLink = doc.querySelector('.x-vi-evo-cvip-container a.ux-call-to-action');
        if (cvipLink && cvipLink.href) { const n = tryPatterns(cvipLink.href); if (n) return n; }
        const cardLink = doc.querySelector('.x-sellercard-atf__info__about-seller a');
        if (cardLink && cardLink.href) { const n = tryPatterns(cardLink.href); if (n) return n; }
        const contact = doc.querySelector('a[href*="requested="]');
        if (contact && contact.href) { const n = tryPatterns(contact.href); if (n) return n; }
        return '';
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Copy-to-clipboard actions
    // ────────────────────────────────────────────────────────────────────────
    function selectedRowsAllPages() {
        const rows = [];
        for (const id of state.selectedIds) {
            const d = state.cache[id];
            if (d) rows.push(d);
        }
        return rows;
    }
    function uniqueBy(arr, keyFn) {
        const seen = new Set(); const out = [];
        for (const x of arr) { const k = keyFn(x); if (k && seen.has(k)) continue; if (k) seen.add(k); out.push(x); }
        return out;
    }
    function copyHtml(html, successMsg) {
        const holder = h('div', { contenteditable: 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
        holder.innerHTML = html;
        document.body.appendChild(holder);
        const range = document.createRange(); range.selectNodeContents(holder);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
        sel.removeAllRanges(); holder.remove();
        if (ok) return setStatus(successMsg || 'Copied.');
        if (navigator.clipboard && window.ClipboardItem) {
            navigator.clipboard.write([new ClipboardItem({
                'text/html':  new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([html], { type: 'text/plain' })
            })]).then(() => setStatus(successMsg || 'Copied.'))
               .catch(() => setStatus('Copy failed.'));
        } else setStatus('Copy failed.');
    }
    function cellsForRow(f) {
        const titleClean = (f.title || '').replace(/\s*Opens in a new window or tab\s*$/i, '');
        const imgHtml = f.image ? `<img src="${f.image}" width="100" style="max-height:190px;object-fit:contain;">` : '[No Image]';
        return { titleClean, imgHtml };
    }
    // Column definitions per mode. Each entry is [header, accessor(f) → cellValue-or-imgHtml].
    // Enrichment-derived fields (favorites, shopSales, condition, …) are included.
    function columnsForMode() {
        const imgFor = f => cellsForRow(f).imgHtml;
        const today  = () => new Date().toLocaleDateString('en-US');
        switch (MODE) {
            case 'ebay-research': return [
                ['Seller',       f => f.seller],
                ['Item #',       f => f.itemNumber],
                ['Title',        f => cellsForRow(f).titleClean],
                ['URL',          f => f.url],
                ['Avg Price',    f => f.avgPrice],
                ['Avg Shipping', f => f.avgShipping],
                ['Total Sold',   f => f.totalSold],
                ['Sales',        f => f.sales],
                ['Last Sold',    f => f.lastSold],
                ['Condition',    f => f.condition],
                ['Feedback',     f => f.sellerFeedbackScore],
                ['Positive %',   f => f.sellerPositivePct],
                ['Image',        f => imgFor(f)]
            ];
            case 'ebay-search':
            case 'ebay-store': return [
                ['Seller',       f => f.seller],
                ['Feedback',     f => f.sellerFeedbackScore],
                ['Positive %',   f => f.sellerPositivePct],
                ['Item #',       f => f.itemNumber],
                ['Title',        f => cellsForRow(f).titleClean],
                ['URL',          f => f.url],
                ['Price',        f => f.price],
                ['Available',    f => f.available],
                ['Sold',         f => f.sold],
                ['Condition',    f => f.condition],
                ['Handling',     f => f.handlingTime],
                ['Returns',      f => f.returns],
                ['Ships From',   f => f.country],
                ['Image',        f => imgFor(f)],
                ['Date',         f => today()]
            ];
            case 'etsy-search':
            default: return [
                ['Seller',        f => f.seller],
                ['Owner',         f => f.owner],
                ['Account Age',   f => f.accountAge],
                ['Shop Sales',    f => f.shopSales || f.totalSales],
                ['Shop Rating',   f => f.shopRating],
                ['Reviews',       f => f.shopReviews],
                ['Admirers',      f => f.shopAdmirers],
                ['Shop Location', f => f.shopLocation],
                ['Listing #',     f => f.itemNumber],
                ['Title',         f => cellsForRow(f).titleClean],
                ['URL',           f => f.url],
                ['Price',         f => f.price],
                ['Favorites',     f => f.favorites],
                ['Tags',          f => f.tags],
                ['Materials',     f => f.materials],
                ['Ships From',    f => f.country],
                ['Image',         f => imgFor(f)],
                ['Date',          f => today()]
            ];
        }
    }
    copyTableBtn.addEventListener('click', () => {
        const rows = uniqueBy(selectedRowsAllPages(), r => r.itemNumber || r.url || '');
        if (!rows.length) return setStatus('No items selected.');
        const H = CONFIG.COPY_TABLE_ROW_HEIGHT_PX;
        const cols = columnsForMode();
        let html = '<table border="1" style="border-collapse:collapse;table-layout:fixed;width:100%;font-family:Arial;font-size:12px;">';
        html += '<tr>' + cols.map(c => `<th style="padding:5px;font-weight:bold;">${c[0]}</th>`).join('') + '</tr>';
        rows.forEach(f => {
            html += `<tr height="${H}" style="height:${H}px;">` +
                cols.map(([hdr, fn]) => {
                    const v = fn(f);
                    // The Image column already renders an <img> tag; everything else is text.
                    const style = hdr === 'URL'
                        ? 'padding:5px;vertical-align:top;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
                        : 'padding:5px;vertical-align:top;';
                    const val = v == null ? '' : v;
                    return `<td style="${style}"${hdr === 'URL' ? ' nowrap' : ''}>${val}</td>`;
                }).join('') + '</tr>';
        });
        html += '</table>';
        const enrichedCount = rows.filter(r => r.__enriched).length;
        copyHtml(html, `Copied ${rows.length} item(s) (${enrichedCount} enriched).`);
    });
    copyIdsBtn.addEventListener('click', () => {
        const ids = Array.from(new Set(selectedRowsAllPages().map(r => r.itemNumber).filter(Boolean)));
        if (!ids.length) return setStatus('No item numbers in selection.');
        navigator.clipboard.writeText(ids.join('\n'))
            .then(() => setStatus(`Copied ${ids.length} ID(s).`))
            .catch(() => setStatus('Copy failed.'));
    });
    copySellerBtn.addEventListener('click', () => {
        const seen = new Set(); const out = [];
        for (const f of selectedRowsAllPages()) {
            const id = f.itemNumber || ''; if (id && seen.has(id)) continue; if (id) seen.add(id);
            out.push((f.seller || '') + '\t' + id);
        }
        if (!out.length) return setStatus('Nothing to copy.');
        navigator.clipboard.writeText(out.join('\n'))
            .then(() => setStatus(`Copied ${out.length} seller/item rows.`))
            .catch(() => setStatus('Copy failed.'));
    });
    copyUrlsBtn.addEventListener('click', () => {
        const urls = Array.from(new Set(selectedRowsAllPages().map(r => r.url).filter(u => u && /^https?:/i.test(u))));
        if (!urls.length) return setStatus('No URLs to copy.');
        navigator.clipboard.writeText(urls.join('\n'))
            .then(() => setStatus(`Copied ${urls.length} URL(s).`))
            .catch(() => setStatus('Copy failed.'));
    });
    enrichBtn.addEventListener('click', async () => {
        const items = uniqueBy(selectedRowsAllPages(), r => r.itemNumber || r.url || '');
        if (!items.length) { setStatus('Nothing selected to enrich.'); return; }
        enrichBtn.disabled = true;
        setStatus(`Enriching ${items.length} selection(s)\u2026`);
        log(`Enriching ${items.length} selection(s).`);
        const started = Date.now();
        await enrichMany(items, (done, total, it) => {
            setStatus(`Enriched ${done}/${total}: ${trunc(it.title)}`);
        });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        setStatus(`Done. Enriched ${items.length} in ${secs}s. Extras will appear in Copy Table and Save.`);
        log(`Enrichment finished in ${secs}s.`, 'ok');
        enrichBtn.disabled = false;
    });

    // ────────────────────────────────────────────────────────────────────────
    //  Enrichment engine
    //  ---------------------------------------------------------------------
    //  Given a selection, opens the corresponding detail page(s) in the
    //  background (via GM_xmlhttpRequest — no new tabs, no user-visible
    //  navigation) and parses extra fields out of the HTML:
    //
    //    eBay item page  → condition, handling time, returns, available,
    //                      sold, seller feedback score & positive %
    //    Etsy listing    → favorites, tags, materials, country/ships-from
    //    Etsy shop page  → shopSales, shopRating, shopReviews, shopAdmirers,
    //                      shopLocation (fetched at most once per shop)
    //
    //  Results are merged back into the selection cache so they appear in
    //  Copy Table and in the Google Sheet when you Save.
    // ────────────────────────────────────────────────────────────────────────
    function mapLimit(arr, limit, worker) {
        return new Promise(resolve => {
            const out = new Array(arr.length); let i = 0, active = 0, done = 0;
            if (!arr.length) return resolve(out);
            const next = () => {
                while (active < limit && i < arr.length) {
                    const idx = i++; active++;
                    Promise.resolve(worker(arr[idx], idx))
                        .then(v => out[idx] = v)
                        .catch(() => out[idx] = null)
                        .finally(() => { active--; done++; if (done === arr.length) resolve(out); else next(); });
                }
            };
            next();
        });
    }
    function fetchDoc(url) {
        return new Promise(resolve => {
            if (!url || !gmXHR) return resolve(null);
            gmXHR({
                method: 'GET', url, timeout: 25000,
                headers: { 'Accept': 'text/html,application/xhtml+xml' },
                onload: r => {
                    try { resolve(new DOMParser().parseFromString(r.responseText || '', 'text/html')); }
                    catch (e) { resolve(null); }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    // --- eBay item page ---------------------------------------------------
    function parseEbayItemPage(doc) {
        const out = { available: '', sold: '', condition: '', handlingTime: '', returns: '',
                      sellerFeedbackScore: '', sellerPositivePct: '' };
        if (!doc) return out;
        // Available / Sold
        const qtyEl = doc.querySelector('#qtyAvailability, .x-quantity__availability, [data-testid="qtyAvailability"], .d-quantity__availability');
        if (qtyEl) {
            const t = (qtyEl.textContent || '').replace(/\s+/g, ' ').trim();
            let m = t.match(/([\d,]+)\s+available/i); if (m) out.available = m[1].replace(/,/g, '');
            m = t.match(/More than\s+([\d,]+)\s+available/i); if (m) out.available = m[1].replace(/,/g, '') + '+';
            m = t.match(/([\d,]+)\s+sold/i);           if (m) out.sold      = m[1].replace(/,/g, '');
            if (!out.available && /last\s+one/i.test(t)) out.available = '1';
        }
        if (!out.sold) {
            const alt = doc.querySelector('.x-quantity__availability--purchases, .w-quantity__purchases, a[href*="bidHistory"]');
            if (alt) {
                const m = (alt.textContent || '').match(/([\d,]+)/);
                if (m) out.sold = m[1].replace(/,/g, '');
            }
        }
        // Condition
        const condEl = doc.querySelector('.x-item-condition-text, .d-item-condition-text, .ux-labels-values__values .ux-textspans, [data-testid="ux-item-condition"]');
        if (condEl) {
            const t = textOf(condEl).split('.')[0].trim();
            if (t && t.length < 120) out.condition = t;
        }
        // Handling time / ships within
        const shipBlock = doc.querySelector('.d-shipping-minview, .ux-layout-section__row .ux-labels-values--shipping, .vi-shipping');
        if (shipBlock) {
            const t = textOf(shipBlock);
            const m = t.match(/dispatched within\s+([^.]+)/i) || t.match(/handling time\s*[:-]?\s*([^.]+)/i);
            if (m) out.handlingTime = m[1].trim().slice(0, 80);
        }
        // Returns policy
        const retBlock = doc.querySelector('.ux-layout-section__row .ux-labels-values--returns, .d-returns, [data-testid="returns"]');
        if (retBlock) {
            const t = textOf(retBlock).replace(/\s+/g, ' ').trim();
            out.returns = t.length > 160 ? t.slice(0, 157) + '\u2026' : t;
        }
        // Seller info block
        const sellerSec = doc.querySelector('.x-sellercard-atf, .ux-seller-section, [data-testid="x-sellercard-atf"]');
        if (sellerSec) {
            const t = textOf(sellerSec);
            const score = t.match(/\(([\d,]+)\s*(?:feedback|ratings|reviews)?\)/i) || t.match(/([\d,]+)\s*feedback/i);
            if (score) out.sellerFeedbackScore = score[1].replace(/,/g, '');
            const pct = t.match(/([\d]{1,3}(?:\.\d)?)\s*%\s*positive/i);
            if (pct) out.sellerPositivePct = pct[1];
        }
        return out;
    }

    // --- Etsy listing page -----------------------------------------------
    function parseEtsyListingPage(doc) {
        const out = { favorites: '', tags: '', materials: '', country: '' };
        if (!doc) return out;
        // Favorites — shown as "N people have this in their cart" or on the "♥ N favorites" button
        const favBtn = doc.querySelector('button[data-favorites-count], [data-favorites-count]');
        if (favBtn) {
            out.favorites = (favBtn.getAttribute('data-favorites-count') || '').trim();
        }
        if (!out.favorites) {
            const likesText = Array.from(doc.querySelectorAll('span, a, button'))
                .map(n => textOf(n))
                .find(t => /^\d[\d,]*\s+favorites?$/i.test(t));
            if (likesText) out.favorites = (likesText.match(/\d[\d,]*/) || [''])[0].replace(/,/g, '');
        }
        // Tags (from the "Explore related searches" or tag list)
        const tagNodes = doc.querySelectorAll('a[href*="/market/"], a[href*="/search?q="][data-tag]');
        if (tagNodes.length) {
            const tags = Array.from(tagNodes).map(a => textOf(a)).filter(Boolean);
            out.tags = Array.from(new Set(tags)).slice(0, 20).join(', ');
        }
        // Materials & ships-from via the listing overview list items
        Array.from(doc.querySelectorAll('li, p, div')).forEach(li => {
            const t = textOf(li);
            if (!out.materials && /^Materials?:\s+/i.test(t))   out.materials = t.replace(/^Materials?:\s+/i, '').slice(0, 200);
            if (!out.country   && /^Ships from:?\s+/i.test(t))  out.country   = t.replace(/^Ships from:?\s+/i, '').slice(0, 80);
        });
        return out;
    }

    // --- Etsy shop page (cached per shop) --------------------------------
    const etsyShopCache = new Map();
    function shopUrlFromListingUrl(u, sellerName) {
        if (sellerName) return 'https://www.etsy.com/shop/' + encodeURIComponent(sellerName);
        try {
            const url = new URL(u);
            const m = url.pathname.match(/\/shop\/([^\/?]+)/);
            if (m) return 'https://www.etsy.com/shop/' + m[1];
        } catch (e) {}
        return '';
    }
    async function fetchEtsyShop(shopUrl) {
        if (!shopUrl) return {};
        if (etsyShopCache.has(shopUrl)) return etsyShopCache.get(shopUrl);
        const doc = await fetchDoc(shopUrl);
        const out = { shopSales: '', shopRating: '', shopReviews: '', shopAdmirers: '', shopLocation: '' };
        if (doc) {
            const body = textOf(doc.body);
            let m = body.match(/([\d,]+)\s+sales?\b/i);      if (m) out.shopSales = m[1].replace(/,/g, '');
            m = body.match(/([\d.]+)\s+out of 5\s+stars?/i); if (m) out.shopRating = m[1];
            m = body.match(/\(([\d,]+)\s*reviews?\)/i);      if (m) out.shopReviews = m[1].replace(/,/g, '');
            m = body.match(/([\d,]+)\s+admirers?/i);         if (m) out.shopAdmirers = m[1].replace(/,/g, '');
            const locEl = doc.querySelector('[data-shop-location], .shop-home-header-info span');
            if (locEl) {
                const t = textOf(locEl);
                if (t && t.length < 100) out.shopLocation = t;
            }
        }
        etsyShopCache.set(shopUrl, out);
        return out;
    }

    // --- Public: enrich a single item in place ---------------------------
    async function enrichOne(item, statusCb) {
        if (!item) return item;
        if (item.__enriched) return item;
        try {
            if (SITE === 'ebay') {
                const target = item.url || (item.itemNumber ? 'https://www.ebay.com/itm/' + item.itemNumber : '');
                if (target) {
                    statusCb && statusCb('Fetching eBay item page\u2026');
                    const doc = await fetchDoc(target);
                    const extra = parseEbayItemPage(doc);
                    Object.assign(item, extra);
                }
            } else if (SITE === 'etsy') {
                if (item.url) {
                    statusCb && statusCb('Fetching Etsy listing\u2026');
                    const doc = await fetchDoc(item.url);
                    const extra = parseEtsyListingPage(doc);
                    // Prefer listing-page country if card didn't have one
                    if (!item.country && extra.country) item.country = extra.country;
                    delete extra.country;
                    Object.assign(item, extra);
                }
                if (item.seller) {
                    statusCb && statusCb('Fetching Etsy shop\u2026');
                    const shopUrl = shopUrlFromListingUrl(item.url, item.seller);
                    const shop = await fetchEtsyShop(shopUrl);
                    Object.assign(item, shop);
                }
            }
        } catch (e) { /* swallow — best effort */ }
        item.__enriched = true;
        // Persist updated cache so selections across pages keep the enrichment.
        const id = item.itemNumber || item.url || '';
        if (id) { state.cache[id] = item; saveState(); }
        return item;
    }

    async function enrichMany(items, onProgress) {
        let done = 0;
        await mapLimit(items, CONFIG.ENRICH_CONCURRENCY || 3, async it => {
            await enrichOne(it);
            done++;
            if (onProgress) onProgress(done, items.length, it);
        });
        return items;
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Save flow (upload image + append row via Apps Script)
    // ────────────────────────────────────────────────────────────────────────
    saveBtn.addEventListener('click', async () => {
        if (!CONFIG.WEB_APP_URL || CONFIG.WEB_APP_URL.startsWith('PUT_YOUR_')) {
            setStatus('Please fill in CONFIG.WEB_APP_URL, SHEET_ID and DRIVE_FOLDER_ID at the top of the script.');
            return;
        }
        const items = uniqueBy(selectedRowsAllPages(), r => r.itemNumber || r.url || '');
        if (!items.length) { setStatus('Nothing selected yet — tick some listings first.'); return; }

        saveBtn.disabled = true;
        setStatus(`Sending ${items.length} listing(s) to Google\u2026`);
        log(`Starting upload of ${items.length} listing(s).`);

        // Optional pre-enrichment: walk each selected item's detail page in the
        // background and pull extras (qty, condition, handling, returns, seller
        // feedback on eBay; favorites/tags/materials + shop stats on Etsy).
        if (enrichToggle.checked) {
            setStatus('Enriching selections\u2026');
            await enrichMany(items, (done, total, it) => {
                setStatus(`Enriched ${done}/${total}: ${trunc(it.title)}`);
            });
        }

        let ok = 0, dup = 0, fail = 0;
        for (const item of items) {
            try {
                const result = await sendOne(item);
                if (result.status === 'added')         { ok++;  log(`\u2713 Added: ${trunc(item.title)}`, 'ok'); }
                else if (result.status === 'duplicate'){ dup++; log(`= Duplicate skipped: ${trunc(item.title)}`, 'warn'); }
                else                                   { fail++; log(`\u2717 ${result.message || 'Error'}: ${trunc(item.title)}`, 'err'); }
            } catch (err) {
                fail++; log(`\u2717 Network error: ${err && err.message ? err.message : err}`, 'err');
            }
            setStatus(`Added ${ok} \u00b7 Duplicates ${dup} \u00b7 Errors ${fail} / ${items.length}`);
        }
        setStatus(`Done. Added ${ok}, duplicates ${dup}, errors ${fail}.`);
        saveBtn.disabled = false;
    });

    function sendOne(item) {
        return new Promise((resolve, reject) => {
            if (!gmXHR) return reject(new Error('GM_xmlhttpRequest not available'));
            const payload = {
                secret:   CONFIG.SHARED_SECRET || '',
                sheetId:  CONFIG.SHEET_ID,
                folderId: CONFIG.DRIVE_FOLDER_ID,
                tab:      modeToTab(MODE),
                listing: {
                    site:       SITE,
                    mode:       MODE,
                    capturedAt: new Date().toISOString(),
                    pageUrl:    location.href,
                    // Core fields
                    title:      item.title      || '',
                    url:        item.url        || '',
                    image:      item.image      || '',
                    price:      item.price      || '',
                    seller:     item.seller     || '',
                    owner:      item.owner      || '',
                    accountAge: item.accountAge || '',
                    totalSales: item.totalSales || '',
                    itemNumber: item.itemNumber || '',
                    country:    item.country    || '',
                    // Seller-hub research fields
                    avgPrice:    item.avgPrice    || '',
                    avgShipping: item.avgShipping || '',
                    totalSold:   item.totalSold   || '',
                    sales:       item.sales       || '',
                    lastSold:    item.lastSold    || '',
                    // Optional eBay item-page enrichment
                    available:   item.available   || '',
                    sold:        item.sold        || '',
                    // Broad enrichment (filled when "Enrich" is used)
                    condition:           item.condition           || '',
                    handlingTime:        item.handlingTime        || '',
                    returns:             item.returns             || '',
                    sellerFeedbackScore: item.sellerFeedbackScore || '',
                    sellerPositivePct:   item.sellerPositivePct   || '',
                    favorites:           item.favorites           || '',
                    tags:                item.tags                || '',
                    materials:           item.materials           || '',
                    shopSales:           item.shopSales           || '',
                    shopRating:          item.shopRating          || '',
                    shopReviews:         item.shopReviews         || '',
                    shopAdmirers:        item.shopAdmirers        || '',
                    shopLocation:        item.shopLocation        || ''
                }
            };
            gmXHR({
                method: 'POST',
                url:  CONFIG.WEB_APP_URL,
                headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoid CORS preflight
                data: JSON.stringify(payload),
                timeout: 60000,
                onload: r => {
                    try { resolve(JSON.parse(r.responseText)); }
                    catch (e) { resolve({ status: 'error', message: 'Bad response: ' + String(r.responseText || '').slice(0, 140) }); }
                },
                onerror:   () => resolve({ status: 'error', message: 'Network error' }),
                ontimeout: () => resolve({ status: 'error', message: 'Timeout' })
            });
        });
    }
    function modeToTab(m) {
        switch (m) {
            case 'etsy-search':   return 'Etsy';
            case 'ebay-search':   return 'eBay Search';
            case 'ebay-store':    return 'eBay Store';
            case 'ebay-research': return 'eBay Research';
            default:              return 'Listings';
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Mutation observer — re-inject when the page re-renders
    // ────────────────────────────────────────────────────────────────────────
    let moTimer = null;
    const obs = new MutationObserver(() => {
        if (moTimer) clearTimeout(moTimer);
        moTimer = setTimeout(ensureCheckboxes, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    ensureCheckboxes();
    updateCount();
})();

/* ============================================================================
 *  APPS SCRIPT — paste into Code.gs of the Sheet-bound Apps Script project
 * ============================================================================
 *
 *  This server accepts one listing per POST, uploads the main image to Drive,
 *  and appends a row with =IMAGE(driveUrl). It dedupes by URL (and falls back
 *  to Item Number when URL is missing). Each mode writes to its own tab —
 *  "Etsy", "eBay Search", "eBay Store", "eBay Research" — so the columns can
 *  differ appropriately. Tabs are created on first use.
 *
 *  const SHARED_SECRET = '';   // match the same in CONFIG.SHARED_SECRET
 *
 *  // Each row is [header, key-on-body.listing]. The image column is special-cased.
 *  const SCHEMA = {
 *    'Etsy': [
 *      ['Captured','capturedAt'],['Site','site'],['Seller','seller'],['Owner','owner'],
 *      ['Account Age','accountAge'],['Shop Sales','shopSales'],['Shop Rating','shopRating'],
 *      ['Reviews','shopReviews'],['Admirers','shopAdmirers'],['Shop Location','shopLocation'],
 *      ['Listing #','itemNumber'],['Title','title'],['URL','url'],['Price','price'],
 *      ['Favorites','favorites'],['Tags','tags'],['Materials','materials'],
 *      ['Ships From','country'],['Image','__image']
 *    ],
 *    'eBay Search': [
 *      ['Captured','capturedAt'],['Site','site'],['Seller','seller'],
 *      ['Feedback','sellerFeedbackScore'],['Positive %','sellerPositivePct'],
 *      ['Item #','itemNumber'],['Title','title'],['URL','url'],['Price','price'],
 *      ['Available','available'],['Sold','sold'],['Condition','condition'],
 *      ['Handling','handlingTime'],['Returns','returns'],
 *      ['Ships From','country'],['Image','__image']
 *    ],
 *    'eBay Store': [
 *      ['Captured','capturedAt'],['Site','site'],['Seller','seller'],
 *      ['Item #','itemNumber'],['Title','title'],['URL','url'],['Price','price'],
 *      ['Available','available'],['Sold','sold'],['Condition','condition'],
 *      ['Image','__image']
 *    ],
 *    'eBay Research': [
 *      ['Captured','capturedAt'],['Site','site'],['Seller','seller'],
 *      ['Item #','itemNumber'],['Title','title'],['URL','url'],
 *      ['Avg Price','avgPrice'],['Avg Shipping','avgShipping'],
 *      ['Total Sold','totalSold'],['Sales','sales'],['Last Sold','lastSold'],
 *      ['Condition','condition'],['Feedback','sellerFeedbackScore'],
 *      ['Positive %','sellerPositivePct'],['Image','__image']
 *    ]
 *  };
 *
 *  function doPost(e) {
 *    try {
 *      const body = JSON.parse(e.postData.contents);
 *      if (SHARED_SECRET && body.secret !== SHARED_SECRET) return _j({status:'error',message:'Bad secret'});
 *      const ss = SpreadsheetApp.openById(body.sheetId);
 *      const tabName = body.tab || 'Listings';
 *      const schema  = SCHEMA[tabName] || SCHEMA['eBay Search'];
 *      const headers = schema.map(x => x[0]);
 *      const urlIdx  = schema.findIndex(x => x[1] === 'url');       // 0-based
 *      const imgIdx  = schema.findIndex(x => x[1] === '__image');
 *      let sheet = ss.getSheetByName(tabName);
 *      if (!sheet) {
 *        sheet = ss.insertSheet(tabName);
 *        sheet.appendRow(headers);
 *        sheet.setFrozenRows(1);
 *        if (imgIdx >= 0) sheet.setColumnWidth(imgIdx + 1, 140);
 *      }
 *      const last = sheet.getLastRow();
 *      if (last >= 2 && urlIdx >= 0 && body.listing.url) {
 *        const existing = sheet.getRange(2, urlIdx + 1, last - 1, 1).getValues().map(r => r[0]);
 *        if (existing.indexOf(body.listing.url) !== -1) return _j({status:'duplicate'});
 *      }
 *      let driveUrl = '';
 *      if (body.listing.image) {
 *        try {
 *          const folder = DriveApp.getFolderById(body.folderId);
 *          const resp = UrlFetchApp.fetch(body.listing.image, {muteHttpExceptions:true});
 *          if (resp.getResponseCode() === 200) {
 *            const blob = resp.getBlob().setName(_safeName(body.listing) + _ext(resp));
 *            const file = folder.createFile(blob);
 *            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
 *            driveUrl = 'https://drive.google.com/uc?export=view&id=' + file.getId();
 *          }
 *        } catch (imgErr) { driveUrl = body.listing.image; }
 *      }
 *      const img = driveUrl ? '=IMAGE("' + driveUrl.replace(/"/g,'""') + '")' : '';
 *      const L = body.listing;
 *      const row = schema.map(([,k]) => k === '__image' ? img : (L[k] == null ? '' : L[k]));
 *      sheet.appendRow(row);
 *      const r = sheet.getLastRow();
 *      sheet.setRowHeight(r, 120);
 *      return _j({status:'added', tab: tabName});
 *    } catch (err) { return _j({status:'error', message:String(err)}); }
 *  }
 *
 *  function doGet() { return _j({status:'ok'}); }
 *  function _j(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
 *  function _safeName(l) {
 *    return (l.site + '_' + (l.itemNumber || l.title || 'listing'))
 *      .replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,80);
 *  }
 *  function _ext(resp) {
 *    const ct = (resp.getHeaders()['Content-Type']||'').toLowerCase();
 *    if (ct.indexOf('png')  !== -1) return '.png';
 *    if (ct.indexOf('webp') !== -1) return '.webp';
 *    if (ct.indexOf('gif')  !== -1) return '.gif';
 *    return '.jpg';
 *  }
 * ============================================================================
 */
