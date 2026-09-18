// Shared recorder for the host-contract probe fixtures.
//
// Every fixture plugin is bundled (Bun.build) into a single JS file before the
// host loads it, so this module is inlined into each one. It only records; it
// exports no plugin function, so the host never invokes anything from it.
//
// Records are appended as JSON lines to the file named by CT_PROBE_OUT. The
// contract test reads them back after the OpenCode process exits.
import { appendFileSync } from 'node:fs';
import type { Hooks, PluginInput, PluginOptions } from '@opencode-ai/plugin';

/** Heading of the block the real integration injects (spec §3). */
export const BLOCK_HEADING = '## Curated Thoughts';
export const PROBE_BLOCK = `${BLOCK_HEADING}\n\n(host-contract probe block)`;

/** Which export form of which fixture produced a record. */
export type ProbeForm =
  | 'named'
  | 'default'
  | 'server'
  | 'mixed-named'
  | 'mixed-server';

export type ProbeRecord =
  | {
      kind: 'invoked';
      form: ProbeForm;
      module: string;
      options: PluginOptions | null;
      inputKeys: string[];
      runtime: { bun: string | null; node: string };
    }
  | {
      kind: 'transform';
      form: ProbeForm;
      module: string;
      sessionIDPresent: boolean;
      sessionID: string | null;
      modelID: string | null;
      before: string[];
      after: string[];
    }
  | { kind: 'event'; form: ProbeForm; module: string; type: string; properties: unknown }
  | { kind: 'dispose'; form: ProbeForm; module: string }
  | { kind: 'mcpStatus'; form: ProbeForm; module: string; data: unknown; error: string | null };

export function record(entry: ProbeRecord): void {
  const out = process.env.CT_PROBE_OUT;
  if (!out) return;
  appendFileSync(out, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

/**
 * Build the hooks object every fixture returns. Only a `mutate: true` fixture
 * touches `output.system`, and it does so the way the real plugin will:
 * additive (push, never rewrite) and idempotent (never twice).
 */
export function probeHooks(
  form: ProbeForm,
  module: string,
  input: PluginInput,
  options: PluginOptions | undefined,
  mutate: boolean,
): Hooks {
  record({
    kind: 'invoked',
    form,
    module,
    options: options ?? null,
    inputKeys: Object.keys(input ?? {}).sort(),
    runtime: { bun: process.versions.bun ?? null, node: process.versions.node },
  });
  let mcpStatusQueried = false;
  return {
    'experimental.chat.system.transform': async (hookInput, output) => {
      const before = [...output.system];
      // No MCP status event exists in the 1.18 SDK's Event union, so also
      // record whether the pull API (client.mcp.status) answers from inside a
      // hook: that is the alternative source for connection state.
      if (mutate && !mcpStatusQueried) {
        mcpStatusQueried = true;
        try {
          const result = await Promise.race([
            input.client.mcp.status(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout after 3000ms')), 3000)),
          ]);
          record({ kind: 'mcpStatus', form, module, data: (result as { data?: unknown }).data ?? null, error: null });
        } catch (err) {
          record({ kind: 'mcpStatus', form, module, data: null, error: String(err) });
        }
      }
      if (mutate && hookInput.sessionID && !output.system.some((s) => s.startsWith(BLOCK_HEADING))) {
        output.system.push(PROBE_BLOCK);
      }
      record({
        kind: 'transform',
        form,
        module,
        sessionIDPresent: typeof hookInput.sessionID === 'string' && hookInput.sessionID.length > 0,
        sessionID: hookInput.sessionID ?? null,
        modelID: hookInput.model?.id ?? null,
        before,
        after: [...output.system],
      });
    },
    event: async ({ event }) => {
      // Keep payloads small: properties are only kept for MCP-ish events,
      // which are the ones the connection-state fallback cares about.
      const type = String(event?.type ?? '');
      record({
        kind: 'event',
        form,
        module,
        type,
        properties: /mcp/i.test(type) ? (event as { properties?: unknown }).properties ?? null : null,
      });
    },
    dispose: async () => {
      record({ kind: 'dispose', form, module });
    },
  };
}
