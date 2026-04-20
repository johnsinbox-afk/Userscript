# Listing Collector

A tool for capturing listings and content from Etsy, eBay (search / stores / Seller Hub Research), and Facebook (Ad Library / feed) into a Google Sheet, with the main image uploaded permanently to your Google Drive and embedded in the sheet via `=IMAGE()`.

Two independent implementations live in this repo:

## `extension/` — Safari Web Extension (recommended)

Proper extension with a settings UI, **"Sign in with Google"**, and pickers for the destination spreadsheet and Drive folder. No config to edit.

- Works in Safari on macOS and iOS (sideload to your own iPhone for free via Xcode).
- Also runs as a Chrome / Edge unpacked extension if you prefer.
- See `[docs/SAFARI_SETUP.md](docs/SAFARI_SETUP.md)` for click-by-click install instructions.
- See `[extension/README.md](extension/README.md)` for developer notes.

## `etsy-ebay-listing-collector.user.js` — Userscript (fallback)

Single-file userscript that you install via **Userscripts**, **Tampermonkey**, or **Violentmonkey**. It uses a Google Apps Script Web App as the save backend (you paste three IDs into the `CONFIG` block at the top of the file). Kept around for anyone who doesn't want to build an Xcode project.

## Feature matrix


|                                           | Etsy search | eBay search | eBay store | eBay Research | FB Ad Library | FB feed/posts |
| ----------------------------------------- | ----------- | ----------- | ---------- | ------------- | ------------- | ------------- |
| Floating overlay + toggle                 | ✓           | ✓           | ✓          | ✓             | ✓ (ext)       | ✓ (ext)       |
| Keyword filter (AND/OR/NOT/phrase/parens) | ✓           | ✓           | ✓          | ✓             | ✓ (ext)       | ✓ (ext)       |
| Country filter                            | ✓           | ✓           | –          | –             | –             | –             |
| Per-card checkbox                         | ✓           | ✓           | ✓          | ✓             | ✓ (ext)       | ✓ (ext)       |
| Persistent selections                     | ✓           | ✓           | ✓          | ✓             | ✓ (ext)       | ✓ (ext)       |
| Copy Table / IDs / Seller+Item / URLs     | ✓           | ✓           | ✓          | ✓             | ✓ (ext)       | ✓ (ext)       |
| Enrich item/shop pages                    | ✓           | ✓           | ✓          | ✓             | –             | –             |
| Save to Google Sheets + Drive image       | ✓           | ✓           | ✓          | ✓             | ✓ (ext)       | ✓ (ext)       |


*"(ext)" = in the Safari Web Extension only. The userscript focuses on Etsy/eBay; Facebook support lives in the extension.*