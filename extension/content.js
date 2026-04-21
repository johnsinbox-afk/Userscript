/*  Listing Collector — content script.
 *  Runs on Etsy & eBay pages. Extraction / filter / enrichment logic ported
 *  from the userscript. Background fetches and the Google Sheets save path
 *  go through the extension's service worker (see background.js).
 */

(function () {
    'use strict';

    // ── Cross-browser shim ─────────────────────────────────────────────
    const api = (typeof browser !== 'undefined' ? browser : chrome);

    // Ask the background worker to perform a cross-origin GET and return
    // the resulting HTML as text. Equivalent to GM_xmlhttpRequest.
    function bgFetch(url) {
        return new Promise(resolve => {
            try {
                api.runtime.sendMessage({ type: 'fetch', url }, reply => {
                    if (!reply || !reply.ok) return resolve({ ok: false });
                    resolve({ ok: true, text: reply.text });
                });
            } catch (e) { resolve({ ok: false }); }
        });
    }
    function fetchDoc(url) {
        return bgFetch(url).then(r => {
            if (!r.ok || !r.text) return null;
            try { return new DOMParser().parseFromString(r.text, 'text/html'); } catch (e) { return null; }
        });
    }

    // ── Site / mode detection ──────────────────────────────────────────
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    const isEtsy = /(^|\.)etsy\.com$/i.test(host);
    const isEbay = /(^|\.)ebay\./i.test(host);
    const isFb   = /(^|\.)facebook\.com$/i.test(host) || /(^|\.)fb\.com$/i.test(host);
    if (!isEtsy && !isEbay && !isFb) return;

    // Per-mode config. `cardSelector` is optional — if absent, the mode must
    // provide a `findCards()` function that returns an array of DOM roots.
    const MODES = {
        'etsy-search': {
            site: 'etsy',
            cardSelector: '.v2-listing-card[data-listing-id]',
            title: 'h3, h2, a.listing-link, [data-listing-card-title]',
            price: '.currency-value, [data-listing-price], [data-buy-box-region="price"] .currency-value',
            image: 'img[srcset], img[src]'
        },
        'ebay-research': {
            site: 'ebay',
            cardSelector: 'tr.research-table-row',
            title: '.research-table-row__product-info-name span[data-item-id], span[data-item-id]',
            price: '.research-table-row__avgSoldPrice',
            image: 'img'
        },
        'ebay-store': {
            site: 'ebay',
            cardSelector: 'article.StoreFrontItemCard, article.str-item-card.StoreFrontItemCard',
            title: '.str-card-title .str-text-span, .str-item-card__property-title .str-text-span',
            price: '.str-item-card__property-displayPrice',
            image: 'img[data-testid="str-img"], .str-image img, img.zoom'
        },
        'ebay-search': {
            site: 'ebay',
            cardSelector: '.su-card-container',
            title: '.s-card__title',
            price: '.s-card__price',
            image: 'img.s-card__image'
        },
        'fb-ads': {
            site: 'facebook',
            // FB has no stable classes; we discover cards by walking up from
            // any "Library ID" text node. See findFbAdCards() below.
            findCards: () => findFbAdCards()
        },
        'fb-posts': {
            site: 'facebook',
            // Facebook posts / sponsored posts in the main feed.
            cardSelector: 'div[role="article"], [data-pagelet^="FeedUnit_"] div[role="article"]'
        }
    };
    function detectMode() {
        if (isEtsy) return 'etsy-search';
        if (isEbay) {
            for (const m of ['ebay-research', 'ebay-store', 'ebay-search']) {
                if (document.querySelector(MODES[m].cardSelector)) return m;
            }
            return 'ebay-search';
        }
        if (isFb) {
            // /ads/library/* → ads mode; otherwise feed/posts mode.
            if (/\/ads\/library/.test(path)) return 'fb-ads';
            return 'fb-posts';
        }
        return 'ebay-search';
    }
    let MODE = detectMode(), CFG = MODES[MODE];
    const SITE = CFG.site;
    function maybeUpgradeMode() {
        if (isEbay && MODE !== 'ebay-search') return;
        if (isEbay) {
            for (const m of ['ebay-research', 'ebay-store']) {
                if (document.querySelector(MODES[m].cardSelector)) { MODE = m; CFG = MODES[m]; return; }
            }
        }
    }

    // ── Tiny DOM helper ────────────────────────────────────────────────
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

    // ── URL / image normalization ──────────────────────────────────────
    function cleanUrl(u) {
        if (!u) return '';
        try {
            const url = new URL(u, location.href);
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
        src = src.replace(/\/s-l\d+\./, '/s-l1600.');
        src = src.replace(/il_\d+x\d+\./, 'il_fullxfull.');
        src = src.replace(/il_\d+xN\./,   'il_fullxfull.');
        const m = src.match(/^(.*?\.(?:jpe?g|png|webp|gif))(?:\?|$)/i);
        if (m) src = m[1];
        return src;
    }

    // ── Seller / country helpers (same as userscript) ──────────────────
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
            const m2 = location.pathname.match(/\/str\/([^\/?]+)/);
            if (m2) return decodeURIComponent(m2[1]);
        } catch (e) {}
        return '';
    }
    function parseEtsyTooltip(card) {
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
        // Fast path — specific desktop selector.
        let el = card.querySelector('.su-card-container__attributes__primary .s-card__attribute-row span.su-styled-text.secondary.large');
        if (el && /Located in/i.test(el.textContent || '')) {
            return textOf(el).replace(/^Located in\s*/i, '').trim();
        }
        // Fast path — mobile / alt dedicated element.
        const loc = card.querySelector('.s-item__location, .s-item__itemLocation');
        if (loc) return textOf(loc).replace(/^from\s+/i, '').trim();
        // Last resort — single string match on the card's text, O(length)
        // rather than O(node count). Cheap even on crowded cards.
        const text = (card.innerText || card.textContent || '');
        const m = text.match(/Located in\s+([^\n.]+?)(?:\s{2,}|$|\n)/i);
        return m ? m[1].trim() : '';
    }

    // ── Exclusion zones ────────────────────────────────────────────────
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
        // Facebook has its own scoping (we only ever pick cards with a
        // Library ID or role=article), so skip the pagination / carousel
        // exclusions which don't apply.
        if (isFb) return true;
        if (isBelowPagination(card)) return false;
        if (isUnderExcludedHeading(card)) return false;
        if (isInCarouselOrSrpAnswer(card)) return false;
        if (isEtsy && !isEtsyCardInScope(card)) return false;
        // Skip eBay's filler cards inserted amongst the real results:
        //   - "Shop on eBay" template stub (sometimes appears twice) — fake
        //     image + dummy /itm/123456 href.
        //   - "Find more like this / See all similar items" recommendation
        //     tile — no listing of its own, just a link cluster.
        if (isEbay) {
            try {
                const t = (card.textContent || '').trim();
                if (/^Shop on eBay/i.test(t.slice(0, 30))) return false;
                if (/^Find more like this/i.test(t.slice(0, 30))) return false;
                if (/See all similar items/i.test(t.slice(0, 80)) && !card.querySelector('.s-card__price')) return false;
                const a = card.querySelector('a[href*="/itm/123456"]');
                if (a) return false;
                const img = card.querySelector('img');
                if (img && /ebaystatic\.com\/.*\/[a-z0-9]{10,}\.png/i.test(img.currentSrc || img.src || '')) return false;
            } catch (e) {}
        }
        return true;
    }

    // ── Extraction per mode ────────────────────────────────────────────
    function baseRecord() {
        return {
            title:'', url:'', image:'', price:'', seller:'',
            owner:'', accountAge:'', totalSales:'',
            itemNumber:'', country:'',
            avgPrice:'', avgShipping:'', totalSold:'', sales:'', lastSold:'',
            available:'', sold:'',
            shopSales:'', shopRating:'', shopReviews:'', shopAdmirers:'',
            favorites:'', tags:'', materials:'', shopLocation:'',
            condition:'', handlingTime:'', returns:'',
            sellerFeedbackScore:'', sellerPositivePct:'',
            // Facebook fields (ads + posts)
            libraryId:'', fbStatus:'', page:'', pageUrl:'', pageIcon:'',
            platforms:'', startDate:'', endDate:'', totalActiveTime:'',
            adText:'', adLinkText:'', adLinkUrl:'',
            videoUrl:'', videoThumb:'',
            postTime:'', isSponsored:'', reactions:'', comments:'', shares:''
        };
    }
    function extractEtsy(card) {
        const rec = baseRecord();
        const titleEl = card.querySelector(CFG.title);
        rec.title = textOf(titleEl) || '[No Title]';
        const a = card.querySelector('a[href*="/listing/"]');
        rec.url = a && a.href ? cleanUrl(a.href) : '';
        rec.image = normalizeImgSrc(card.querySelector(CFG.image));
        const pEl = card.querySelector(CFG.price);
        if (pEl) {
            const sym = pEl.previousElementSibling && /[$€£¥]/.test(pEl.previousElementSibling.textContent || '') ? pEl.previousElementSibling : null;
            rec.price = ((sym ? sym.textContent : '') + pEl.textContent).trim() || textOf(pEl);
        }
        rec.seller = getEtsySeller(card);
        const tip = parseEtsyTooltip(card);
        rec.owner = tip.owner; rec.accountAge = tip.accountAge; rec.totalSales = tip.totalSales;
        if (a && a.href) { const m = a.href.match(/\/listing\/(\d+)/); if (m) rec.itemNumber = m[1]; }
        if (!rec.itemNumber && card.dataset && card.dataset.listingId) rec.itemNumber = String(card.dataset.listingId).trim();
        rec.country = getEtsyCountry(card) || tip.country || '';
        return rec;
    }
    function extractEbaySearch(card) {
        const rec = baseRecord();
        const titleEl = card.querySelector(CFG.title);
        rec.title = textOf(titleEl) || '[No Title]';
        const linkFromTitle = titleEl && titleEl.closest('a');
        if (linkFromTitle && linkFromTitle.href) rec.url = cleanUrl(linkFromTitle.href);
        if (!rec.url) {
            const a = card.querySelector('a[href*="/itm/"]');
            if (a && a.href) rec.url = cleanUrl(a.href);
        }
        rec.image = normalizeImgSrc(card.querySelector(CFG.image));
        rec.price = textOf(card.querySelector(CFG.price));
        rec.seller = getEbaySearchSeller(card);
        const liWithId = card.closest && card.closest('li[data-listingid]');
        if (liWithId) rec.itemNumber = (liWithId.getAttribute('data-listingid') || '').trim();
        if (!/^\d{6,}$/.test(rec.itemNumber)) rec.itemNumber = '';
        if (!rec.itemNumber) { const m = (rec.url || '').match(/\/itm\/(\d+)/); if (m) rec.itemNumber = m[1]; }
        // Fallback to scanning the entire card's text for "Item: NNNNNN".
        // eBay's class names shift every few months so we can't rely on a
        // specific selector.
        if (!rec.itemNumber) {
            const m = (card.innerText || card.textContent || '').match(/Item\s*[:#]?\s*(\d{6,})/i);
            if (m) rec.itemNumber = m[1];
        }
        // Final fallback: `listingId` / `itemId` / `data-view` attributes
        // anywhere in the card. Matches any 9-15 digit number.
        if (!rec.itemNumber) {
            const attrs = ['data-listingid', 'data-itemid', 'data-view', 'data-testid'];
            outer: for (const node of card.querySelectorAll('[data-listingid],[data-itemid],[data-view],[data-testid]')) {
                for (const a of attrs) {
                    const v = node.getAttribute(a) || '';
                    const m = v.match(/(\d{9,15})/);
                    if (m) { rec.itemNumber = m[1]; break outer; }
                }
            }
        }
        rec.country = getEbaySearchCountry(card);
        return rec;
    }
    function extractEbayStore(card) {
        const rec = baseRecord();
        const titleEl = card.querySelector(CFG.title);
        rec.title = textOf(titleEl) || '[No Title]';
        const a = card.querySelector('a[href*="/itm/"]') || card.querySelector('a.str-item-card__link');
        rec.url = a && a.href ? cleanUrl(a.href) : '';
        rec.image = normalizeImgSrc(card.querySelector(CFG.image));
        rec.price = textOf(card.querySelector(CFG.price));
        rec.seller = getEbayStoreSeller();
        if (a && a.href) { const m = a.href.match(/\/itm\/(\d+)/); if (m) rec.itemNumber = m[1]; }
        if (!rec.itemNumber) {
            const dt = (card.getAttribute('data-testid') || '') + ((card.dataset && card.dataset.testid) || '');
            const m = dt.match(/(\d{6,})/); if (m) rec.itemNumber = m[1];
        }
        return rec;
    }
    function extractEbayResearch(row) {
        const rec = baseRecord();
        const idEl = row.querySelector('span[data-item-id]');
        rec.itemNumber = idEl ? (idEl.getAttribute('data-item-id') || '').trim() : '';
        const titleEl = row.querySelector('.research-table-row__product-info-name span[data-item-id]') || idEl;
        rec.title = textOf(titleEl);
        rec.url = rec.itemNumber ? 'https://www.ebay.com/itm/' + rec.itemNumber : '';
        rec.image = normalizeImgSrc(row.querySelector('img'));
        const firstDivText = sel => {
            const el = row.querySelector(sel); if (!el) return '';
            const d = el.querySelector('div'); return textOf(d || el);
        };
        rec.avgPrice    = firstDivText('.research-table-row__avgSoldPrice');
        rec.avgShipping = firstDivText('.research-table-row__avgShippingCost');
        rec.totalSold   = firstDivText('.research-table-row__totalSoldCount');
        rec.sales       = firstDivText('.research-table-row__totalSalesValue');
        rec.lastSold    = firstDivText('.research-table-row__dateLastSold');
        rec.price       = rec.avgPrice;
        rec.seller = (row.dataset && row.dataset.uecSeller) || '';
        const prev = row.previousElementSibling;
        if (!rec.seller && prev && prev.classList && prev.classList.contains('policyViolationMessageRow')) rec.seller = 'Policy Violation';
        return rec;
    }
    // Counter so we log at most 3 exceptions total — enough to diagnose,
    // not enough to flood.
    let __extractErrLogged = 0;
    function extract(card) {
        try {
            switch (MODE) {
                case 'etsy-search':   return extractEtsy(card)         || baseRecord();
                case 'ebay-search':   return extractEbaySearch(card)   || baseRecord();
                case 'ebay-store':    return extractEbayStore(card)    || baseRecord();
                case 'ebay-research': return extractEbayResearch(card) || baseRecord();
                case 'fb-ads':        return extractFbAd(card)         || baseRecord();
                case 'fb-posts':      return extractFbPost(card)       || baseRecord();
            }
        } catch (e) {
            if (__extractErrLogged++ < 3) {
                console.error('[uec] extract threw on card (showing first 3 only):', e && e.stack || e, card);
            }
        }
        return baseRecord();
    }

    // ────────────────────────────────────────────────────────────────────
    //  Facebook helpers
    // ────────────────────────────────────────────────────────────────────
    const FB_PLAT_OK = /^(Facebook|Instagram|Messenger|Audience Network|Threads)$/i;
    const FB_CTA_BLOCK_HREF = /(metastatus\.com|ads-transparency|about[-\s]?ads|privacy|terms|cookies|help|faq|status)/i;
    const FB_CTA_BLOCK_TEXT = /^(System status|Ad Library Report|Ad Library API|Branded Content|Open navigation panel|Close navigation panel|Subscribe to email updates|CSV exports|FAQ|About ads and data use|Privacy|Terms|Cookies)$/i;

    function fbVisible(e) {
        if (!e || e.nodeType !== 1) return false;
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
        const r = e.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    }
    function fbUnwrap(u) {
        try {
            if (!u) return '';
            const url = new URL(u, location.href);
            if (url.hostname === 'l.facebook.com' && url.pathname === '/l.php' && url.searchParams.get('u')) return url.searchParams.get('u');
            return u;
        } catch (e) { return u; }
    }
    function fbImgOf(img) {
        if (!img) return '';
        let raw = img.currentSrc || img.src || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-image') || '';
        raw = (raw || '').split(' ')[0];
        raw = absUrl(raw);
        if (raw && !raw.startsWith('data:')) {
            try { const u = new URL(raw); if (/\.webp$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\.webp$/i, '.jpg'); return u.href; }
            catch (e) {}
        }
        return raw;
    }
    function fbLargestImg(el) {
        if (!el) return null;
        const imgs = Array.from(el.querySelectorAll('picture img, img')).filter(i => fbVisible(i) && fbImgOf(i));
        let best = null, area = -1;
        for (const i of imgs) {
            const r = i.getBoundingClientRect(), aa = r.width * r.height;
            if (aa > area) { area = aa; best = i; }
        }
        return best;
    }
    function fbPickPageIcon(card) {
        const imgs = Array.from(card.querySelectorAll('img[alt]')).filter(i => fbVisible(i) && textOf(i) === '' && (i.getAttribute('alt') || '').trim() && fbImgOf(i));
        let best = null, score = 1e18;
        for (const i of imgs) {
            const alt = (i.getAttribute('alt') || '').trim();
            if (!alt || alt.length > 80) continue;
            const r = i.getBoundingClientRect(), area = r.width * r.height;
            if (area < 200 || area > 25000) continue;
            const sc = r.top * 12 + r.left + Math.abs(area - 3600);
            if (sc < score) { score = sc; best = i; }
        }
        return best;
    }
    function fbPageFromIcon(card) {
        const icon = fbPickPageIcon(card);
        if (!icon) return { page: '', pageUrl: '', pageIcon: '' };
        const page = (icon.getAttribute('alt') || '').trim();
        const pageIcon = fbImgOf(icon);
        let pageUrl = '';
        let scope = icon.closest('div') || icon.parentElement || card;
        for (let k = 0; k < 7 && scope && scope !== document.body; k++) {
            for (const a of scope.querySelectorAll('a[href]')) {
                let href = fbUnwrap(absUrl(a.getAttribute('href') || a.href || ''));
                if (!href || /l\.facebook\.com\/l\.php/i.test(href)) continue;
                try {
                    const u = new URL(href);
                    const h = u.hostname.replace(/^www\./, '');
                    if (h !== 'facebook.com' && !h.endsWith('facebook.com')) continue;
                    if (u.pathname.startsWith('/ads/library')) continue;
                    if (/\/privacy|\/policies|\/help|\/login/i.test(u.pathname)) continue;
                    const tx = textOf(a);
                    if (tx && tx.toLowerCase() === page.toLowerCase()) { pageUrl = href; break; }
                    if (!pageUrl) pageUrl = href;
                } catch (e) {}
            }
            if (pageUrl) break;
            scope = scope.parentElement;
        }
        return { page, pageUrl, pageIcon };
    }
    function fbFindLibraryId(card) {
        const t = textOf(card);
        const m = t.match(/Library ID\s*[:#]?\s*([0-9]{6,})/i);
        return m ? m[1] : '';
    }
    function fbFindStatus(card) {
        const t = textOf(card);
        let m = t.match(/Status\s*:\s*(Active|Inactive)\b/i);
        if (m) return m[1];
        m = t.match(/\b(Active|Inactive)\b/i);
        return m ? m[1] : '';
    }
    function fbFindAdText(card) {
        const pre = card.querySelector('[style*="white-space: pre-wrap"]');
        if (pre) { const t = textOf(pre); if (t) return t; }
        const nodes = Array.from(card.querySelectorAll('div[role="button"],span[role="button"],div,span')).filter(n => fbVisible(n));
        let best = '';
        for (const n of nodes) {
            const t = textOf(n);
            if (!t || t.length < 40 || t.length > 5000) continue;
            if (/^(Library ID|Platforms|See ad details|See summary details|Open Dropdown|Sponsored|EU transparency|About this ad|Why am I seeing this ad|Report ad|Shop now)$/i.test(t)) continue;
            if (t.length > best.length) best = t;
        }
        return best;
    }
    function fbFindRunning(card) {
        const lines = String(card.innerText || '').split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
        for (const line of lines) {
            const m = line.match(/^Started running(?: on)?\s*(.+)$/i);
            if (m) return m[1];
        }
        const mon = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*';
        const d1 = new RegExp('\\b' + mon + '\\s+\\d{1,2},\\s+\\d{4}(?:\\s*[-–—]\\s*' + mon + '\\s+\\d{1,2},\\s+\\d{4})?\\b', 'i');
        for (const line of lines) {
            if (/Library ID/i.test(line)) continue;
            if (d1.test(line) && line.length <= 200) return line;
        }
        return '';
    }
    function fbSplitRunning(r) {
        r = (r || '').trim();
        let total = '', main = r;
        const parts = r.split('·').map(s => s.trim()).filter(Boolean);
        if (parts.length) {
            main = parts[0] || '';
            for (let i = 1; i < parts.length; i++) {
                if (/total active time/i.test(parts[i])) total = parts[i].replace(/.*total active time\s*/i, '').trim();
            }
        }
        const d = main.split(/[-–—]/).map(s => s.trim()).filter(Boolean);
        return { start: d[0] || '', end: d[1] || d[0] || '', total, raw: r };
    }
    function fbFindVideo(card) {
        const v = card.querySelector('video');
        if (!v) return { videoUrl: '', thumb: '' };
        let src = v.currentSrc || v.src || '';
        if (!src) {
            const s = v.querySelector('source');
            src = (s && (s.src || s.getAttribute('src'))) || '';
        }
        src = absUrl(fbUnwrap(src));
        const poster = fbImgOf({ src: v.poster || v.getAttribute('poster') || '', currentSrc: '', getAttribute: a => v.getAttribute(a) });
        return { videoUrl: src, thumb: poster };
    }
    function fbFindCta(card) {
        const media = card.querySelector('video') || fbLargestImg(card);
        if (!media) return { adLinkText: '', adLinkUrl: '' };
        const mr = media.getBoundingClientRect();
        const mcx = mr.left + mr.width / 2, mcy = mr.top + mr.height / 2;
        let best = null, bd = Infinity;
        for (const a of card.querySelectorAll('a[href]')) {
            let href = fbUnwrap(absUrl(a.getAttribute('href') || a.href || ''));
            if (!href || FB_CTA_BLOCK_HREF.test(href)) continue;
            const at = textOf(a);
            if (FB_CTA_BLOCK_TEXT.test(at)) continue;
            try {
                const u = new URL(href);
                const h = u.hostname.replace(/^www\./, '');
                if (h === 'facebook.com' || h.endsWith('facebook.com') || h === 'fb.com' || h.endsWith('fb.com') || h === 'instagram.com' || h.endsWith('instagram.com')) continue;
            } catch (e) { continue; }
            const ar = a.getBoundingClientRect();
            if (ar.width < 10 || ar.height < 10) continue;
            const d = Math.hypot(ar.left + ar.width / 2 - mcx, ar.top + ar.height / 2 - mcy);
            if (d < bd) { bd = d; best = a; }
        }
        if (!best) return { adLinkText: '', adLinkUrl: '' };
        return { adLinkText: textOf(best), adLinkUrl: fbUnwrap(absUrl(best.getAttribute('href') || best.href || '')) };
    }
    function fbFindPlatforms(card) {
        // Mobile Safari has no hover, so we can only harvest static metadata
        // exposed via aria-label/title/data-tooltip-content on the icon row.
        let lab = null;
        for (const n of card.querySelectorAll('span, div')) {
            if (textOf(n) === 'Platforms') { lab = n; break; }
        }
        if (!lab) return '';
        const box = lab.parentElement || lab.closest('div');
        if (!box) return '';
        const vals = new Set();
        const push = v => {
            (v || '').split(',').map(s => s.trim()).forEach(x => { if (FB_PLAT_OK.test(x)) vals.add(x); });
        };
        for (const el of box.querySelectorAll('[aria-label],[title],[data-tooltip-content]')) {
            push(el.getAttribute('aria-label'));
            push(el.getAttribute('title'));
            push(el.getAttribute('data-tooltip-content'));
        }
        return Array.from(vals).join(', ');
    }

    // Walk up from every "Library ID" text node to find the smallest
    // ancestor that contains exactly one Library ID and a media element.
    function findFbAdCards() {
        const roots = new Set();
        const candidates = Array.from(document.querySelectorAll('div, span'))
            .filter(el => fbVisible(el) && /Library ID/i.test(el.textContent || '') && /\d{6,}/.test(el.textContent || ''));
        for (const h of candidates) {
            let cur = h;
            for (let i = 0; i < 18 && cur && cur !== document.body; i++) {
                const r = cur.getBoundingClientRect();
                if (r.width < 240 || r.height < 240 || r.height > 1600) { cur = cur.parentElement; continue; }
                const txt = cur.innerText || cur.textContent || '';
                const idMatches = txt.match(/Library ID\s*[:#]?\s*\d{6,}/ig) || [];
                if (idMatches.length !== 1) { cur = cur.parentElement; continue; }
                if (fbLargestImg(cur) || cur.querySelector('video')) { roots.add(cur); break; }
                cur = cur.parentElement;
            }
        }
        return Array.from(roots);
    }

    function extractFbAd(card) {
        const rec = baseRecord();
        rec.libraryId = fbFindLibraryId(card);
        rec.fbStatus = fbFindStatus(card);
        const pg = fbPageFromIcon(card);
        rec.page = pg.page; rec.pageUrl = pg.pageUrl; rec.pageIcon = pg.pageIcon;
        rec.seller = pg.page; // reuse the "seller" slot for dedupe / display
        rec.platforms = fbFindPlatforms(card);
        const run = fbSplitRunning(fbFindRunning(card));
        rec.startDate = run.start; rec.endDate = run.end; rec.totalActiveTime = run.total;
        rec.adText = fbFindAdText(card); rec.title = rec.adText.slice(0, 180);
        const v = fbFindVideo(card);
        rec.videoUrl = v.videoUrl; rec.videoThumb = v.thumb;
        const big = fbLargestImg(card);
        rec.image = v.thumb || (big ? fbImgOf(big) : '');
        const cta = fbFindCta(card);
        rec.adLinkText = cta.adLinkText; rec.adLinkUrl = cta.adLinkUrl;
        rec.itemNumber = rec.libraryId;
        rec.url = rec.libraryId ? 'https://www.facebook.com/ads/library/?id=' + encodeURIComponent(rec.libraryId) : '';
        return rec;
    }

    // ── Facebook post / sponsored post extraction ──────────────────────
    function fbPostIsSponsored(card) {
        // FB puts the word "Sponsored" in subtle markup; check the
        // aria-label path and the visible text of the header region.
        if (card.querySelector('[aria-label="Sponsored" i]')) return true;
        const head = card.querySelector('h3, h4, [role="heading"]');
        const t = textOf(head || card).slice(0, 400);
        return /\bSponsored\b/.test(t);
    }
    function fbPostPoster(card) {
        // First non-anonymous "strong" inside the header area (poster name).
        const link = card.querySelector('h3 a, h4 a, [role="heading"] a, a[role="link"][href*="/"]');
        if (link) return { name: textOf(link), url: fbUnwrap(absUrl(link.getAttribute('href') || link.href || '')) };
        return { name: '', url: '' };
    }
    function fbPostPermalink(card) {
        // Look for the "<time>" / "min" / "h" / "d" tiny relative-time
        // link, which is the stable permalink.
        const t = card.querySelector('a[aria-label][role="link"][href*="/posts/"], a[href*="/posts/"], a[href*="/videos/"], a[href*="/permalink/"], a[href*="/share/"]');
        if (t) return fbUnwrap(absUrl(t.getAttribute('href') || t.href || ''));
        // Fallback: any <a> whose text looks like a relative time.
        for (const a of card.querySelectorAll('a[role="link"]')) {
            const tx = textOf(a);
            if (/^(Just now|\d+\s*(m|min|mins|minutes|h|hr|hrs|hours|d|days|w|weeks|y|years?)\b|yesterday)$/i.test(tx)) {
                return fbUnwrap(absUrl(a.getAttribute('href') || a.href || ''));
            }
        }
        return '';
    }
    function fbPostTimestamp(card) {
        const ab = card.querySelector('a[aria-label][role="link"][href*="/posts/"], a[aria-label][role="link"][href*="/videos/"]');
        if (ab) return (ab.getAttribute('aria-label') || '').trim();
        for (const a of card.querySelectorAll('a[role="link"]')) {
            const tx = textOf(a);
            if (/^(Just now|\d+\s*(m|min|mins|minutes|h|hr|hrs|hours|d|days|w|weeks|y|years?)\b|yesterday)$/i.test(tx)) return tx;
        }
        return '';
    }
    function fbPostText(card) {
        // Main body text is usually inside [data-ad-preview="message"] or a
        // <div dir="auto"> with lots of text. Pick the longest visible one.
        const cands = Array.from(card.querySelectorAll('[data-ad-preview="message"], div[dir="auto"], div[data-testid="post_message"], div[role="article"] div[dir="auto"]'))
            .filter(n => fbVisible(n));
        let best = '';
        for (const n of cands) {
            const t = textOf(n);
            if (t.length > best.length && t.length < 6000) best = t;
        }
        return best;
    }
    function fbPostCounts(card) {
        const t = textOf(card);
        const out = { reactions: '', comments: '', shares: '' };
        let m = t.match(/([\d.,]+[KkMm]?)\s+(?:comments?)\b/i);
        if (m) out.comments = m[1];
        m = t.match(/([\d.,]+[KkMm]?)\s+(?:shares?)\b/i);
        if (m) out.shares = m[1];
        // Reactions are either "N reactions" or the generic "Like" count near a thumb row.
        m = t.match(/([\d.,]+[KkMm]?)\s+(?:reactions?|likes?)\b/i);
        if (m) out.reactions = m[1];
        return out;
    }
    function extractFbPost(card) {
        const rec = baseRecord();
        const poster = fbPostPoster(card);
        rec.page = poster.name; rec.pageUrl = poster.url; rec.seller = poster.name;
        rec.adText = fbPostText(card); rec.title = rec.adText.slice(0, 180);
        rec.postTime = fbPostTimestamp(card);
        rec.isSponsored = fbPostIsSponsored(card) ? 'Yes' : '';
        const perma = fbPostPermalink(card);
        rec.url = perma;
        const v = fbFindVideo(card);
        rec.videoUrl = v.videoUrl; rec.videoThumb = v.thumb;
        const big = fbLargestImg(card);
        rec.image = v.thumb || (big ? fbImgOf(big) : '');
        const cta = fbFindCta(card);
        rec.adLinkText = cta.adLinkText; rec.adLinkUrl = cta.adLinkUrl;
        const c = fbPostCounts(card);
        rec.reactions = c.reactions; rec.comments = c.comments; rec.shares = c.shares;
        // A post's "id" — use permalink, otherwise a hash of text + poster.
        rec.itemNumber = perma || (poster.name + '|' + rec.adText.slice(0, 60));
        return rec;
    }

    // ── Keyword language ───────────────────────────────────────────────
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
            const tok = peek(); if (!tok) return { type: 'TRUE' };
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

    // ── Persistent selection state per site+path ──────────────────────
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
                query: state.query,
                countries: Array.from(state.countries),
                cache: state.cache,
                autoMode: state.autoMode
            }));
        } catch (e) {}
    }
    const state = (() => {
        const o = loadState();
        return {
            selectedIds: new Set(o.selectedIds),
            query: o.query, countries: new Set(o.countries),
            cache: o.cache, autoMode: o.autoMode
        };
    })();
    // If we can't extract a stable key from the card, synthesize one so we
    // never silently drop a selection (previously the counter stuck at 0).
    let __synthCounter = 0;
    function keyFor(data) {
        return (data && (data.itemNumber || data.url || data.libraryId)) || ('uec-synth-' + (++__synthCounter) + '-' + Date.now());
    }
    function rememberSelection(id, data) {
        if (!id) id = keyFor(data);
        state.selectedIds.add(id);
        state.cache[id] = Object.assign({ __savedAt: Date.now() }, data || {});
        saveState();
        return id;
    }
    function forgetSelection(id) {
        if (!id) return;
        state.selectedIds.delete(id);
        delete state.cache[id];
        saveState();
    }

    // ── Overlay UI ─────────────────────────────────────────────────────
    const toggleBtn = h('button', { class: 'uec-toggle', title: 'Listing Collector' },
        'List', h('span', { class: 'uec-count', id: 'uec-count' }, '0')
    );
    const keywordInput = h('input', { type: 'text', placeholder: 'AND by space · OR by comma · "quoted phrase" · -exclude · (parens)' });
    const keywordHint  = h('div',  { class: 'uec-hint' }, 'Filters visible cards by title.');
    const countryBox   = h('div',  { class: 'uec-country-box' });
    const countryHint  = h('div',  { class: 'uec-hint' }, 'Tick none to show all. Countries are discovered from the page.');
    const targetBox    = h('div',  { class: 'uec-target' }, 'Loading target sheet…');
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
    const enrichLbl    = h('label', { for: 'uec-enrich-chk', style: 'font-size:12px;color:#333;display:flex;align-items:center;gap:6px;flex:1 1 auto;' },
        enrichToggle, 'Enrich before save'
    );
    const saveBtn      = h('button', { class: 'primary' }, 'Save Selected to Google Sheets');

    const modeLabel =
        MODE === 'etsy-search'   ? 'Etsy search' :
        MODE === 'ebay-search'   ? 'eBay search' :
        MODE === 'ebay-store'    ? 'eBay store'  :
        MODE === 'ebay-research' ? 'eBay research' :
        MODE === 'fb-ads'        ? 'Facebook Ad Library' :
        MODE === 'fb-posts'      ? 'Facebook feed'   : MODE;

    const panel = h('div', { class: 'uec-panel', hidden: true },
        h('div', { class: 'uec-head' },
            h('div', {},
                h('h3', {}, 'Listing Collector'),
                h('div', { class: 'uec-mode' }, modeLabel)
            ),
            h('button', { title: 'Close', onclick: () => togglePanel(false) }, '\u00d7')
        ),
        h('div', { class: 'uec-body' },
            targetBox,
            h('label', { class: 'uec-lbl', style: 'margin-top:10px;' }, 'Search & Select'),
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
            state.query = keywordInput.value.trim();
            state.autoMode = state.query ? 'query' : 'manual';
            saveState(); applyFilters();
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

    function log(msg, cls)   { logEl.appendChild(h('div', { class: cls || '' }, '\u2022 ' + msg)); logEl.scrollTop = logEl.scrollHeight; }
    function setStatus(s)    { statusEl.textContent = s; }
    function updateCount()   { document.getElementById('uec-count').textContent = String(state.selectedIds.size); }
    function trunc(s)        { return (s || '').length > 60 ? s.slice(0, 57) + '\u2026' : s; }

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
                saveState(); rebuildCountryBox(); applyFilters();
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

    // ── Inject per-card checkboxes / research-row decoration ──────────
    const researchSellerCache = new Map();
    function decorateResearchRow(row) {
        const thumb = row.querySelector('.research-table-row__thumbnail') || row;
        if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';
        const idEl = row.querySelector('span[data-item-id]');
        const itemNumber = idEl ? idEl.getAttribute('data-item-id') : '';
        const input = h('input', { type: 'checkbox' });
        if (itemNumber && state.selectedIds.has(itemNumber)) input.checked = true;
        input.addEventListener('click', e => e.stopPropagation());
        let persistedId = itemNumber || '';
        input.addEventListener('change', () => {
            row._uecData = extract(row);
            if (input.checked) {
                persistedId = rememberSelection(keyFor(row._uecData), row._uecData);
            } else {
                forgetSelection(persistedId);
            }
            updateCount();
        });
        const wrap = h('div', { class: 'uec-listing-check', title: 'Select' }, input);
        thumb.appendChild(wrap);
        const label = h('div', { class: 'uec-research-label', style: 'position:absolute;left:40px;top:6px;font-size:11.5px;background:rgba(255,255,255,.92);padding:2px 6px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.15);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:50;' }, '\u2026');
        thumb.appendChild(label);
        if (itemNumber) {
            fetchResearchSellerName(itemNumber, row).then(name => {
                row.dataset.uecSeller = name || '';
                row._uecData = extract(row);
                if (state.selectedIds.has(itemNumber)) {
                    state.cache[itemNumber] = Object.assign({ __savedAt: Date.now() }, row._uecData);
                    saveState();
                }
                label.textContent = name || '';
            });
        }
    }
    async function fetchResearchSellerName(itemNumber, row) {
        if (researchSellerCache.has(itemNumber)) return researchSellerCache.get(itemNumber);
        const prev = row.previousElementSibling;
        if (prev && prev.classList && prev.classList.contains('policyViolationMessageRow')) {
            researchSellerCache.set(itemNumber, 'Policy Violation'); return 'Policy Violation';
        }
        const doc = await fetchDoc('https://www.ebay.com/itm/' + itemNumber);
        let name = '';
        if (doc) name = parseSellerFromItemPage(doc);
        researchSellerCache.set(itemNumber, name || 'Unknown');
        return name || 'Unknown';
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

    function ensureCheckboxes() {
        try { PAG_BOTTOM = findPaginationBottom(); } catch (e) { PAG_BOTTOM = Infinity; }
        maybeUpgradeMode();

        // Pause the observer while we inject our own DOM nodes, otherwise
        // every checkbox we append triggers another observer tick → feedback
        // loop that pegs the CPU on pages that mutate constantly (eBay).
        let wasObserving = false;
        try {
            if (window.__uec_obs) { window.__uec_obs.disconnect(); wasObserving = true; }
        } catch (e) {}

        const nodes = CFG.findCards
            ? CFG.findCards()
            : Array.from(document.querySelectorAll(CFG.cardSelector || ''));
        nodes.forEach(card => {
            try {
                // Skip processed cards fast — do NOT re-examine or re-extract.
                // If a user ticks one that was extracted before its DOM was
                // fully ready, the change handler re-runs extract() at click
                // time (see below), which catches the lazy-loaded data.
                if (card.dataset.uecCard) return;
                if (!isCardEligible(card)) return;
                // Mark FIRST so any slowness / throw can't make us re-process
                // this card on the next tick.
                card.dataset.uecCard = '1';

                if (MODE === 'ebay-research') {
                    decorateResearchRow(card);
                    card._uecData = extract(card);
                    return;
                }
                try {
                    const cs = getComputedStyle(card);
                    if (cs && cs.position === 'static') card.style.position = 'relative';
                } catch (e) { /* detached node during re-render */ }
                const data = extract(card);
                card._uecData = data;
                const input = h('input', { type: 'checkbox' });
                let persistedId = keyFor(data);
                if (state.selectedIds.has(persistedId)) input.checked = true;
                input.addEventListener('click', e => e.stopPropagation());
                input.addEventListener('change', () => {
                    try {
                        if (input.checked) {
                            const fresh = extract(card); card._uecData = fresh;
                            persistedId = rememberSelection(keyFor(fresh), fresh);
                        } else {
                            forgetSelection(persistedId);
                        }
                        state.autoMode = 'manual'; saveState(); updateCount();
                    } catch (e) { console.warn('[uec] change handler threw:', e); }
                });
                const wrap = h('div', { class: 'uec-listing-check', title: data.title || '' }, input);
                wrap.addEventListener('click', e => {
                    if (e.target === wrap) {
                        e.preventDefault(); e.stopPropagation();
                        input.checked = !input.checked;
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                card.appendChild(wrap);
                if (data.country) card.appendChild(h('div', { class: 'uec-ship-badge' }, data.country));
            } catch (err) {
                console.warn('[uec] ensureCheckboxes per-card error:', err, card);
            }
        });
        // Re-attach observer if we paused it.
        try {
            if (wasObserving && window.__uec_obs) {
                window.__uec_obs.observe(document.body, { childList: true, subtree: true });
            }
        } catch (e) {}
        rebuildCountryBox(); applyFilters();
        if (state.autoMode === 'query' && state.query) applyQuerySelection();
        updateCount();
    }

    // ── Enrichment engine (same as userscript, uses bgFetch) ──────────
    function mapLimit(arr, limit, worker) {
        return new Promise(resolve => {
            const out = new Array(arr.length); let i = 0, active = 0, done = 0;
            if (!arr.length) return resolve(out);
            const next = () => {
                while (active < limit && i < arr.length) {
                    const idx = i++; active++;
                    Promise.resolve(worker(arr[idx], idx))
                        .then(v => out[idx] = v).catch(() => out[idx] = null)
                        .finally(() => { active--; done++; if (done === arr.length) resolve(out); else next(); });
                }
            };
            next();
        });
    }
    function parseEbayItemPage(doc) {
        const out = { available:'', sold:'', condition:'', handlingTime:'', returns:'', sellerFeedbackScore:'', sellerPositivePct:'' };
        if (!doc) return out;
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
            if (alt) { const m = (alt.textContent || '').match(/([\d,]+)/); if (m) out.sold = m[1].replace(/,/g, ''); }
        }
        const condEl = doc.querySelector('.x-item-condition-text, .d-item-condition-text, .ux-labels-values__values .ux-textspans, [data-testid="ux-item-condition"]');
        if (condEl) { const t = textOf(condEl).split('.')[0].trim(); if (t && t.length < 120) out.condition = t; }
        const shipBlock = doc.querySelector('.d-shipping-minview, .ux-layout-section__row .ux-labels-values--shipping, .vi-shipping');
        if (shipBlock) {
            const t = textOf(shipBlock);
            const m = t.match(/dispatched within\s+([^.]+)/i) || t.match(/handling time\s*[:-]?\s*([^.]+)/i);
            if (m) out.handlingTime = m[1].trim().slice(0, 80);
        }
        const retBlock = doc.querySelector('.ux-layout-section__row .ux-labels-values--returns, .d-returns, [data-testid="returns"]');
        if (retBlock) { const t = textOf(retBlock).replace(/\s+/g, ' ').trim(); out.returns = t.length > 160 ? t.slice(0, 157) + '\u2026' : t; }
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
    function parseEtsyListingPage(doc) {
        const out = { favorites:'', tags:'', materials:'', country:'' };
        if (!doc) return out;
        const favBtn = doc.querySelector('button[data-favorites-count], [data-favorites-count]');
        if (favBtn) out.favorites = (favBtn.getAttribute('data-favorites-count') || '').trim();
        if (!out.favorites) {
            const likesText = Array.from(doc.querySelectorAll('span, a, button')).map(n => textOf(n))
                .find(t => /^\d[\d,]*\s+favorites?$/i.test(t));
            if (likesText) out.favorites = (likesText.match(/\d[\d,]*/) || [''])[0].replace(/,/g, '');
        }
        const tagNodes = doc.querySelectorAll('a[href*="/market/"], a[href*="/search?q="][data-tag]');
        if (tagNodes.length) {
            const tags = Array.from(tagNodes).map(a => textOf(a)).filter(Boolean);
            out.tags = Array.from(new Set(tags)).slice(0, 20).join(', ');
        }
        Array.from(doc.querySelectorAll('li, p, div')).forEach(li => {
            const t = textOf(li);
            if (!out.materials && /^Materials?:\s+/i.test(t))   out.materials = t.replace(/^Materials?:\s+/i, '').slice(0, 200);
            if (!out.country   && /^Ships from:?\s+/i.test(t))  out.country   = t.replace(/^Ships from:?\s+/i, '').slice(0, 80);
        });
        return out;
    }
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
        const out = { shopSales:'', shopRating:'', shopReviews:'', shopAdmirers:'', shopLocation:'' };
        if (doc) {
            const body = textOf(doc.body);
            let m = body.match(/([\d,]+)\s+sales?\b/i);      if (m) out.shopSales = m[1].replace(/,/g, '');
            m = body.match(/([\d.]+)\s+out of 5\s+stars?/i); if (m) out.shopRating = m[1];
            m = body.match(/\(([\d,]+)\s*reviews?\)/i);      if (m) out.shopReviews = m[1].replace(/,/g, '');
            m = body.match(/([\d,]+)\s+admirers?/i);         if (m) out.shopAdmirers = m[1].replace(/,/g, '');
            const locEl = doc.querySelector('[data-shop-location], .shop-home-header-info span');
            if (locEl) { const t = textOf(locEl); if (t && t.length < 100) out.shopLocation = t; }
        }
        etsyShopCache.set(shopUrl, out);
        return out;
    }
    async function enrichOne(item) {
        if (!item || item.__enriched) return item;
        try {
            if (SITE === 'ebay') {
                const target = item.url || (item.itemNumber ? 'https://www.ebay.com/itm/' + item.itemNumber : '');
                if (target) Object.assign(item, parseEbayItemPage(await fetchDoc(target)));
            } else if (SITE === 'etsy') {
                if (item.url) {
                    const extra = parseEtsyListingPage(await fetchDoc(item.url));
                    if (!item.country && extra.country) item.country = extra.country;
                    delete extra.country;
                    Object.assign(item, extra);
                }
                if (item.seller) Object.assign(item, await fetchEtsyShop(shopUrlFromListingUrl(item.url, item.seller)));
            }
        } catch (e) {}
        item.__enriched = true;
        const id = item.itemNumber || item.url || '';
        if (id) { state.cache[id] = item; saveState(); }
        return item;
    }
    async function enrichMany(items, onProgress) {
        let done = 0;
        await mapLimit(items, 3, async it => {
            await enrichOne(it); done++; if (onProgress) onProgress(done, items.length, it);
        });
        return items;
    }

    function selectedRowsAllPages() {
        const rows = []; for (const id of state.selectedIds) { const d = state.cache[id]; if (d) rows.push(d); } return rows;
    }
    function uniqueBy(arr, keyFn) {
        const seen = new Set(); const out = [];
        for (const x of arr) { const k = keyFn(x); if (k && seen.has(k)) continue; if (k) seen.add(k); out.push(x); }
        return out;
    }

    // ── Copy Table / IDs / Seller+Item / URLs ──────────────────────────
    function cellsForRow(f) {
        const titleClean = (f.title || '').replace(/\s*Opens in a new window or tab\s*$/i, '');
        const imgHtml = f.image ? `<img src="${f.image}" width="100" style="max-height:190px;object-fit:contain;">` : '[No Image]';
        return { titleClean, imgHtml };
    }
    function columnsForMode() {
        const imgFor = f => cellsForRow(f).imgHtml;
        const today = () => new Date().toLocaleDateString('en-US');
        switch (MODE) {
            case 'ebay-research': return [
                ['Seller', f => f.seller], ['Item #', f => f.itemNumber], ['Title', f => cellsForRow(f).titleClean],
                ['URL', f => f.url], ['Avg Price', f => f.avgPrice], ['Avg Shipping', f => f.avgShipping],
                ['Total Sold', f => f.totalSold], ['Sales', f => f.sales], ['Last Sold', f => f.lastSold],
                ['Condition', f => f.condition], ['Feedback', f => f.sellerFeedbackScore], ['Positive %', f => f.sellerPositivePct],
                ['Image', f => imgFor(f)]
            ];
            case 'ebay-search': case 'ebay-store': return [
                ['Seller', f => f.seller], ['Feedback', f => f.sellerFeedbackScore], ['Positive %', f => f.sellerPositivePct],
                ['Item #', f => f.itemNumber], ['Title', f => cellsForRow(f).titleClean], ['URL', f => f.url],
                ['Price', f => f.price], ['Available', f => f.available], ['Sold', f => f.sold],
                ['Condition', f => f.condition], ['Handling', f => f.handlingTime], ['Returns', f => f.returns],
                ['Ships From', f => f.country], ['Image', f => imgFor(f)], ['Date', f => today()]
            ];
            case 'fb-ads': return [
                ['Status', f => f.fbStatus], ['Library ID', f => f.libraryId],
                ['Page', f => f.page], ['Page URL', f => f.pageUrl],
                ['Platforms', f => f.platforms], ['Start', f => f.startDate],
                ['End', f => f.endDate], ['Total Active', f => f.totalActiveTime],
                ['Ad Text', f => (f.adText || '').slice(0, 1000)],
                ['CTA Text', f => f.adLinkText], ['CTA URL', f => f.adLinkUrl],
                ['Ad URL', f => f.url], ['Video URL', f => f.videoUrl],
                ['Image', f => imgFor(f)], ['Date', f => today()]
            ];
            case 'fb-posts': return [
                ['Poster', f => f.page], ['Poster URL', f => f.pageUrl],
                ['Sponsored', f => f.isSponsored], ['Posted', f => f.postTime],
                ['Text', f => (f.adText || '').slice(0, 1000)],
                ['Permalink', f => f.url],
                ['CTA Text', f => f.adLinkText], ['CTA URL', f => f.adLinkUrl],
                ['Reactions', f => f.reactions], ['Comments', f => f.comments], ['Shares', f => f.shares],
                ['Video URL', f => f.videoUrl], ['Image', f => imgFor(f)],
                ['Date Captured', f => today()]
            ];
            default: return [
                ['Seller', f => f.seller], ['Owner', f => f.owner], ['Account Age', f => f.accountAge],
                ['Shop Sales', f => f.shopSales || f.totalSales], ['Shop Rating', f => f.shopRating],
                ['Reviews', f => f.shopReviews], ['Admirers', f => f.shopAdmirers], ['Shop Location', f => f.shopLocation],
                ['Listing #', f => f.itemNumber], ['Title', f => cellsForRow(f).titleClean], ['URL', f => f.url],
                ['Price', f => f.price], ['Favorites', f => f.favorites], ['Tags', f => f.tags],
                ['Materials', f => f.materials], ['Ships From', f => f.country],
                ['Image', f => imgFor(f)], ['Date', f => today()]
            ];
        }
    }
    function copyHtml(html, successMsg) {
        const holder = h('div', { contenteditable: 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
        holder.innerHTML = html; document.body.appendChild(holder);
        const range = document.createRange(); range.selectNodeContents(holder);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
        sel.removeAllRanges(); holder.remove();
        if (ok) return setStatus(successMsg || 'Copied.');
        if (navigator.clipboard && window.ClipboardItem) {
            navigator.clipboard.write([new ClipboardItem({
                'text/html':  new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([html], { type: 'text/plain' })
            })]).then(() => setStatus(successMsg || 'Copied.')).catch(() => setStatus('Copy failed.'));
        } else setStatus('Copy failed.');
    }
    copyTableBtn.addEventListener('click', () => {
        const rows = uniqueBy(selectedRowsAllPages(), r => r.itemNumber || r.url || '');
        if (!rows.length) return setStatus('No items selected.');
        const H = 210;
        const cols = columnsForMode();
        let html = '<table border="1" style="border-collapse:collapse;table-layout:fixed;width:100%;font-family:Arial;font-size:12px;">';
        html += '<tr>' + cols.map(c => `<th style="padding:5px;font-weight:bold;">${c[0]}</th>`).join('') + '</tr>';
        rows.forEach(f => {
            html += `<tr height="${H}" style="height:${H}px;">` +
                cols.map(([hdr, fn]) => {
                    const v = fn(f);
                    const style = hdr === 'URL'
                        ? 'padding:5px;vertical-align:top;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
                        : 'padding:5px;vertical-align:top;';
                    return `<td style="${style}"${hdr === 'URL' ? ' nowrap' : ''}>${v == null ? '' : v}</td>`;
                }).join('') + '</tr>';
        });
        html += '</table>';
        copyHtml(html, `Copied ${rows.length} item(s).`);
    });
    copyIdsBtn.addEventListener('click', () => {
        const ids = Array.from(new Set(selectedRowsAllPages().map(r => r.itemNumber).filter(Boolean)));
        if (!ids.length) return setStatus('No item numbers in selection.');
        navigator.clipboard.writeText(ids.join('\n')).then(() => setStatus(`Copied ${ids.length} ID(s).`)).catch(() => setStatus('Copy failed.'));
    });
    copySellerBtn.addEventListener('click', () => {
        const seen = new Set(); const out = [];
        for (const f of selectedRowsAllPages()) {
            const id = f.itemNumber || ''; if (id && seen.has(id)) continue; if (id) seen.add(id);
            out.push((f.seller || '') + '\t' + id);
        }
        if (!out.length) return setStatus('Nothing to copy.');
        navigator.clipboard.writeText(out.join('\n')).then(() => setStatus(`Copied ${out.length} seller/item rows.`)).catch(() => setStatus('Copy failed.'));
    });
    copyUrlsBtn.addEventListener('click', () => {
        const urls = Array.from(new Set(selectedRowsAllPages().map(r => r.url).filter(u => u && /^https?:/i.test(u))));
        if (!urls.length) return setStatus('No URLs to copy.');
        navigator.clipboard.writeText(urls.join('\n')).then(() => setStatus(`Copied ${urls.length} URL(s).`)).catch(() => setStatus('Copy failed.'));
    });
    enrichBtn.addEventListener('click', async () => {
        const items = uniqueBy(selectedRowsAllPages(), r => r.itemNumber || r.url || '');
        if (!items.length) { setStatus('Nothing selected to enrich.'); return; }
        enrichBtn.disabled = true;
        setStatus(`Enriching ${items.length} selection(s)\u2026`);
        await enrichMany(items, (done, total, it) => setStatus(`Enriched ${done}/${total}: ${trunc(it.title)}`));
        setStatus(`Done. Enriched ${items.length}. Run Copy Table or Save to see extras.`);
        enrichBtn.disabled = false;
    });

    // ── Save flow — goes to the background worker (Sheets+Drive APIs) ─
    saveBtn.addEventListener('click', async () => {
        const items = uniqueBy(selectedRowsAllPages(), r => r.itemNumber || r.url || '');
        if (!items.length) { setStatus('Nothing selected yet — tick some listings first.'); return; }
        saveBtn.disabled = true;
        setStatus(`Sending ${items.length} listing(s) to Google\u2026`);
        log(`Starting upload of ${items.length} listing(s).`);
        if (enrichToggle.checked) {
            setStatus('Enriching selections\u2026');
            await enrichMany(items, (done, total, it) => setStatus(`Enriched ${done}/${total}: ${trunc(it.title)}`));
        }
        let ok = 0, dup = 0, fail = 0;
        for (const item of items) {
            const res = await new Promise(resolve => {
                api.runtime.sendMessage({
                    type: 'save-listing', mode: MODE, site: SITE, listing: item, pageUrl: location.href
                }, reply => resolve(reply || { status: 'error', message: 'No reply from background' }));
            });
            if (res.status === 'added')          { ok++;  log(`\u2713 Added: ${trunc(item.title)}`, 'ok'); }
            else if (res.status === 'duplicate') { dup++; log(`= Duplicate skipped: ${trunc(item.title)}`, 'warn'); }
            else                                 { fail++; log(`\u2717 ${res.message || 'Error'}: ${trunc(item.title)}`, 'err'); }
            setStatus(`Added ${ok} \u00b7 Duplicates ${dup} \u00b7 Errors ${fail} / ${items.length}`);
        }
        setStatus(`Done. Added ${ok}, duplicates ${dup}, errors ${fail}.`);
        saveBtn.disabled = false;
    });

    // ── Read target sheet from extension storage; keep targetBox fresh ─
    async function refreshTarget() {
        try {
            const cfg = await new Promise(r => api.storage.local.get(['sheet', 'folder', 'signedIn'], r));
            if (!cfg.signedIn) {
                targetBox.innerHTML = 'Not signed in. <a href="#" id="uec-open-opts">Open settings</a> to connect Google.';
            } else if (!cfg.sheet || !cfg.folder) {
                targetBox.innerHTML = 'Sign-in OK. <a href="#" id="uec-open-opts">Pick a Sheet and Drive folder</a>.';
            } else {
                targetBox.innerHTML = 'Saving to <b>' + (cfg.sheet.name || 'sheet') + '</b> &middot; images in <b>' +
                    (cfg.folder.name || 'folder') + '</b>. <a href="#" id="uec-open-opts">Change</a>';
            }
            const a = document.getElementById('uec-open-opts');
            if (a) a.addEventListener('click', e => {
                e.preventDefault();
                // Safari Web Extensions often ignore runtime.openOptionsPage().
                // Open the options page as a new tab using the extension's
                // own URL — works in Safari, Chrome, Firefox, Edge.
                try {
                    const optsUrl = (api.runtime.getURL ? api.runtime.getURL('ui/options.html') : '');
                    if (optsUrl) window.open(optsUrl, '_blank');
                    else api.runtime.sendMessage({ type: 'open-options' });
                } catch (err) {
                    api.runtime.sendMessage({ type: 'open-options' });
                }
            });
        } catch (e) {
            targetBox.textContent = 'Settings unavailable in this context.';
        }
    }
    refreshTarget();
    if (api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener(refreshTarget);
    }

    // ── Observer + initial render ─────────────────────────────────────
    // Debounce mutations aggressively. eBay fires dozens per second (lazy
    // images, watcher counts, ad refresh) and running the extractor for
    // each is what hung Safari. We only care about DOM changes that might
    // have added a new card, so we also filter the mutations cheaply.
    let moTimer = null;
    const DEBOUNCE_MS = 600;
    const cardSel = CFG.cardSelector || '';
    function shouldRescan(mutations) {
        // If any mutation added nodes and one of them looks like it could
        // contain a new card, schedule a rescan.
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                // Ignore nodes we ourselves added (checkbox wraps / badges).
                if (n.classList && (n.classList.contains('uec-listing-check') || n.classList.contains('uec-ship-badge'))) continue;
                if (cardSel && (n.matches && n.matches(cardSel) || n.querySelector && n.querySelector(cardSel))) return true;
                if (CFG.findCards) return true; // FB climb-up path; can't cheaply pre-filter.
            }
        }
        return false;
    }
    window.__uec_obs = new MutationObserver(mutations => {
        if (!shouldRescan(mutations)) return;
        if (moTimer) clearTimeout(moTimer);
        moTimer = setTimeout(() => { moTimer = null; ensureCheckboxes(); }, DEBOUNCE_MS);
    });
    window.__uec_obs.observe(document.body, { childList: true, subtree: true });
    ensureCheckboxes(); updateCount();

    // Expose a small debug helper. In Safari's Web Inspector console on
    // the eBay/Etsy tab, run:   __uec_debug()
    // to see what the extractor is getting for every card — helpful when
    // counters misbehave.
    window.__uec_debug = function () {
        const rows = Array.from(document.querySelectorAll('[data-uec-card]')).map(c => {
            const d = c._uecData || {};
            return {
                mode: MODE,
                itemNumber: d.itemNumber || '(none)',
                url: (d.url || '').slice(0, 80),
                title: (d.title || '').slice(0, 60),
                seller: d.seller || '',
                country: d.country || '',
                hasImage: !!d.image,
                checked: !!(c.querySelector('.uec-listing-check input') && c.querySelector('.uec-listing-check input').checked)
            };
        });
        console.table(rows);
        console.log('state.selectedIds:', Array.from(state.selectedIds));
        console.log('state.cache keys:', Object.keys(state.cache));
        return rows;
    };
})();
