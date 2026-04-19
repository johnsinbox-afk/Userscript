# Listing Collector

A tool for capturing listings from Etsy and eBay (search pages, stores, and eBay Seller Hub Research) into a Google Sheet, with the main listing images uploaded permanently to your Google Drive and embedded in the sheet via `=IMAGE()`.

Two independent implementations live in this repo:

## `extension/` — Safari Web Extension (recommended)

Proper extension with a settings UI, **"Sign in with Google"**, and pickers for the destination spreadsheet and Drive folder. No config to edit.

- Works in Safari on macOS and iOS (sideload to your own iPhone for free via Xcode).
- Also runs as a Chrome / Edge unpacked extension if you prefer.
- See [`docs/SAFARI_SETUP.md`](docs/SAFARI_SETUP.md) for click-by-click install instructions.
- See [`extension/README.md`](extension/README.md) for developer notes.

## `etsy-ebay-listing-collector.user.js` — Userscript (fallback)

Single-file userscript that you install via **Userscripts**, **Tampermonkey**, or **Violentmonkey**. It uses a Google Apps Script Web App as the save backend (you paste three IDs into the `CONFIG` block at the top of the file). Kept around for anyone who doesn't want to build an Xcode project.

## Feature matrix (both implementations)

| | Etsy search | eBay search | eBay store | eBay Research |
| --- | :---: | :---: | :---: | :---: |
| Floating overlay + toggle | ✓ | ✓ | ✓ | ✓ |
| Keyword filter (AND / OR / NOT / "phrase" / parens) | ✓ | ✓ | ✓ | ✓ |
| Country filter (auto-built) | ✓ | ✓ | – | – |
| Per-listing checkbox | ✓ | ✓ | ✓ | ✓ |
| Persistent selections across pagination | ✓ | ✓ | ✓ | ✓ |
| Copy Table / IDs / Seller+Item / URLs | ✓ | ✓ | ✓ | ✓ |
| Enrich item/shop pages | ✓ | ✓ | ✓ | ✓ (already fetches seller) |
| Save to Google Sheets (image in Drive) | ✓ | ✓ | ✓ | ✓ |
