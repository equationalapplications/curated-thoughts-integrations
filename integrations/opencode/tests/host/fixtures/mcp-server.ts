// Minimal stdio MCP server used only so the host has an MCP connection whose
// status could surface through the plugin `event` hook. Newline-delimited
// JSON-RPC 2.0; answers initialize, tools/list, ping; ignores notifications.
import { createInterface } from 'node:readline';

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let req: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
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
          serverInfo: { name: 'ct-probe-mcp', version: '0.0.0' },
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
              name: 'probe_echo',
              description: 'Echo (host-contract probe).',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      return;
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unsupported: ${req.method}` } });
  }
});
