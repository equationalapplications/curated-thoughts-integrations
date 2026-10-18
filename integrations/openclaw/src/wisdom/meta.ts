/**
 * wisdom/meta.ts — CT recalls through OpenClaw's `tool_call` meta tool
 * (spec 2026-10-17-openclaw-meta-recall-n3-design.md).
 *
 * At the pin, a `tool_call` result has one text part: the 2-space JSON of
 * `{tool, result}` (M2), wrapped in OpenClaw's external-content markers when
 * the nested call touched the network (M3, M4), bare otherwise. These helpers
 * split that text so the N3 dedup can rewrite the inner recall result, and put
 * it back with every byte outside the JSON body unchanged. A body that does not
 * re-serialise byte for byte (compact, truncated, an unknown shape) is refused.
 * Pure and never throws, except `metaToolResult`: it runs the core's N3, which
 * writes the ledger cache through the adapter. It does not throw itself; an
 * adapter error is caught by the middleware's try (src/index.ts).
 */

import { onToolResult, scanIds, validId } from '@equational-applications/ct-wisdom-core';

import { STRUCTURED_PREFIX, isRecallToolName, partTexts, type OpenClawWisdomAdapter } from './adapter.js';

const WRAP_START = '\n---\n';
const WRAP_END = '<<<END_EXTERNAL_UNTRUSTED_CONTENT';
/** N3 marker lines after a rewritten envelope (adapter.rewriteEnvelopeStub). */
const TRAILER_RE = /(?:\n<!-- ct-fact:[^\s>]+ -->)+$/;

/*
 * Boundary guard (final review F1). OpenClaw sanitises the `tool_call` text
 * BEFORE this middleware runs. The rewrite re-serialises the inner envelope,
 * so a JSON `\uXXXX` (or `\/`) escape in a kept entry, which the sanitiser saw
 * as plain ASCII, comes out as the literal character. A rewritten part that
 * holds more marker look-alikes or LLM special tokens than the original is
 * refused. Both lists mirror openclaw 2026.10.3 external-content
 * (`MARKER_CHAR_FOLDS` + `replaceMarkers`, `LLM_SPECIAL_TOKEN_PATTERN`).
 */
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;
const ANGLE_OPEN_RE = /[\u2329\u3008\u2039\u27e8\ufe64\u00ab\u300a\u27ea\u27ec\u27ee\u276c\u276e\u02c2\uff1c]/g;
const ANGLE_CLOSE_RE = /[\u232a\u3009\u203a\u27e9\ufe65\u00bb\u300b\u27eb\u27ed\u27ef\u276d\u276f\u02c3\uff1e]/g;
/** The phrase `replaceMarkers` gates on, and the start of the markers it replaces. */
const MARKER_WORD_RE = /external[\s_]+untrusted[\s_]+content/gi;
const MARKER_RE = /<<<\s*(?:END[\s_]+)?EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT/gi;
const SPECIAL_TOKENS = [
  '<|im_start|>', '<|im_end|>', '<|endoftext|>', '<|begin_of_text|>', '<|end_of_text|>',
  '<|start_header_id|>', '<|end_header_id|>', '<|eot_id|>', '<|python_tag|>', '<|eom_id|>',
  '[INST]', '[/INST]', '<<SYS>>', '<</SYS>>', '<s>', '</s>',
  '<|channel|>', '<|message|>', '<|return|>', '<|call|>', '<start_of_turn>', '<end_of_turn>',
];
const SPECIAL_TOKEN_RE = new RegExp(
  [...SPECIAL_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), /<\|reserved_special_token_\d+\|>/.source].join('|'),
  'g',
);

/** Marker look-alikes plus LLM special tokens in `text`, after OpenClaw-style folding (and NFKC). */
export function boundaryHits(text: string): number {
  const folded = text.replace(ZERO_WIDTH_RE, '').replace(ANGLE_OPEN_RE, '<').replace(ANGLE_CLOSE_RE, '>').normalize('NFKC');
  const count = (re: RegExp) => folded.match(re)?.length ?? 0;
  return count(MARKER_WORD_RE) + count(MARKER_RE) + count(SPECIAL_TOKEN_RE);
}

