// Fake Curated Thoughts MCP server for the wisdom host-contract test (leg
// spec LD11). Newline-delimited JSON-RPC 2.0 over stdio. Exposes
// `curated_recall_context` (and `curated_get_wiki_entry`, which N3 must never
// touch); the recall answers with a CT-shaped envelope whose wiki entries are
// $CT_HC_RECALL_IDS (comma-separated). Logs each tools/call to
// $CT_HC_MCP_LOG when set.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ids = (process.env.CT_HC_RECALL_IDS ?? '').split(',').filter(Boolean);

createInterface({ input: process.stdin }).on('line', (line) => {
  let req: { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string } };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notification
  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ct-hc-fake', version: '0.0.0' },
        },
      });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            {
              name: 'curated_recall_context',
              description: 'Recall curated context (host-contract fake).',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
            {
              name: 'curated_get_wiki_entry',
              description: 'Get one wiki entry (host-contract fake).',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          ],
        },
      });
      return;
    case 'tools/call': {
      if (process.env.CT_HC_MCP_LOG) appendFileSync(process.env.CT_HC_MCP_LOG, `${JSON.stringify(req.params ?? {})}\n`);
      const text = JSON.stringify({
        query: 'host-contract',
        wiki_entries: ids.map((id) => ({ id, title: `Recall ${id}`, text: `Recalled body of ${id}.` })),
      });
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } });
      return;
    }
    case 'ping':
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      return;
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unsupported: ${req.method}` } });
  }
});
