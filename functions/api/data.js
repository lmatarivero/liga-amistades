// Cloudflare Pages Function — league data store backed by Workers KV.
//
// Bind a KV namespace named LIGA_KV (Pages → Settings → Functions → KV bindings,
// or via wrangler.toml). Endpoints:
//   GET  /api/data          → latest saved league JSON (or the string "null")
//   GET  /api/data?prev=1   → previous snapshot, for 1-step undo
//   POST /api/data          → save JSON; copies current "data" → "data_previous" first
//
// Writes are intentionally open (no auth) to match the app's prior behavior.

const KEY = 'data';
const PREV = 'data_previous';
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('prev') ? PREV : KEY;
  const val = await env.LIGA_KV.get(key);
  // Return the raw stored JSON text as-is; "null" when the key is empty.
  return new Response(val ?? 'null', { headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.text();
    JSON.parse(body); // validate it's JSON before storing
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  // Rolling 1-step backup: copy the current live value into the previous slot
  // before overwriting, so restorePreviousFromFirebase() always has an undo.
  const current = await env.LIGA_KV.get(KEY);
  if (current) await env.LIGA_KV.put(PREV, current);
  await env.LIGA_KV.put(KEY, body);
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
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
