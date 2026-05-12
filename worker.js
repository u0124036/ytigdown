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

/* ── proxy endpoint ── */

async function proxyStream(req, url) {
  const range = req.headers.get('Range');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (range) headers['Range'] = range;
  const upstream = await fetch(url, { headers, redirect: 'follow' });
  const h = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || lk === 'content-length' || lk === 'content-range' ||
        lk === 'accept-ranges' || lk === 'last-modified' || lk === 'etag' ||
        lk === 'estimated-content-length' || lk === 'content-disposition') {
      h.set(k, v);
    }
  }
  if (!h.has('Content-Type')) h.set('Content-Type', 'video/mp4');
  if (!h.has('Content-Disposition')) h.set('Content-Disposition', 'attachment; filename="video.mp4"');
  // Forward estimated-content-length as Content-Length if missing
  if (!h.has('Content-Length') && h.has('Estimated-Content-Length')) {
    h.set('Content-Length', h.get('Estimated-Content-Length'));
  }
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

/* Rewrite URLs in cobalt response: wrap http:// URLs in our proxy */
function rewriteResponse(text, selfOrigin) {
  try {
    const j = JSON.parse(text);
    if (j.url && j.url.startsWith('http://')) {
      j.url = selfOrigin + '/proxy?u=' + encodeURIComponent(j.url);
    }
    if (j.picker && Array.isArray(j.picker)) {
      j.picker = j.picker.map(item => {
        if (item.url && item.url.startsWith('http://')) {
          item.url = selfOrigin + '/proxy?u=' + encodeURIComponent(item.url);
        }
        return item;
      });
    }
    return JSON.stringify(j);
  } catch { return text; }
}

/* ── main handler ── */

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const u = new URL(req.url);
    const selfOrigin = u.origin;

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

    if (req.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', instances: COBALT.length }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

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
      const rewritten = rewriteResponse(winner.text, selfOrigin);
      return new Response(rewritten, {
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
