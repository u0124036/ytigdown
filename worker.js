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

async function proxyStream(req, url) {
  const range = req.headers.get('Range');
  const isGoogleVideo = /googlevideo\.com|youtube\.com|ytimg\.com/.test(url);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (isGoogleVideo) {
    headers['Origin'] = 'https://www.youtube.com';
    headers['Referer'] = 'https://www.youtube.com/';
  }
  if (range) headers['Range'] = range;

  let upstream = await fetch(url, { headers, redirect: 'follow' });

  // Retry with minimal headers on 403
  if (upstream.status === 403) {
    const minHeaders = { 'User-Agent': headers['User-Agent'] };
    if (range) minHeaders['Range'] = range;
    upstream = await fetch(url, { headers: minHeaders, redirect: 'follow' });
  }

  const h = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || lk === 'content-length' || lk === 'content-range' ||
        lk === 'accept-ranges' || lk === 'last-modified' || lk === 'etag') {
      h.set(k, v);
    }
  }
  if (!h.has('Content-Type')) h.set('Content-Type', 'video/mp4');
  h.set('Content-Disposition', 'attachment; filename="video.mp4"');
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const u = new URL(req.url);

    if (u.pathname === '/proxy') {
      const target = u.searchParams.get('u');
      if (!target) {
        return new Response('{"error":"missing u"}', { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
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
      return new Response('{"error":"bad request"}', { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const results = await Promise.all(COBALT.map(base => tryCobalt(base, body, 15000)));

    // Prefer tunnel responses (URL goes through cobalt, avoids YouTube IP blocks)
    const isValid = r => {
      if (!r.ok) return false;
      try { return JSON.parse(r.text).status !== 'error'; } catch { return false; }
    };
    const isTunnel = r => {
      try {
        const j = JSON.parse(r.text);
        if (j.status === 'tunnel') return true;
        const base = r.base.replace(/\/$/, '');
        if (j.url && j.url.startsWith(base)) return true;
        // Not a direct YouTube/Google CDN URL = likely safe
        if (j.url && !/googlevideo\.com|youtube\.com/.test(j.url)) return true;
        return false;
      } catch { return false; }
    };
    const winner = results.find(r => isValid(r) && isTunnel(r))
      || results.find(r => isValid(r));
    if (winner) {
      return new Response(winner.text, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    const detail = results.map(r => {
      const name = r.base.replace(/^https?:\/\//,'').replace(/\/$/,'');
      if (r.error) return `${name}=${r.error}`;
      let code = 'HTTP'+r.status;
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
