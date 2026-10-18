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
 * Pure; never throws.
 */

import { onToolResult, scanIds, validId } from '@equational-applications/ct-wisdom-core';

import { STRUCTURED_PREFIX, isRecallToolName, partTexts, type OpenClawWisdomAdapter } from './adapter.js';

const WRAP_START = '\n---\n';
const WRAP_END = '<<<END_EXTERNAL_UNTRUSTED_CONTENT';
/** N3 marker lines after a rewritten envelope (adapter.rewriteEnvelopeStub). */
const TRAILER_RE = /(?:\n<!-- ct-fact:[^\s>]+ -->)+$/;

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
 * other parts, part fields and `details` pass through untouched.
 */
export function metaToolResult(adapter: OpenClawWisdomAdapter, sessionKey: string, result: unknown): unknown {
  const outer = obj(result);
  if (outer === null || !Array.isArray(outer.content)) return result;
  let content: unknown[] | null = null;
  outer.content.forEach((part, index) => {
    const p = obj(part);
    if (p === null || p.type !== 'text' || typeof p.text !== 'string') return;
    const parts = unwrapMeta(p.text);
    if (parts === null) return;
    const standIn = { content: parts.outer.result.content };
    const rewritten = obj(onToolResult(adapter, { id: sessionKey }, standIn));
    if (rewritten === null || rewritten === standIn || !Array.isArray(rewritten.content)) return;
    parts.outer.result = { ...parts.outer.result, content: rewritten.content };
    content ??= [...(outer.content as unknown[])];
    content[index] = { ...p, text: rewrapMeta(parts) };
  });
  return content === null ? result : { ...outer, content };
}
