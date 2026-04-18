# Etsy & eBay Listing Collector (Safari Userscript)

A floating overlay for Etsy and eBay search pages that lets you tick listings
and push them into a Google Sheet — with the main image permanently hosted in
your Google Drive and embedded in the sheet via `=IMAGE()`.

## Features
- Floating toggle + collapsible panel (mobile friendly)
- Keyword filter
- Multi-country checkbox filter
- Per-listing checkboxes injected on every Etsy/eBay search card
- "Save Selected to Google Sheets" button
- Uploads the main listing image to Google Drive (so it never 404s in the sheet)
- De-duplicates by listing URL

## Install
1. Open `etsy-ebay-listing-collector.user.js`.
2. Follow the **SETUP INSTRUCTIONS** comment block at the top of the file:
   - Create a Google Sheet, copy its ID.
   - Create a Drive folder, copy its ID.
   - Paste the Apps Script found at the bottom of the userscript into a new
     Apps Script project bound to the sheet, deploy it as a Web App, copy the
     `/exec` URL.
   - Fill the three values in the `CONFIG` block.
3. Install the script in Safari via the **Userscripts** extension or
   **Tampermonkey**.
4. Visit an Etsy or eBay search page — a round **List** button appears in the
   bottom-right corner.
