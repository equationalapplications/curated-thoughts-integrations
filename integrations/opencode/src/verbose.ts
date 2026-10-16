/**
 * verbose.ts — OpenCode wiring for Intuitive Wisdom verbose mode (spec
 * docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md, D3/D4).
 * Kept out of index.ts so the plugin module still exports exactly one
 * runtime binding.
 */

import {
  createVerboseRecorder,
  defaultVerboseLogPath,
  type VerboseRecord,
  type VerboseTurn,
} from '@equational-applications/ct-wisdom-core';

/** One-line toast text: what was delivered, or why nothing was. */
export function toastText(record: VerboseRecord): string {
  if (record.event !== 'delivery') return `nothing delivered (${record.reason})`;
  const ids = new Set(record.delivered_ids ?? []);
  const titles = (record.matched ?? [])
    .filter((m) => m.id !== null && ids.has(m.id))
    .map((m) => m.title.replace(/\s+/g, ' ').trim() || m.id);
  const n = ids.size;
  const text = `delivered ${n} fact${n === 1 ? '' : 's'} (${record.block_chars ?? 0} chars): ${titles.join('; ')}`;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * Verbose mode (spec 2026-10-16-wisdom-verbose-mode-design.md, D3/D4): with
 * CT_WISDOM_VERBOSE on, each live-delivery decision becomes a TUI toast
 * (`client.tui.showToast`, never a session part) and a record in
 * $XDG_DATA_HOME/opencode/log/ct-wisdom-verbose.jsonl. Undefined when off.
 */
export function opencodeVerboseRecorder(
  client: unknown,
  directory: string | undefined,
  env: NodeJS.ProcessEnv,
): ((turn: VerboseTurn) => void) | undefined {
  return createVerboseRecorder({
    host: 'opencode',
    channel: 'chat.message',
    env,
    logPath: defaultVerboseLogPath('opencode', env),
    notify: (_text, record) => {
      const tui = (client as { tui?: { showToast?: (o: unknown) => unknown } } | null)?.tui;
      if (typeof tui?.showToast !== 'function') return undefined;
      return tui.showToast({
        body: { title: 'Curated Thoughts wisdom', message: toastText(record), variant: 'info', duration: 8000 },
        ...(directory ? { query: { directory } } : {}),
      });
    },
  });
}
