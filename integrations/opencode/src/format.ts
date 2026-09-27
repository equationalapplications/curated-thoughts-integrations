/**
 * format.ts — render the cached health snapshot as the system-prompt block.
 *
 * Formatting rules follow the DeepSeek sibling (integrations/deepseek/src/
 * format.ts): `## Curated Thoughts` heading, a one-line state, the routing
 * reminder. Secrets-aware by construction: the only free-form input is the
 * brain directory, which is reduced to a sanitized, bounded basename — no full
 * paths, no home directories, no error or exception text ever reach the
 * prompt. Readiness reason codes stay out too; ct_doctor reports them.
 *
 * Zero third-party runtime imports.
 */

import type { HealthSnapshot } from './refresh.js';

/** First line of the block; the idempotence key for injection. */
export const BLOCK_HEADING = '## Curated Thoughts';

export const ROUTING_REMINDER =
  'Curated Thoughts memory is available over MCP. Prefer the one-call recall ' +
  'tool (wiki_context) before composing raw searches; reach for wiki_search / ' +
  'vault_semantic_search / wiki_traverse_graph / vault_related_chunks only for ' +
  'deep work. Never touch the vault or brain database out-of-band — the ' +
  'sidecar is the only writer.';

const MAX_LABEL = 64;

/** True iff `entry` is a block this module produced. */
export function isStatusBlock(entry: string): boolean {
  return entry === BLOCK_HEADING || entry.startsWith(`${BLOCK_HEADING}\n`);
}

/** Last path segment only, restricted to a conservative character set. */
function brainLabel(brainDir: string | undefined): string {
  if (!brainDir) return 'default';
  const segments = brainDir.split(/[/\\]/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  const safe = last.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_LABEL);
  return safe.length > 0 ? safe : 'default';
}

export interface FormatOptions {
  /** Resolved brain directory; only a sanitized basename is rendered. */
  brainDir?: string;
}

export function formatStatusBlock(snap: HealthSnapshot, opts: FormatOptions = {}): string {
  const lines = [BLOCK_HEADING];
  if (snap.local === 'ready') {
    lines.push(`Memory sidecar ready (brain: ${brainLabel(opts.brainDir)}).`);
  } else if (snap.local === 'degraded') {
    lines.push(
      'Memory sidecar DEGRADED — CT tool calls may fail. Run ct_doctor for details.',
      'Continue the session without Curated Thoughts memory if tools fail; ' +
        'report the error rather than working around the sidecar.',
    );
  } else {
    lines.push('Memory status unknown; proceed and report any tool errors.');
  }
  if (snap.stale && snap.local !== 'unknown') {
    lines.push('(This status may be out of date.)');
  }
  lines.push(ROUTING_REMINDER);
  return lines.join('\n');
}
