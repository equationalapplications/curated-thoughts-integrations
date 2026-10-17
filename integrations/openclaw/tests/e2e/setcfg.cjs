// Merge the ZAI (Anthropic-compatible) provider into an isolated openclaw.json,
// routed through the local recording proxy. The API key is referenced by
// env-var NAME only (`${ZAI_API_KEY}`); its value is never written anywhere.
const fs = require('fs');
// Optional third argument: a stub MCP sidecar script for the activity e2e,
// mounted as the user `mcp.servers.curated-thoughts` row.
const [path, port, mcpStub] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.models = {
  mode: 'merge',
  providers: {
    zai: {
      baseUrl: `http://127.0.0.1:${port}/api/anthropic`,
      apiKey: '${ZAI_API_KEY}',
      api: 'anthropic-messages',
      models: [{
        id: 'GLM-5.3-FLASH', name: 'GLM 5.3 Flash', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
      }],
    },
  },
};
cfg.agents = cfg.agents || {};
cfg.agents.defaults = { ...(cfg.agents.defaults || {}), model: { primary: 'zai/GLM-5.3-FLASH' } };
if (mcpStub) {
  cfg.mcp = cfg.mcp || {};
  cfg.mcp.servers = { ...(cfg.mcp.servers || {}), 'curated-thoughts': { transport: 'stdio', command: process.execPath, args: [mcpStub] } };
}
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