export interface MetaOuter {
  tool: Record<string, unknown>;
  result: { content: unknown[] } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface MetaParts {
  head: string;
  lead: string;
  outer: MetaOuter;
  trail: string;
  tail: string;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Split a `tool_call` text part, or null when it is not the verified shape. */
export function unwrapMeta(text: string): MetaParts | null {
  try {
    const at = text.indexOf(WRAP_START);
    const end = text.lastIndexOf(WRAP_END);
    const wrapped = at >= 0 && end > at;
    if (!wrapped && (at >= 0 || end >= 0)) {
      // One marker without the other is not the M4 layout. A bare 2-space
      // JSON body can hold neither: JSON escapes newlines, and an end marker
      // inside a string means OpenClaw did not sanitize it (not our shape).
      return null;
    }
    const head = wrapped ? text.slice(0, at + WRAP_START.length) : '';
    const tail = wrapped ? text.slice(end) : '';
    const mid = wrapped ? text.slice(head.length, end) : text;
    const lead = /^\s*/.exec(mid)![0];
    const trail = /\s*$/.exec(mid.slice(lead.length))![0];
    const body = mid.slice(lead.length, mid.length - trail.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    if (JSON.stringify(parsed, null, 2) !== body) return null;
    const outer = obj(parsed);
    if (outer === null || obj(outer.tool) === null) return null;
    const result = obj(outer.result);
    if (result === null || !Array.isArray(result.content)) return null;
    return { head, lead, outer: outer as MetaOuter, trail, tail };
  } catch {
    return null;
  }
}

/** Reassemble a part split by `unwrapMeta`. */
export function rewrapMeta(parts: MetaParts): string {
  return parts.head + parts.lead + JSON.stringify(parts.outer, null, 2) + parts.trail + parts.tail;
}

/** True when `tool_call`'s `args.id` (`mcp:<server>:<tool>`) names the CT recall tool. */
export function isMetaRecallCall(args: unknown): boolean {
  const target = obj(args)?.id;
  if (typeof target !== 'string') return false;
  return isRecallToolName(target.slice(target.lastIndexOf(':') + 1));
}

/**
 * Fact ids of a CT recall made through the `tool_call` meta tool: null when
 * the call is not a CT recall; 'unreadable' when it is but no part is the
 * verified shape and some part was not JSON. Reads an envelope followed by
 * N3 marker lines too, so a rewritten result yields the same ids.
 */
export function metaRecallIds(args: unknown, result: unknown): string[] | 'unreadable' | null {
  if (!isMetaRecallCall(args)) return null;
  let found: string[] | null = null;
  let nonJson = false;
  for (const text of partTexts(obj(result)?.content)) {
    let inner: unknown[] | null = null;
    const parts = unwrapMeta(text);
    if (parts !== null) inner = parts.outer.result.content;
    else {
      // Not byte-exact (compact, or a shape we only read): still read its ids.
      let body = text;
      const at = body.indexOf(WRAP_START);
      if (at >= 0) body = body.slice(at + WRAP_START.length);
      const end = body.lastIndexOf(WRAP_END);
      if (end >= 0) body = body.slice(0, end);
      try {
        const content = obj(obj(JSON.parse(body.trim()))?.result)?.content;
        if (Array.isArray(content)) inner = content;
      } catch {
        nonJson = true;
        continue;
      }
    }
    if (inner === null) continue;
    for (const t of partTexts(inner)) {
      let envelope: Record<string, unknown> | null;
      try {
        const json = (t.startsWith(STRUCTURED_PREFIX) ? t.slice(STRUCTURED_PREFIX.length) : t).replace(TRAILER_RE, '');
        envelope = obj(JSON.parse(json));
      } catch {
        continue;
      }
      const entries = envelope?.wiki_entries;
      if (!Array.isArray(entries)) continue;
      found ??= [];
      for (const entry of entries) {
        const id = obj(entry)?.id;
        if (validId(id) && !found.includes(id)) found.push(id);
      }
      for (const id of scanIds(t)) if (!found.includes(id)) found.push(id);
    }
  }
  // Unreadable only when NO part yields an envelope AND some part was not
  // JSON (a shape we do not know); all-JSON parts without one carry no facts.
  if (found !== null) return found;
  return nonJson ? 'unreadable' : [];
}

/**
 * N3 for a `tool_call` CT recall: run the core's dedup on each text part's
 * inner `result` and rewrap it. Returns the same object when nothing changed;
 * other parts, part fields and `details` pass through untouched. A part is
 * left as it is when its inner `tool.id` is not the call's `args.id`, or when
 * the rewrite would add a boundary marker or special token (`boundaryHits`).
 */
export function metaToolResult(adapter: OpenClawWisdomAdapter, sessionKey: string, args: unknown, result: unknown): unknown {
  const target = obj(args)?.id;
  const outer = obj(result);
  if (typeof target !== 'string' || outer === null || !Array.isArray(outer.content)) return result;
  let content: unknown[] | null = null;
  outer.content.forEach((part, index) => {
    const p = obj(part);
    if (p === null || p.type !== 'text' || typeof p.text !== 'string') return;
    const parts = unwrapMeta(p.text);
    if (parts === null || parts.outer.tool.id !== target) return;
    const standIn = { content: parts.outer.result.content };
    const rewritten = obj(onToolResult(adapter, { id: sessionKey }, standIn));
    if (rewritten === null || rewritten === standIn || !Array.isArray(rewritten.content)) return;
    parts.outer.result = { ...parts.outer.result, content: rewritten.content };
    const text = rewrapMeta(parts);
    if (boundaryHits(text) > boundaryHits(p.text)) return;
    content ??= [...(outer.content as unknown[])];
    content[index] = { ...p, text };
  });
  return content === null ? result : { ...outer, content };
}
