# Etsy & eBay Listing Collector (Safari Userscript)

A floating overlay for **Etsy search**, **eBay search**, **eBay stores**, and
**eBay Seller Hub Research** pages that lets you tick listings and either:

- copy them to your clipboard as a rich HTML table (with image thumbnails,
  ready to paste into Google Sheets / Excel / Word), **or**
- push them into a Google Sheet with the main image uploaded permanently to
  your Google Drive and embedded via `=IMAGE()`.

The script integrates the functionality of three bookmarklets you use today
into a single, well-organised, mobile-friendly userscript.

## Feature matrix

| Feature | Etsy search | eBay search | eBay store | eBay Research |
| --- | :---: | :---: | :---: | :---: |
| Floating overlay + toggle button | ✓ | ✓ | ✓ | ✓ |
| Keyword filter (AND / OR / NOT / "phrase" / parens) | ✓ | ✓ | ✓ | ✓ |
| Country filter (auto-built from page) | ✓ | ✓ | – | – |
| Per-listing checkbox | ✓ | ✓ | ✓ | ✓ |
| "Select all visible" / "Clear" | ✓ | ✓ | ✓ | ✓ |
| Persistent selections across pagination | ✓ | ✓ | ✓ | ✓ |
| Copy Table (HTML + images) | ✓ | ✓ | ✓ | ✓ |
| Copy IDs, Seller+Item, URLs | ✓ | ✓ | ✓ | ✓ |
| Save to Google Sheets (+ Drive image) | ✓ | ✓ | ✓ | ✓ |
| De-dupe on save | by URL | by URL | by URL | by URL |
| Seller name (async lookup) | from card | from card | from URL | from item page |
| Etsy shop-popover (owner / age / total sales) | ✓ | – | – | – |
| Ships-from badge on each card | ✓ | ✓ | – | – |
| Avg Price / Avg Ship / Sold / Sales / Last Sold | – | – | – | ✓ |
| Optional Available / Sold pre-fetch | – | ✓ | – | – |
| Excludes "Recommended for you" / carousels / below pagination | ✓ | ✓ | ✓ | – |

## What each mode reads from the page

- **Etsy search** (`MODES['etsy-search']`)
  - Card: `.v2-listing-card[data-listing-id]` inside `[data-search-results-container]`
  - Title: `h3 / h2 / a.listing-link / [data-listing-card-title]`
  - Price: `.currency-value, [data-listing-price]`
  - Seller: `span.clickable-shop-name[data-seller-name-link]` → `a[href*="/shop/"]` → `data-shop-name`
  - Listing ID: `/listing/<id>/` or `data-listing-id`
  - Ships from: any `span|p` containing "Ships from"
  - Owner / Account Age / Total Sales / fallback country: `button.shop-popover-tooltip[role=tooltip]`

- **eBay search** (`MODES['ebay-search']`)
  - Card: `.su-card-container`
  - Title: `.s-card__title`, Price: `.s-card__price`, Image: `img.s-card__image`
  - Seller: `.s-card__program-badge-container--sellerOrStoreInfo`, then secondary / tertiary `su-styled-text`, then `_ssn=` URL param
  - Item #: `li[data-listingid]` or `/itm/<id>/` or the "Item: …" secondary attribute
  - Country: `span.su-styled-text.secondary.large` containing "Located in"
  - Available / Sold (optional): parsed from `#qtyAvailability` on each item page

- **eBay store** (`MODES['ebay-store']`)
  - Card: `article.StoreFrontItemCard`, `article.str-item-card.StoreFrontItemCard`
  - Title: `.str-card-title .str-text-span` / `.str-item-card__property-title .str-text-span`
  - Price: `.str-item-card__property-displayPrice`
  - Image: `img[data-testid="str-img"], .str-image img, img.zoom`
  - Seller: `_ssn=` URL param or `/str/<seller>` in the path

- **eBay Seller Hub Research** (`MODES['ebay-research']`)
  - Row: `tr.research-table-row`; item id from `span[data-item-id]`
  - Seller: fetched from `https://www.ebay.com/itm/<id>` via `GM_xmlhttpRequest`, parsed out of `.x-vi-evo-cvip-container a.ux-call-to-action`, `.x-sellercard-atf__info__about-seller a`, or `a[href*="requested="]`; policy-violation rows are flagged
  - Metrics: `.research-table-row__avgSoldPrice`, `__avgShippingCost`, `__totalSoldCount`, `__totalSalesValue`, `__dateLastSold`

## Install

1. Open `etsy-ebay-listing-collector.user.js`.
2. Follow the **SETUP INSTRUCTIONS** comment block at the top:
   - Create a Google Sheet, copy its ID.
   - Create a Drive folder, copy its ID.
   - Paste the Apps Script shown at the bottom of the userscript into a new
     Apps Script project bound to the sheet, deploy it as a Web App, copy
     the `/exec` URL.
   - Fill in the three values in `CONFIG`.
3. Install the script in Safari via the **Userscripts** extension (or
   Tampermonkey / Violentmonkey).
4. Visit a supported page — a round **List** button appears bottom-right.

The Apps Script writes to one tab per mode (`Etsy`, `eBay Search`,
`eBay Store`, `eBay Research`), so the column layout can differ
appropriately and tabs are created automatically on first use.
