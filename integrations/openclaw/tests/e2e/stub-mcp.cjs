#!/usr/bin/env node
// Stub Curated Thoughts MCP sidecar for the activity e2e (run_activity.sh):
// a newline-delimited JSON-RPC stdio server with ONE tool,
// curated_recall_context, returning a fixed recall envelope. Logs every
// tools/call argument object to <dir of this file>/mcp-calls.jsonl.
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'mcp-calls.jsonl');
const ENTRIES = [
  { id: 'w-release', title: 'Release flow', text: 'Releases are tagged by the controller after merge, never in the PR.' },
  { id: 'w-recall', title: 'Recall-only fact', text: 'This fact only arrives through an explicit recall.' },
];
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue; // notifications
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: {
        protocolVersion: (req.params && req.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'curated-thoughts-stub', version: '0.0.0' },
      } });
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools: [{
        name: 'curated_recall_context',
        description: 'Recall curated facts from the Curated Thoughts brain for a query.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }] } });
    } else if (req.method === 'tools/call') {
      fs.appendFileSync(LOG, JSON.stringify((req.params && req.params.arguments) || {}) + '\n');
      send({ jsonrpc: '2.0', id: req.id, result: {
        content: [{ type: 'text', text: JSON.stringify({ wiki_entries: ENTRIES, chunks: [] }) }],
      } });
    } else if (req.method === 'ping') {
      send({ jsonrpc: '2.0', id: req.id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
