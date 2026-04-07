# CG Suite Research – Chrome Extension

Skeleton for the research flow: open eBay or Cash Converters in a new tab, show a side panel on listing pages (“Have you got the data yet?”), and send scraped data back to the CG Suite app.

## Setup

1. Open Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `chrome-extension` folder in this repo.

## Flow

1. In the app, user clicks **Get data** on the eBay or Cash Converters research form.
2. The extension opens the corresponding site in a new tab.
3. User navigates to a page with multiple listings.
4. A panel appears from the right: **Have you got the data yet?** [Yes].
5. User clicks **Yes** → the content script scrapes the page (placeholder selectors) and sends the result to the app.
6. The research form shows the data in cards.

## Files

- **manifest.json** – Extension manifest (host permissions, content scripts, background).
- **background.js** – Tracks pending “wait for data” requests and routes scraped data back to the app tab.
- **content-bridge.js** – Injected on the app origin (e.g. localhost); forwards `EXTENSION_MESSAGE` / `EXTENSION_RESPONSE` between page and extension.
- **content-listings.js** – Injected on ebay.co.uk and cashconverters.co.uk; shows the side panel and runs the scraper (selectors are placeholders for now).

## App URL

Content script for the bridge runs on `localhost` and `127.0.0.1`. If the app is served from another origin, add it to `host_permissions` and to the `content_scripts[0].matches` entry in `manifest.json`.

## Selectors

Scraping in `content-listings.js` uses placeholder selectors. Replace them with the real eBay and Cash Converters DOM selectors when ready.
