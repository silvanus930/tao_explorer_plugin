# TAO Subnet Analytics

Chrome extension that adds **Burn Rate** and **Reg. Fee** columns to the [tao.app](https://www.tao.app/explorer) subnet explorer.

## Features

- Injects two analytics columns into the subnet table on `tao.app/explorer`
- Fetches live registration burn from Bittensor Finney RPC via selective metagraph
- Loads subnet data lazily for visible explorer rows to stay within RPC limits
- Caches results locally (default 10 minutes) to reduce RPC load
- **Google Sheets sync** — back up cache and restore it on another browser/machine
- Optionally enriches data from TAO.app API when an API key is configured
- Intercepts TAO.app subnet info responses when the page already loads them

## Columns

| Column | Source | Meaning |
| --- | --- | --- |
| **Burn Rate** | Metagraph scrape | Owner incentive (0–1) from subnet metagraph |
| **Reg. Fee** | On-chain burn | Current TAO cost for burned registration on that subnet |

## Install (development)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

## Configuration

Click the extension icon to open settings:

- **Cache refresh** — how often to refresh on-chain data (minutes)
- **TAO.app API enrichment** — optional; uses your API key for supplemental data and USD conversion

### TAO.app API key (optional)

```bash
# .env
API_KEY=your_tao_app_key
SHEET_URL=https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID
node scripts/sync-env.js
```

Reload the extension after running the script.

`sync-env.js` writes:
- `config/secrets.js` — API key (gitignored)
- `config/defaults.js` — **community sheet URL** (committed so other users get it by default)

### Maintainer vs community users

| Role | What to do |
|------|------------|
| **Maintainer** | Sync subnets locally → **Push to Sheets** (OAuth). Update `SHEET_URL` in `.env` and run `sync-env.js` if the sheet changes. |
| **Other users** | Install extension → open explorer. Community sheet URL is pre-filled; **Pull** or auto-download on load (public link, no sign-in). |

Share the sheet as **Anyone with the link → Viewer** so public pull works.

---

## Google Sheets sync (cross-browser cache)

Use **Google Sheets** (not Google Docs) to store subnet cache rows. When you open the explorer on a new browser, the extension can pull that data automatically.

### What you need from Google Cloud

1. **Google Cloud project** — [console.cloud.google.com](https://console.cloud.google.com)
2. **Google Sheets API enabled** — APIs & Services → Library → “Google Sheets API” → Enable
3. **OAuth consent screen** — configure as External (or Internal for Workspace), add your Google account as a test user while in testing mode
4. **OAuth 2.0 Client ID (Chrome extension)** — APIs & Services → Credentials → Create credentials → OAuth client ID → Application type: **Chrome extension**
5. **Extension ID** — copy from extension settings popup (or `chrome://extensions`) → paste into OAuth client **Application ID** (32 chars, no URL)
6. Copy the **Client ID** from that same credentials row (format `123456789-xxxx.apps.googleusercontent.com`) — this is **not** the Extension ID

### What you need in this project

Add to `.env`:

```bash
GOOGLE_OAUTH_CLIENT_ID=123456789-xxxx.apps.googleusercontent.com
```

Then run:

```bash
node scripts/sync-oauth.js
```

This writes the client ID into `manifest.json`. **Reload the extension** after running it.

### First-time setup in the extension

1. Open extension settings (toolbar icon)
2. Scroll to **Google Sheets sync**
3. Click **Create new spreadsheet** (sign in when Chrome prompts)
4. Enable **Google Sheets sync**
5. Save settings

Or paste an existing spreadsheet URL/ID if you already have one.

### Sync behaviour

| Action | What it does |
| --- | --- |
| **Pull from Sheets** | Downloads rows — **no sign-in** if sheet is shared as “Anyone with the link can view” |
| **Push to Sheets** | Uploads local cache — **requires Google sign-in** (OAuth) |
| **Sync** | Merge both ways, then write combined result to Sheets and local cache |
| **Auto-upload** | After local cache changes, uploads to Sheets after ~8 seconds |
| **Download on explorer open** | Pulls from Sheets when you open `tao.app/explorer` |
| **Sync button / Sync All** | Also pushes to Sheets after finishing (if a spreadsheet is configured) |

Sheet tab name: `TAO_Subnet_Cache`  
Columns: `netuid` | `payload` (JSON) | `updated_at`

### Pull without sign-in (another browser / account / PC)

No OAuth setup on other machines.

1. Install the extension (community sheet URL is in `config/defaults.js`)
2. Keep **Pull without sign-in** and **Download when explorer opens** enabled (default)
3. Click **Pull** or open `tao.app/explorer`

Do **not** use Push / Sync / Create on other PCs — maintainer only (needs OAuth).

The maintainer must share the sheet as **Anyone with the link → Viewer**.

### New browser / new machine

1. Install the extension (same folder or packaged build)
2. Run `node scripts/sync-oauth.js` with the same `GOOGLE_OAUTH_CLIENT_ID`
3. Open settings → paste the **same spreadsheet URL**
4. Enable sync → click **Pull from Sheets** (or open explorer with “Download on explorer open” enabled)
5. Sign in with the same Google account that owns/editor access to the sheet

### Troubleshooting: `bad client id`

Chrome shows this when the **Client ID** in `manifest.json` does not match a **Chrome extension** OAuth client registered with **this extension’s ID**.

1. Open extension settings and copy the **Extension ID** shown there (or from `chrome://extensions`).
2. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Credentials**:
   - Create (or edit) an OAuth client with type **Chrome extension** — not “Web application”.
   - Paste the Extension ID into **Application ID** (32 lowercase letters, no `https://`).
3. Copy that client’s **Client ID** into `.env` as `GOOGLE_OAUTH_CLIENT_ID=...`
4. Run `node scripts/sync-oauth.js` and **reload** the extension.
5. On the OAuth consent screen, add your Google account as a **test user** if the app is still in Testing mode.

No client secret is required for Chrome extensions.

---

## Project structure

```
manifest.json           Extension manifest (MV3)
background/             Service worker, caching, RPC orchestration
api/                    Bittensor RPC, SCALE decoder, TAO.app, Google Sheets
content/                Explorer DOM integration + page fetch hook
storage/                Chrome storage helpers
options/                Settings popup
styles/                 Injected column styles
scripts/                sync-env.js, sync-oauth.js
icons/                  Extension icons
```

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Cache subnet metrics and save settings |
| `alarms` | Background refresh on a schedule |
| `identity` | Google OAuth sign-in for Sheets sync |
| `tao.app` | Inject columns into the explorer |
| `api.tao.app` | Optional API enrichment + response capture |
| `entrypoint-finney.opentensor.ai` | Read on-chain subnet registration data |
| `googleapis.com` / `sheets.googleapis.com` | Google Sheets sync |

## Development notes

- Registration burn is read via `subnetInfo_getSelectiveMetagraph` (burn index) on Finney RPC.
- Burn rate still requires metagraph tab scraping (owner incentive).
- Burn values are stored in RAO on-chain (1 TAO = 1e9 RAO).

## License

Prototype extension for Bittensor subnet analytics. Use at your own discretion.
