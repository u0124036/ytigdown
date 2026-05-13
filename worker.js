import { connect } from 'cloudflare:sockets';

const COBALT = [
  'https://co.ggtyler.dev/',
  'https://dwnld.nichind.dev/',
  'https://cobalt-backend.canine.tools/',
  'https://cobalt-api.ayo.tf/',
  'https://c-api.lol/',
  'https://cobalt.bigowl.cc/',
  'https://cobalt-api.kwiatekmiki.com/',
  'https://capi.oak.li/',
  'https://cobalt.synzr.space/',
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
     * /download — all-in-one with status reporting.
     * Protocol: first sends JSON status lines (each \n-terminated),
     * then a delimiter line "---STREAM---\n", then raw video bytes.
     * Each status line: {"instance":"name","status":"trying|ok|fail","detail":"..."}
     */
    if (u.pathname === '/download') {
      const direct = u.searchParams.get('direct') === '1';
      let body;
      const ct = (req.headers.get('Content-Type') || '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded')) {
        const fd = await req.formData();
        body = Object.fromEntries(fd.entries());
      } else {
        try { body = await req.json(); } catch {
          return new Response('{"error":"bad request"}', {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      const range = req.headers.get('Range');
      const fetchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
      };
      if (range) fetchHeaders['Range'] = range;

      const enc = new TextEncoder();
      const shuffled = [...COBALT].sort(() => Math.random() - 0.5);

      /* ── Direct mode: stream video bytes directly (for desktop form POST) ── */
      if (direct) {
        const errors = [];
        for (const base of shuffled) {
          const name = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const cobaltResult = await tryCobalt(base, body, 12000);
          if (!cobaltResult.ok) { errors.push(name + ':cobalt_fail'); continue; }
          let data;
          try { data = JSON.parse(cobaltResult.text); } catch { errors.push(name + ':bad_json'); continue; }
          if (data.status === 'error' || !data.url) {
            errors.push(name + ':' + (data.error?.code || 'no_url')); continue;
          }
          const fn = data.filename || 'video.mp4';
          // Try fetch then TCP
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              if (attempt === 0) {
                const upstream = await fetch(data.url, { headers: fetchHeaders, redirect: 'follow' });
                if (upstream.ok || upstream.status === 206) {
                  const h = buildStreamHeaders(upstream);
                  h.set('Content-Disposition', 'attachment; filename="' + fn.replace(/"/g, '') + '"');
                  return new Response(upstream.body, { status: upstream.status, headers: h });
                }
                if (upstream.status === 403) continue;
                errors.push(name + ':fetch_' + upstream.status); break;
              } else {
                const tcpResp = await fetchViaTcp(data.url);
                if (tcpResp.status === 200 || tcpResp.status === 206) {
                  const h = new Headers();
                  h.set('Content-Type', 'video/mp4');
                  h.set('Content-Disposition', 'attachment; filename="' + fn.replace(/"/g, '') + '"');
                  if (tcpResp.headers['content-length']) h.set('Content-Length', tcpResp.headers['content-length']);
                  if (tcpResp.headers['estimated-content-length']) h.set('Content-Length', tcpResp.headers['estimated-content-length']);
                  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
                  return new Response(tcpResp.body, { status: tcpResp.status, headers: h });
                }
                errors.push(name + ':tcp_' + tcpResp.status);
              }
            } catch (e) {
              if (attempt === 0) continue;
              errors.push(name + ':tcp_err');
            }
          }
        }
        return new Response(JSON.stringify({ status: 'error', error: { code: 'all_failed', detail: errors.join(' | ') } }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      /* ── Status reporting mode: JSON lines → ---STREAM--- → video bytes ── */
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      const sendLine = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n'));

      (async () => {
        try {
          for (const base of shuffled) {
            const name = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
            await sendLine({ instance: name, status: 'trying' });

            const cobaltResult = await tryCobalt(base, body, 12000);
            if (!cobaltResult.ok) {
              await sendLine({ instance: name, status: 'fail', detail: 'cobalt_error' });
              continue;
            }
            let data;
            try { data = JSON.parse(cobaltResult.text); } catch {
              await sendLine({ instance: name, status: 'fail', detail: 'bad_json' });
              continue;
            }
            if (data.status === 'error' || !data.url) {
              const code = data.error?.code || 'no_url';
              await sendLine({ instance: name, status: 'fail', detail: code });
              continue;
            }

            for (let attempt = 0; attempt < 2; attempt++) {
              const method = attempt === 0 ? 'fetch' : 'tcp';
              try {
                if (attempt === 0) {
                  const upstream = await fetch(data.url, { headers: fetchHeaders, redirect: 'follow' });
                  if (upstream.ok || upstream.status === 206) {
                    let cl = upstream.headers.get('Content-Length');
                    if (!cl) cl = upstream.headers.get('Estimated-Content-Length');
                    const fn = data.filename || 'video.mp4';
                    await sendLine({ instance: name, status: 'ok', method, filename: fn, size: cl ? +cl : 0 });
                    await writer.write(enc.encode('---STREAM---\n'));
                    const reader = upstream.body.getReader();
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      await writer.write(value);
                    }
                    await writer.close();
                    return;
                  }
                  if (upstream.status === 403) continue;
                  await sendLine({ instance: name, status: 'fail', detail: method + '_' + upstream.status });
                  break;
                } else {
                  const tcpResp = await fetchViaTcp(data.url);
                  if (tcpResp.status === 200 || tcpResp.status === 206) {
                    let cl = tcpResp.headers['content-length'] || tcpResp.headers['estimated-content-length'];
                    const fn = data.filename || 'video.mp4';
                    await sendLine({ instance: name, status: 'ok', method, filename: fn, size: cl ? +cl : 0 });
                    await writer.write(enc.encode('---STREAM---\n'));
                    const reader = tcpResp.body.getReader();
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      await writer.write(value);
                    }
                    await writer.close();
                    return;
                  }
                  await sendLine({ instance: name, status: 'fail', detail: method + '_' + tcpResp.status });
                }
              } catch (e) {
                if (attempt === 0) continue;
                await sendLine({ instance: name, status: 'fail', detail: method + '_err' });
              }
            }
          }
          await sendLine({ status: 'error', detail: 'all_failed' });
          await writer.close();
        } catch (e) {
          try {
            await sendLine({ status: 'error', detail: e.message });
            await writer.close();
          } catch {}
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-cache',
          ...CORS,
        },
      });
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
