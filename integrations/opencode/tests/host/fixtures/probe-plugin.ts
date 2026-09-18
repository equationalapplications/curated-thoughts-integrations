// Host-contract probe: the NAMED export form.
//
// The export name matches the real plugin (`CuratedThoughts`, spec §3) so the
// v0 loader file the test writes is byte-for-byte the shape install.sh renders:
//   export { CuratedThoughts } from "file:///<payload>/lib/src/index.js";
//
// This is the only fixture that mutates `output.system`.
import type { Plugin } from '@opencode-ai/plugin';
import { probeHooks } from './probe-shared.js';

export const CuratedThoughts: Plugin = async (input, options) =>
  probeHooks('named', import.meta.url, input, options, true);
