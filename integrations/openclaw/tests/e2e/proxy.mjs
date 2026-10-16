// Recording proxy for the AC 9 cache gate (tests/e2e/run.sh). Forwards to
// api.z.ai and records REQUEST BODIES ONLY (never headers — the API key is
// never logged). Usage: node proxy.mjs <port>
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const OUT = new URL('./wire.jsonl', import.meta.url);
const UPSTREAM = 'https://api.z.ai';
const PORT = Number(process.argv[2] || 18999);
// RFC 9110 §7.6.1 hop-by-hop headers (+ the de-facto proxy-connection); also
// everything the Connection header names. fetch rejects or mishandles them.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];

function forwardHeaders(incoming) {
  const headers = { ...incoming };
  const named = String(incoming.connection || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const h of [...HOP_BY_HOP, ...named]) delete headers[h];
  return headers;
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  appendFileSync(OUT, JSON.stringify({ at: Date.now(), method: req.method, path: req.url, body: body.toString('utf8') }) + '\n');
  try {
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body: body.length ? body : undefined,
      duplex: 'half',
    });
    const out = {};
    up.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
    });
    res.writeHead(up.status, out);
    if (up.body) Readable.fromWeb(up.body).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502);
    res.end(String(e));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`proxy on ${PORT}`));
