// Recording proxy for the AC 9 cache gate (tests/e2e/run.sh). Forwards to api.z.ai and
// records REQUEST BODIES ONLY (never headers — the API key is never logged).
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const OUT = new URL('./wire.jsonl', import.meta.url);
const UPSTREAM = 'https://api.z.ai';

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  appendFileSync(OUT, JSON.stringify({ at: Date.now(), method: req.method, path: req.url, body: body.toString('utf8') }) + '\n');
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;
  try {
    const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: body.length ? body : undefined, duplex: 'half' });
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
}).listen(18999, '127.0.0.1', () => console.log('proxy on 18999'));
