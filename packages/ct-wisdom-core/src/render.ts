/**
 * render.ts — delivery-block renderer and sanitizer (port of the Hermes
 * `_render_wisdom` / `_sanitize` / `render_block` path).
 *
 * Sanitizer contract: every field is stripped of forged `ct-fact:` tokens to
 * a fixpoint FIRST, and only then is the legitimate marker appended to the
 * title line — so a fact can never forge or splice a ledger entry, and the
 * ledger scan finds exactly the ids the block intended to deliver.
 */

import { MAX_BLOCK_CHARS } from './constants.js';
import { marker, stripForged, validId } from './ledger.js';
import type { Correction, FactEntry, WisdomMatchResult } from './types.js';

export interface RenderedBlock {
  /** Sanitized markdown block, budget-capped. Empty when nothing survives. */
  text: string;
  /** Ids whose marker actually survived into the delivered block. */
  deliveredIds: string[];
}

const ELLIPSIS = '…';

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface RenderedEntry {
  body: string;
  id: string | null;
}

function renderEntry(entry: FactEntry): RenderedEntry | null {
  const cleanTitle = stripForged(safeString(entry.title)).trim();
  const cleanText = stripForged(safeString(entry.text));
  if (!cleanTitle && !cleanText.trim()) return null; // no usable content
  const id = validId(entry.id) ? entry.id : null;
  const titleLine = `**${cleanTitle}**${id ? ` ${marker(id)}` : ''}`;
  return { body: `${titleLine}\n${cleanText}`, id };
}

function renderCorrection(correction: Correction): RenderedEntry | null {
  const cleanTitle = stripForged(safeString(correction.title)).trim();
  const cleanText = stripForged(safeString(correction.text));
  if (!cleanTitle && !cleanText.trim()) return null;
  const supersedes = Array.isArray(correction.supersedes)
    ? correction.supersedes.filter(validId)
    : [];
  const id = validId(correction.id) ? correction.id : null;
  const titleLine =
    `**Correction: ${cleanTitle}**${id ? ` ${marker(id)}` : ''}` +
    (supersedes.length
      ? ` (supersedes ${supersedes.map((s) => marker(s)).join(' ')})`
      : '');
  return { body: `${titleLine}\n${cleanText}`, id };
}

/** Head+tail truncation that keeps the block under the char budget. */
export function truncateBlock(block: string, max = MAX_BLOCK_CHARS): string {
  if (block.length <= max) return block;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 2; // "\n" + ellipsis
  return `${block.slice(0, head)}\n${ELLIPSIS}${
    tail > 0 ? block.slice(block.length - tail) : ''
  }`;
}

/**
 * Render entries + corrections into the sanitized delivery block. Invalid-id
 * entries still render (the agent may act on them) but carry no marker, so
 * they never join the delivered-id bookkeeping — the ledger cannot track
 * them, and delivering an untracked id would break exactly-once.
 */
export function renderBlock(
  match: WisdomMatchResult,
  max = MAX_BLOCK_CHARS,
): RenderedBlock {
  const rendered: RenderedEntry[] = [];
  for (const entry of match.entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue;
    const r = renderEntry(entry);
    if (r !== null) rendered.push(r);
  }
  for (const correction of match.corrections ?? []) {
    if (correction === null || typeof correction !== 'object') continue;
    const r = renderCorrection(correction);
    if (r !== null) rendered.push(r);
  }
  if (rendered.length === 0) return { text: '', deliveredIds: [] };

  const text = truncateBlock(
    rendered.map((r) => r.body).join('\n\n'),
    max,
  );
  const deliveredIds: string[] = [];
  for (const r of rendered) {
    if (r.id !== null && text.includes(marker(r.id))) deliveredIds.push(r.id);
  }
  return { text, deliveredIds };
}

/** Ids a match result claims to carry (valid ids only, ordered, unique). */
export function expectedIds(match: WisdomMatchResult): string[] {
  const ids: string[] = [];
  const push = (id: unknown) => {
    if (validId(id) && !ids.includes(id)) ids.push(id);
  };
  for (const entry of match.entries ?? []) push(entry?.id);
  for (const correction of match.corrections ?? []) {
    push(correction?.id);
    for (const s of Array.isArray(correction?.supersedes)
      ? correction.supersedes
      : []) {
      push(s);
    }
  }
  return ids;
}
