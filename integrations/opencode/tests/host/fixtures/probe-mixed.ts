// Host-contract probe: a module carrying BOTH a named plugin function and a
// default `{ id, server }` module. Records which one(s) the host invokes, i.e.
// whether the `{ server }` form is preferred over (or loaded alongside) named
// exports. Recorded, not required.
import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { probeHooks } from './probe-shared.js';

export const ProbeMixedNamed: Plugin = async (input, options) =>
  probeHooks('mixed-named', import.meta.url, input, options, false);

const mod: PluginModule = {
  id: 'ct-probe-mixed',
  server: async (input, options) => probeHooks('mixed-server', import.meta.url, input, options, false),
};

export default mod;
