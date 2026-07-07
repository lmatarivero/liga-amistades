// Cloudflare Pages Function — league data store backed by Workers KV.
//
// Bind a KV namespace named LIGA_KV (Pages → Settings → Functions → KV bindings,
// or via wrangler.toml). Endpoints:
//   GET  /api/data                 → latest saved league JSON (edge-cached ~20s)
//   GET  /api/data?prev=1          → previous snapshot (1-step undo)
//   GET  /api/data?list=1          → array of available daily-backup dates (newest first)
//   GET  /api/data?backup=YYYY-MM-DD → that day's snapshot
//   GET  /api/data?safe=1          → last saved state that had games (recovery)
//   POST /api/data                 → save JSON; keeps a 1-step backup (data_previous),
//                                    a first-of-day snapshot (backup:DATE) and safe_last_games.
//
// Writes are intentionally open (no auth) to match the app's prior behavior.
//
// KV free-tier friendliness: the hot GET path is served from the edge Cache API
// (caches.default) for a short TTL so repeated viewer polls don't each hit KV.
// POST purges that cache and minimizes writes (daily snapshot only once per day).

const KEY = 'data';
const PREV = 'data_previous';
const SAFE_KEY = 'safe_last_games';
const BACKUP_PREFIX = 'backup:';
const KEEP_DAYS = 30;
const DATA_TTL = 20; // seconds the main GET is cached at the edge

const CORS = { 'Access-Control-Allow-Origin': '*' };
const NOSTORE_HEADERS = { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'no-store' };
const CACHED_HEADERS = { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': `public, max-age=${DATA_TTL}` };

function json(body, status = 200) {
  return new Response(body, { status, headers: NOSTORE_HEADERS });
}

// Stable cache key for the main data GET (URL-only, no client headers/query).
function dataCacheKey(request) {
  return new Request(new URL('/api/data', request.url).toString(), { method: 'GET' });
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

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);

  // Backup/utility reads — never cached.
  if (url.searchParams.get('list')) {
    const res = await env.LIGA_KV.list({ prefix: BACKUP_PREFIX });
    const dates = res.keys.map(k => k.name.slice(BACKUP_PREFIX.length)).sort().reverse();
    return json(JSON.stringify(dates));
  }
  if (url.searchParams.get('safe')) {
    return json((await env.LIGA_KV.get(SAFE_KEY)) ?? 'null');
  }
  const backup = url.searchParams.get('backup');
  if (backup) return json((await env.LIGA_KV.get(BACKUP_PREFIX + backup)) ?? 'null');
  if (url.searchParams.get('prev')) return json((await env.LIGA_KV.get(PREV)) ?? 'null');

  // Main data — served from the edge cache when possible to spare KV reads.
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const cacheKey = dataCacheKey(request);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const val = await env.LIGA_KV.get(KEY);
  const resp = new Response(val ?? 'null', { headers: CACHED_HEADERS });
  if (cache && waitUntil) waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
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

  // Daily snapshot: write ONCE per day (first save) to save KV writes. The prune
  // (a list + deletes) also runs only when a new day is added.
  const dayKey = BACKUP_PREFIX + dateKeyFromSavedAt(parsed && parsed.savedAt);
  const dayExists = await env.LIGA_KV.get(dayKey);
  if (!dayExists) {
    await env.LIGA_KV.put(dayKey, body);
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
  }

  // Safety net: retain the most recent state that actually HAD games. An empty
  // games array (accidental wipe or a fresh reset) never overwrites this.
  if (parsed && Array.isArray(parsed.games) && parsed.games.length > 0) {
    await env.LIGA_KV.put(SAFE_KEY, body);
  }

  // Invalidate the edge-cached GET so viewers see the update on their next poll.
  if (typeof caches !== 'undefined' && waitUntil) {
    waitUntil(caches.default.delete(dataCacheKey(request)));
  }

  return json(JSON.stringify({ ok: true }));
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      ...NOSTORE_HEADERS,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
