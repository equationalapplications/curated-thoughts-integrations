/** obj.ts — the one plain-object guard of the OpenCode plugin. */

/** True for a non-null, non-array object (host payloads are typed loosely). */
export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
