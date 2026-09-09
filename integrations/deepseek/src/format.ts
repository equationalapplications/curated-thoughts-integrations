import type { Snapshot } from './status.js';

export const ROUTING_REMINDER =
  'Curated Thoughts memory is available over MCP. Prefer the one-call recall ' +
  'tool (wiki_context) before composing raw searches; reach for wiki_search / ' +
  'vault_semantic_search / wiki_traverse_graph / vault_related_chunks only for ' +
  'deep work. Never touch the vault or brain database out-of-band — the ' +
  'sidecar is the only writer.';

export function formatStatusBlock(snap: Snapshot): string | null {
  const lines = ['## Curated Thoughts'];
  if (snap.status === 'ok') {
    return null; // Hermes returns null here too: nothing worth spending context on.
  }
  if (snap.status === 'degraded') {
    lines.push(
      'Memory sidecar DEGRADED — CT tool calls may fail. ' +
      'Run `node lib/scripts/ct_doctor.js check` for details.',
    );
    for (const note of snap.notes.slice(0, 3)) {
      lines.push(`- ${note}`);
    }
    lines.push(
      'Continue the session without Curated Thoughts memory if tools fail; ' +
      'report the error rather than working around the sidecar.',
    );
  } else {
    lines.push('Memory status unknown; proceed and report any tool errors.');
  }
  lines.push(ROUTING_REMINDER);
  return lines.join('\n');
}
