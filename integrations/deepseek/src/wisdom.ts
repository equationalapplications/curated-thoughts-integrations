// Port of integrations/hermes/scripts/ct_wisdom.py (proven); DSH deltas per
// docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-dsh-design.md.
export const SEED_QUERY = 'curated thoughts agent memory wisdom procedures';
export const PROBE_TIMEOUT_MS = 3000;
export const RECALL_TIMEOUT_MS = 5000;
export const RECALL_K = 3;
export const MAX_BLOCK_CHARS = 2500;
export const MEMO_MAX = 256;
export const BLOCK_HEADING = '## Curated Thoughts \u2014 relevant memory';

const FORBIDDEN_MARKER = '<!-- hermes-plugin-section';
const FORBIDDEN_HEADING = '## Plugin Context: ';
const HEADING_INDENT = '    ' + FORBIDDEN_HEADING;
const ELLIPSIS = '\u2026';

export type WikiEntry = { title: string; text: string };

export function keyOf(ctx: unknown): string {
  const c = (ctx ?? {}) as { agent?: unknown; scope?: unknown };
  const pick = (o: unknown): string =>
    typeof o === 'object' && o !== null && typeof (o as { id?: unknown }).id === 'string'
      ? (o as { id: string }).id
      : '';
  return pick(c.agent) || pick(c.scope) || '';
}

export function sanitize(value: unknown): string {
  let v = typeof value === 'string' ? value : value == null ? '' : String(value);
  while (v.includes(FORBIDDEN_MARKER)) v = v.split(FORBIDDEN_MARKER).join('');
  v = v
    .split('\n')
    .map((line) => (line.startsWith(FORBIDDEN_HEADING) ? HEADING_INDENT + line.slice(FORBIDDEN_HEADING.length) : line))
    .join('\n');
  return v.replace(/\{(?=\{)/g, '{ ');
}

export function renderBlock(entries: WikiEntry[]): string {
  if (!entries.length) return '';
  const heading = sanitize(BLOCK_HEADING);
  const parts: string[] = [];
  let used = heading.length + 2;
  for (const { title, text } of entries) {
    const cleanTitle = sanitize(title).trim();
    const cleanText = sanitize(text);
    if (!cleanTitle && !cleanText.trim()) continue;
    const titleLine = `**${cleanTitle}**`;
    let body = titleLine + '\n' + cleanText;
    const sep = parts.length ? 2 : 0;
    const remaining = MAX_BLOCK_CHARS - used - sep;
    if (remaining <= titleLine.length + 1) continue; // title alone cannot fit: skip
    if (body.length <= remaining) {
      parts.push(body);
      used += sep + body.length;
      continue;
    }
    const textBudget = remaining - titleLine.length - 1 - ELLIPSIS.length;
    if (textBudget > 0) {
      body = titleLine + '\n' + cleanText.slice(0, textBudget) + ELLIPSIS;
      parts.push(body);
      used += sep + body.length;
    }
    break; // budget exhausted after a truncated entry
  }
  if (!parts.length) return '';
  return heading + '\n\n' + parts.join('\n\n');
}
