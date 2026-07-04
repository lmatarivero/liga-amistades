# Deploying Liga Amistades to Cloudflare Pages + Workers KV

The app is a single `index.html` plus one Pages Function (`functions/api/data.js`)
that reads/writes the whole league state as one JSON blob in **Workers KV**.
No Google Cloud / Firebase anymore. All free, no expiry, no idle-pausing.

## One-time setup

### 1. Create a free Cloudflare account
https://dash.cloudflare.com/sign-up

### 2. Install the CLI and log in
```bash
npm install -g wrangler
wrangler login
```

### 3. Create the KV namespace
```bash
wrangler kv namespace create LIGA_KV
```
Copy the printed `id` into `wrangler.toml` (replace `REPLACE_WITH_KV_NAMESPACE_ID`).

### 4. Connect the repo to Pages (auto-deploy on every push)
1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
4. After the first deploy, go to **Settings → Functions → KV namespace bindings**
   and add: variable name `LIGA_KV` → the namespace you created in step 3.
   (This is also declared in `wrangler.toml`; the dashboard binding is what the
   deployed site actually uses.)
5. Trigger a redeploy so the binding takes effect.

Every `git push` to the main branch now auto-deploys.

## Seed the current data (do this once)

New KV is empty, so load your latest league data into it:

1. Open the **current live app** and click **Exportar backup** to download a fresh
   `liga_amistades_backup_YYYY-MM-DD.json`.
2. POST it to the deployed API (replace the URL and filename):
   ```bash
   curl -X POST https://liga-amistades.pages.dev/api/data \
     -H "Content-Type: application/json" \
     --data-binary @liga_amistades_backup_2026-07-04.json
   ```
3. Reload the deployed site — standings, jornadas, playoffs should all appear.

## How it works

- `GET  /api/data`        → latest JSON            (client: `loadFromFirebase`)
- `GET  /api/data?prev=1` → previous snapshot      (client: `restorePreviousFromFirebase`)
- `POST /api/data`        → save; copies current → `data_previous` first (client: `saveToFirebase`)
- The browser polls `GET /api/data` every 20s and applies remote changes only when
  they are strictly newer than local — this replaces Firestore's realtime listener.

## Local development
```bash
wrangler pages dev .
```
Serves `index.html` + the Function with a local KV, at http://localhost:8788.

## Free-tier limits (you use a tiny fraction)
- 100,000 KV reads/day, 1,000 writes/day, 1 write/sec per key, 25 MB per value.
- Unlimited static requests + bandwidth on Pages.

## Rollback / undo
From the deployed site's DevTools console:
```js
window.restorePreviousFromFirebase()
```
Applies the last snapshot; re-save in the app to commit it.
