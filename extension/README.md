# Listing Collector — Safari Web Extension

This is the companion Safari Web Extension to the `../etsy-ebay-listing-collector.user.js` userscript.

It does everything the userscript does (overlay, filters, enrichment, copy-table, save-to-sheets) but with a proper **Sign in with Google** flow, a **picker UI** for choosing a Google Sheet and a Drive folder, and no need to edit any configuration in the source.

## Files

- `manifest.json` — Manifest V3, declares content script + background service worker + options page + popup.
- `content.js` — the in-page overlay / checkbox / enrichment logic.
- `content.css` — styles scoped with the `uec-` prefix.
- `background.js` — OAuth, Drive upload, Sheets append, dedupe. All Google API calls live here.
- `ui/options.html`, `ui/options.js`, `ui/ui.css` — settings page with Sign-in, pickers, test button.
- `ui/popup.html`, `ui/popup.js` — tiny toolbar popup showing current target.
- `icons/` — placeholder PNGs; replace with real artwork before publishing anywhere.

## Install

- **Safari** (personal iPhone + Mac, free): follow [`docs/SAFARI_SETUP.md`](../docs/SAFARI_SETUP.md) click-by-click.
- **Chrome / Edge** (for quick testing): `chrome://extensions` → Developer mode → **Load unpacked** → point it at this folder. Then open **Options** and paste your OAuth client ID.

## How it talks to Google

OAuth 2.0 implicit flow via `chrome.identity.launchWebAuthFlow`. No refresh tokens are stored (implicit flow doesn't provide them); the access token is cached until it expires, at which point the first API call triggers a silent re-auth popup if you're still signed in to Google.

Scopes requested:

- `drive.file` — create/manage files the extension itself uploads (listing images).
- `drive.metadata.readonly` — list your spreadsheets and folders for the pickers.
- `spreadsheets` — append listing rows to the chosen sheet.

## Data model

Per-mode sheet tab schema lives at the top of `background.js` in the `SCHEMA` object. Each mode (Etsy, eBay search, eBay store, eBay Seller Hub Research) writes to its own tab with mode-appropriate columns. New fields added to the content-script extractors only need the schema updated here to land in the sheet.

## Swapping OAuth client IDs

The client ID is stored in `chrome.storage.local` (via the Settings page), with a fallback to `manifest.json`'s `oauth2.client_id`. You don't need to rebuild the extension to use a different Google project — just change it in Settings.
