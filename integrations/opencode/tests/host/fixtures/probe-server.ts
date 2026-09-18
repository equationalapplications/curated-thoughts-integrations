// Host-contract probe: the `PluginModule` form, `export default { id, server }`.
// Recorded, not required.
import type { PluginModule } from '@opencode-ai/plugin';
import { probeHooks } from './probe-shared.js';

const mod: PluginModule = {
  id: 'ct-probe-server',
  server: async (input, options) => probeHooks('server', import.meta.url, input, options, false),
};

export default mod;
