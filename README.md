# VetClaim Chrome Extension

Sync your live VA.gov claim data with [VetClaim Services](https://vetclaimservices.com) for AI-powered claim insights.

## What it does

When you visit your [VA.gov claim status page](https://www.va.gov/claim-or-appeal-status), this extension automatically captures your claim data and syncs it to your VetClaim dashboard. This gives the AI assistant deeper visibility into:

- **Claim phase & progress** — where you are in the 8-phase VA process
- **Contentions** — your claimed conditions and their individual statuses
- **Timeline events** — phase changes, requests for evidence, decision dates
- **Flags** — documents needed, development letters, waivers

The extension **never modifies** anything on VA.gov. It only reads claim data that's already being loaded by the VA.gov website.

## Install

1. Download or clone this repo:
   ```
   git clone https://github.com/zhadyz/vetclaim-extension.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the `vetclaim-extension` folder
5. Log into [vetclaimservices.com](https://vetclaimservices.com)
6. Visit [VA.gov claim status](https://www.va.gov/claim-or-appeal-status) while logged into VA.gov

Your claims will sync automatically to your VetClaim dashboard.

## How it works

- `interceptor.js` — Intercepts VA.gov's own API calls (fetch requests to `/v0/benefits_claims/`) to capture claim data as it loads
- `content-script.js` — Injects the interceptor into VA.gov pages and relays captured data to the background script
- `background.js` — Receives claim data and sends it to the VetClaim API (`POST /v1/va-sync`)
- `popup.html` — Shows connection status and sync count

## Privacy

- Your VA.gov credentials are **never** accessed or stored by this extension
- Claim data is only sent to `api.vetclaimservices.com` — your own VetClaim account
- No data is shared with third parties
- You can uninstall the extension at any time — your synced data remains in your VetClaim account

## Requirements

- Google Chrome (or Chromium-based browser)
- A [VetClaim Services](https://vetclaimservices.com) account
- An active VA.gov account with claims

## License

MIT
