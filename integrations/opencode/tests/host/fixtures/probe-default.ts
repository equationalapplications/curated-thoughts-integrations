// Host-contract probe: the DEFAULT export form (a bare plugin function).
// Recorded, not required — drives whether src/index.ts may rely on it.
import type { Plugin } from '@opencode-ai/plugin';
import { probeHooks } from './probe-shared.js';

const ProbeDefault: Plugin = async (input, options) =>
  probeHooks('default', import.meta.url, input, options, false);

export default ProbeDefault;
