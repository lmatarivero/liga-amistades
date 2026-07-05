// Cloudflare Pages Function — league data store backed by Workers KV.
//
// Bind a KV namespace named LIGA_KV (Pages → Settings → Functions → KV bindings,
// or via wrangler.toml). Endpoints:
//   GET  /api/data                 → latest saved league JSON (or the string "null")
//   GET  /api/data?prev=1          → previous snapshot (1-step undo)
//   GET  /api/data?list=1          → array of available daily-backup dates (newest first)
//   GET  /api/data?backup=YYYY-MM-DD → that day's snapshot
//   POST /api/data                 → save JSON; also keeps a rolling 1-step backup
//                                    (data_previous) and a daily snapshot (backup:DATE).
//
// Writes are intentionally open (no auth) to match the app's prior behavior.

const KEY = 'data';
const PREV = 'data_previous';
const SAFE_KEY = 'safe_last_games';
const BACKUP_PREFIX = 'backup:';
const KEEP_DAYS = 30;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function json(body, status = 200) {
  return new Response(body, { status, headers: JSON_HEADERS });
}

// "2026-07-05T16:51:08.591Z" → "2026-07-05"; falls back to today (UTC).
function dateKeyFromSavedAt(savedAt) {
  if (typeof savedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(savedAt)) return savedAt.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// YYYY-MM-DD for `days` ago (UTC). Backup dates strictly older than this are pruned.
function cutoffDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('list')) {
    const res = await env.LIGA_KV.list({ prefix: BACKUP_PREFIX });
    const dates = res.keys.map(k => k.name.slice(BACKUP_PREFIX.length)).sort().reverse();
    return json(JSON.stringify(dates));
  }

  const backup = url.searchParams.get('backup');
  let key = KEY;
  if (url.searchParams.get('safe')) key = SAFE_KEY;
  else if (backup) key = BACKUP_PREFIX + backup;
  else if (url.searchParams.get('prev')) key = PREV;

  const val = await env.LIGA_KV.get(key);
  return json(val ?? 'null');
}

export async function onRequestPost({ request, env }) {
  let body, parsed;
  try {
    body = await request.text();
    parsed = JSON.parse(body); // validate it's JSON before storing
  } catch {
    return json(JSON.stringify({ error: 'invalid JSON' }), 400);
  }

  // Rolling 1-step backup: copy the current live value into the previous slot
  // before overwriting, so restorePreviousFromFirebase() always has an undo.
  const current = await env.LIGA_KV.get(KEY);
  if (current) await env.LIGA_KV.put(PREV, current);
  await env.LIGA_KV.put(KEY, body);

  // Daily snapshot: one per day, last save of the day wins.
  const dateKey = dateKeyFromSavedAt(parsed && parsed.savedAt);
  await env.LIGA_KV.put(BACKUP_PREFIX + dateKey, body);

  // Safety net: retain the most recent state that actually HAD games. An empty
  // games array (accidental wipe or a fresh reset) never overwrites this, so the
  // last good season is always recoverable via GET ?safe=1.
  if (parsed && Array.isArray(parsed.games) && parsed.games.length > 0) {
    await env.LIGA_KV.put(SAFE_KEY, body);
  }

  // Prune daily snapshots older than KEEP_DAYS (best-effort).
  try {
    const res = await env.LIGA_KV.list({ prefix: BACKUP_PREFIX });
    const cutoff = cutoffDate(KEEP_DAYS);
    await Promise.all(
      res.keys
        .filter(k => k.name.slice(BACKUP_PREFIX.length) < cutoff)
        .map(k => env.LIGA_KV.delete(k.name))
    );
  } catch (e) {
    // pruning is non-critical; ignore failures
  }

  return json(JSON.stringify({ ok: true }));
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      ...JSON_HEADERS,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
