import { connect } from 'cloudflare:sockets';

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

/* ── TCP-based tunnel fetch (may share egress IP with fetch) ── */

async function fetchViaTcp(tunnelUrl) {
  const parsed = new URL(tunnelUrl);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '80');
  const path = parsed.pathname + parsed.search;

  const socket = connect({ hostname: host, port });
  const writer = socket.writable.getWriter();
  const reqLine = `GET ${path} HTTP/1.0\r\nHost: ${host}:${port}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
  await writer.write(new TextEncoder().encode(reqLine));
  writer.releaseLock();

  // Read the response: parse status line + headers, then stream body
  const reader = socket.readable.getReader();
  let headerBuf = new Uint8Array(0);
  let headerEnd = -1;
  let statusCode = 0;
  const respHeaders = {};

  // Read until we find \r\n\r\n
  while (headerEnd === -1) {
    const { done, value } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(headerBuf.length + value.length);
    merged.set(headerBuf);
    merged.set(value, headerBuf.length);
    headerBuf = merged;
    const text = new TextDecoder().decode(headerBuf);
    headerEnd = text.indexOf('\r\n\r\n');
  }

  if (headerEnd === -1) throw new Error('tcp_no_headers');

  const headerText = new TextDecoder().decode(headerBuf.slice(0, headerEnd));
  const lines = headerText.split('\r\n');
  const statusMatch = lines[0].match(/HTTP\/\d\.\d (\d+)/);
  statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) {
      respHeaders[lines[i].substring(0, idx).trim().toLowerCase()] =
        lines[i].substring(idx + 1).trim();
    }
  }

  // leftover body data after headers
  const bodyStart = headerEnd + 4;
  const leftover = headerBuf.slice(bodyStart);

  // Stream the remaining body using a single reader
  const isChunked = (respHeaders['transfer-encoding'] || '').toLowerCase().includes('chunked');

  // For non-chunked (HTTP/1.0 or Content-Length), just pipe raw bytes
  const bodyStream = new ReadableStream({
    start(controller) {
      if (leftover.length > 0) controller.enqueue(leftover);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return { status: statusCode, headers: respHeaders, body: bodyStream };
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
     * /download — all-in-one: ask cobalt + immediately stream the result.
     * Tunnel URLs are IP-bound. We try each cobalt instance sequentially,
     * immediately test the tunnel, and retry with the next instance on 403.
     * We also retry the same URL up to 3 times (Worker may get a matching IP).
     */
    if (u.pathname === '/download') {
      let body;
      try { body = await req.json(); } catch {
        return new Response('{"error":"bad request"}', {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const range = req.headers.get('Range');
      const fetchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
      };
      if (range) fetchHeaders['Range'] = range;

      // Shuffle cobalt list for load distribution
      const shuffled = [...COBALT].sort(() => Math.random() - 0.5);
      const errors = [];

      for (const base of shuffled) {
        const cobaltResult = await tryCobalt(base, body, 12000);
        if (!cobaltResult.ok) { errors.push(base + ':cobalt_fail'); continue; }
        let data;
        try { data = JSON.parse(cobaltResult.text); } catch { continue; }
        if (data.status === 'error' || !data.url) { errors.push(base + ':no_url'); continue; }

        // Try fetching the tunnel URL: first via fetch(), then via TCP socket
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt === 0) {
              // Try normal fetch first
              const upstream = await fetch(data.url, { headers: fetchHeaders, redirect: 'follow' });
              if (upstream.ok || upstream.status === 206) {
                const h = buildStreamHeaders(upstream);
                if (data.filename) {
                  h.set('Content-Disposition', 'attachment; filename="' + data.filename.replace(/"/g, '') + '"');
                }
                return new Response(upstream.body, { status: upstream.status, headers: h });
              }
              if (upstream.status === 403) {
                errors.push(base + ':fetch_403');
                continue; // try TCP next
              }
              errors.push(base + ':fetch_' + upstream.status);
              break;
            } else {
              // Try TCP socket connection (might share egress IP with cobalt fetch)
              const tcpResp = await fetchViaTcp(data.url);
              if (tcpResp.status === 200 || tcpResp.status === 206) {
                const h = new Headers();
                if (tcpResp.headers['content-type']) h.set('Content-Type', tcpResp.headers['content-type']);
                else h.set('Content-Type', 'video/mp4');
                if (tcpResp.headers['content-length']) h.set('Content-Length', tcpResp.headers['content-length']);
                if (data.filename) {
                  h.set('Content-Disposition', 'attachment; filename="' + data.filename.replace(/"/g, '') + '"');
                } else {
                  h.set('Content-Disposition', 'attachment; filename="video.mp4"');
                }
                for (const [k, v] of Object.entries(CORS)) h.set(k, v);
                return new Response(tcpResp.body, { status: tcpResp.status, headers: h });
              }
              errors.push(base + ':tcp_' + tcpResp.status);
            }
          } catch (e) {
            errors.push(base + ':' + (attempt === 0 ? 'fetch_err:' : 'tcp_err:') + e.message);
            if (attempt === 0) continue; // try TCP
          }
        }
      }

      return new Response(JSON.stringify({
        status: 'error',
        error: { code: 'all_failed', detail: errors.join(' | ') },
      }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
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
