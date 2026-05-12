const COBALT = [
  'https://co.ggtyler.dev/',
  'https://dwnld.nichind.dev/',
  'https://cobalt-api.kwiatekmiki.com/',
  'https://capi.oak.li/',
  'https://cobalt.synzr.space/',
  'https://cobalt-backend.canine.tools/',
  'https://cobalt-api.ayo.tf/',
  'https://c-api.lol/',
  'https://cobalt.bigowl.cc/',
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
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (range) headers['Range'] = range;
  const upstream = await fetch(url, { headers, redirect: 'follow' });
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

    let results = await Promise.all(COBALT.map(base => tryCobalt(base, body, 12000)));

    let winner = results.find(r => {
      if (!r.ok) return false;
      try { const j = JSON.parse(r.text); return j.status !== 'error'; } catch { return false; }
    });

    if (!winner) {
      const transient = results.filter(r =>
        r.error || r.status === 0 || r.status === 526 || r.status === 530 ||
        r.status === 502 || r.status === 503 || r.status === 504
      );
      if (transient.length) {
        await new Promise(res => setTimeout(res, 1500));
        const retryBases = transient.map(r => r.base);
        const retried = await Promise.all(retryBases.map(base => tryCobalt(base, body, 12000)));
        const byBase = new Map(retried.map(r => [r.base, r]));
        results = results.map(r => byBase.get(r.base) || r);
        winner = results.find(r => {
          if (!r.ok) return false;
          try { const j = JSON.parse(r.text); return j.status !== 'error'; } catch { return false; }
        });
      }
    }

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
