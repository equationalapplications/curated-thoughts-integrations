/**
 * text.ts — code-point counting and cutting. Every size cap in the core
 * counts like Python's `len` and cuts like Python slicing (by code point),
 * so the TS and Python hosts agree on limits and a cut never splits a
 * surrogate pair.
 */

/** Code points in `text` (Python `len`). */
export function cpLen(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** `text[start:end]` by code point (Python slicing; negative indexes count from the end). */
export function cpSlice(text: string, start: number, end?: number): string {
  const cps = Array.from(text);
  return cps.slice(start, end).join('');
}
