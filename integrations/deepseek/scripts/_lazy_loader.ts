/**
 * _lazy_loader.ts — internal lazy loader for the optional better-sqlite3
 * dependency used by ct_preflight.ts.
 *
 * The prefix is intentional: this module is not part of ct_preflight's public
 * surface. ct_preflight.ts imports `_loadBetterSqlite3` from here; tests reach
 * the `_setBetterSqlite3Loader` / `_resetBetterSqlite3Loader` setters from
 * here as well. Downstream tools that
 * `import { ... } from './ct_preflight.js'` never see the test seams — that
 * was the API exposure the production module used to leak via
 * `export function _setBetterSqlite3Loader(...)`.
 *
 * The test seam stays because `vi.doMock('better-sqlite3', ...)` cannot
 * reliably intercept the native
 * `createRequire(import.meta.url)('better-sqlite3')` call _requireDatabase
 * uses (it's a require, not an import), and the only deterministic way to
 * force the unavailable-dependency path against a real, present brain is
 * to swap the loader at runtime. Mirrors the OpenCode integration's
 * ct_preflight.ts structure, but pushes the seam into this internal module
 * so the production public API stays clean.
 */

import { createRequire } from 'node:module';

import type BetterSqlite3 from 'better-sqlite3';

export type DatabaseConstructor = typeof BetterSqlite3;
export type BetterSqlite3Loader = () => DatabaseConstructor;

/**
 * Result of `_loadBetterSqlite3()`:
 *   - `ok`             — the binding resolved; `ctor` is the constructor.
 *   - `first-failure`  — the loader ran this call and threw; `error` is the
 *                        captured message. The first-call report must include
 *                        the underlying error so the operator sees why the
 *                        native binding is gone.
 *   - `cached-failure` — the loader ran on a previous call and the
 *                        unavailability was cached; this call skipped the
 *                        loader. The doctor must keep producing JSON output,
 *                        so the follow-up error string is the shorter
 *                        "better-sqlite3 is not available" — the verbose
 *                        loader message would repeat on every census call.
 */
export type BetterSqlite3LoadResult =
  | { status: 'ok'; ctor: DatabaseConstructor }
  | { status: 'first-failure'; error: string }
  | { status: 'cached-failure' };

let _databaseCtor: DatabaseConstructor | null | undefined;
let _loader: BetterSqlite3Loader = _defaultLoader;

function _defaultLoader(): DatabaseConstructor {
  // `createRequire` + require() is the deliberate lazy-load seam here: a
  // static import would make the optional better-sqlite3 dependency a hard
  // one for every plugin runtime path.
  const require = createRequire(import.meta.url);
  return require('better-sqlite3') as DatabaseConstructor;
}

/** Test seam: install a custom better-sqlite3 loader and reset the cache. */
export function _setBetterSqlite3Loader(loader: BetterSqlite3Loader): void {
  _loader = loader;
  _databaseCtor = undefined;
}

/** Test seam: restore the default loader and clear the cache. */
export function _resetBetterSqlite3Loader(): void {
  _loader = _defaultLoader;
  _databaseCtor = undefined;
}

/** Resolve better-sqlite3 via the active loader. Caches both the success
 * and the failure outcomes; the result tells the caller which path ran. */
export function _loadBetterSqlite3(): BetterSqlite3LoadResult {
  if (_databaseCtor !== undefined) {
    if (_databaseCtor === null) {
      return { status: 'cached-failure' };
    }
    return { status: 'ok', ctor: _databaseCtor };
  }
  try {
    _databaseCtor = _loader();
    return { status: 'ok', ctor: _databaseCtor };
  } catch (e) {
    _databaseCtor = null;
    return { status: 'first-failure', error: (e as Error).message };
  }
}