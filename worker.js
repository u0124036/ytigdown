const COBALT = [
  'https://cobalt-api.kwiatekmiki.com/',
  'https://capi.oak.li/',
  'https://co.ggtyler.dev/',
  'https://cobalt.synzr.space/',
  'https://dwnld.nichind.dev/',
  'https://api.cobalt.tools/',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
};

async function tryCobalt(base, body, timeoutMs) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { base, ok: r.ok, status: r.status, text };
  } catch (e) {
    return { base, ok: false, status: 0, error: e.name + ':' + (e.message || 'fail') };
  } finally {
    clearTimeout(tid);
  }
}

async function getCobaltUrl(body) {
  const results = await Promise.all(COBALT.map(base => tryCobalt(base, body, 15000)));
  const isValid = r => {
    if (!r.ok) return false;
    try { return JSON.parse(r.text).status !== 'error'; } catch { return false; }
  };
  const winner = results.find(r => isValid(r));
  if (!winner) return null;
  try { return JSON.parse(winner.text); } catch { return null; }
}

/* ── proxy: fetch upstream and stream back with CORS ── */

function buildStreamHeaders(upstream) {
  const h = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || lk === 'content-length' || lk === 'content-range' ||
        lk === 'accept-ranges' || lk === 'last-modified' || lk === 'etag' ||
        lk === 'content-disposition') {
      h.set(k, v);
    }
  }
  // cobalt uses Estimated-Content-Length
  const est = upstream.headers.get('Estimated-Content-Length');
  if (!h.has('Content-Length') && est) h.set('Content-Length', est);
  if (!h.has('Content-Type')) h.set('Content-Type', 'video/mp4');
  if (!h.has('Content-Disposition')) h.set('Content-Disposition', 'attachment; filename="video.mp4"');
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return h;
}

async function proxyStream(req, url) {
  const range = req.headers.get('Range');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };
  if (range) headers['Range'] = range;
  const upstream = await fetch(url, { headers, redirect: 'follow' });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: buildStreamHeaders(upstream),
  });
}

/* ── main handler ── */

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const u = new URL(req.url);

    /* /proxy?u=  — simple proxy for non-tunnel URLs (IG CDN etc.) */
    if (u.pathname === '/proxy') {
      const target = u.searchParams.get('u');
      if (!target) {
        return new Response('{"error":"missing u"}', {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      try {
        return await proxyStream(req, decodeURIComponent(target));
      } catch (e) {
        return new Response(JSON.stringify({ error: 'proxy_failed', detail: e.message }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
    }

    /*
     * /download — all-in-one: ask cobalt + immediately stream the result
     * This ensures the cobalt request and the tunnel fetch use the SAME Worker IP.
     * Tunnel URLs are IP-bound, so splitting into 2 requests would fail.
     */
    if (u.pathname === '/download') {
      let body;
      try { body = await req.json(); } catch {
        return new Response('{"error":"bad request"}', {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      const data = await getCobaltUrl(body);
      if (!data || !data.url) {
        return new Response(JSON.stringify({
          status: 'error', error: { code: 'no_url', detail: 'cobalt returned no download URL' },
        }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
      }
      try {
        // Stream the video directly back — same IP as the cobalt request
        const range = req.headers.get('Range');
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': '*/*',
        };
        if (range) headers['Range'] = range;
        const upstream = await fetch(data.url, { headers, redirect: 'follow' });
        if (!upstream.ok && upstream.status !== 206) {
          return new Response(JSON.stringify({
            status: 'error', error: { code: 'tunnel_' + upstream.status },
          }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        const h = buildStreamHeaders(upstream);
        // Use filename from cobalt if available
        if (data.filename) {
          h.set('Content-Disposition', 'attachment; filename="' + data.filename.replace(/"/g, '') + '"');
        }
        return new Response(upstream.body, { status: upstream.status, headers: h });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'download_failed', detail: e.message }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
    }

    /* GET / — health check */
    if (req.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', instances: COBALT.length }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    /* POST / — info only (returns cobalt JSON for metadata) */
    let body;
    try { body = await req.json(); } catch {
      return new Response('{"error":"bad request"}', {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    const results = await Promise.all(COBALT.map(base => tryCobalt(base, body, 15000)));
    const isValid = r => {
      if (!r.ok) return false;
      try { return JSON.parse(r.text).status !== 'error'; } catch { return false; }
    };
    const winner = results.find(r => isValid(r));
    if (winner) {
      return new Response(winner.text, {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    const detail = results.map(r => {
      const name = r.base.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (r.error) return `${name}=${r.error}`;
      let code = 'HTTP' + r.status;
      try { const j = JSON.parse(r.text); if (j.error && j.error.code) code = j.error.code; } catch {}
      return `${name}=${code}`;
    }).join(' | ');

    return new Response(JSON.stringify({
      status: 'error',
      error: { code: 'all_failed', detail },
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },
};
