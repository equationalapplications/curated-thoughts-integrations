/**
 * budget.ts — the one wall-clock budget helper every host uses (review of
 * PR #66: DSH and OpenCode each had a private copy).
 */

/**
 * The promise's value if it settles within `ms` (or already has), else null.
 * A rejection resolves null. On expiry `onExpire` runs once, so the caller
 * can abort the work it no longer waits for (kill the `ct` child).
 */
export function settleWithin<T>(promise: Promise<T>, ms: number, onExpire?: () => void): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        onExpire?.();
      } catch {
        /* fail quietly */
      }
      resolve(null);
    }, Math.max(0, ms));
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
