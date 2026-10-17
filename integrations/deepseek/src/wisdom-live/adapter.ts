/**
 * wisdom-live/adapter.ts — the DSH HostAdapter binding for the shared
 * `ct-wisdom-core` algorithm (spec: 2026-10-09 cross-harness parity, DSH leg;
 * host evidence base: DSH 0.2.0-rc.2 tarballs, tests/host/compatibility.json).
 *
 * Mapping (spec "Per-host adapter contracts", DSH row):
 *   N1 trigger   — `agent/pre-step` (registered in ../index.ts; only the
 *                  firstAttempt step of a turn reaches onUserTurn here).
 *   N2 delivery  — our PreStepDecision appends a user message to the decision's
 *                  `messages`; agent-loop `step()` persists every firstAttempt
 *                  decision message verbatim via `session.append("user/message")`.
 *   N3 transform — `tools/post-execute` (MCP tools route through the harness
 *                  ToolRuntime), rewriting the result content blocks.
 *   Ledger       — rebuilt from `agent.session.deriveMessages()` — the exact
 *                  frozen Message[] the next trigger reads (m5: NEVER from the
 *                  pre-step decision, which is not yet persisted when it runs).
 *   Session id   — `agent.id` (stable across compaction; a fork gets a new id).
 *
 * The bootstrap ids (v1 auto-inclusion memo) join the ledger via
 * `bootstrapIdsFor`: the memo record's ids union the session-log scan, so the
 * knownBootstrap/restored semantics stay host-local (m2 advisory cache).
 */

import {
  lruSet,
  marker,
  onToolResult as coreOnToolResult,
  onUserTurn as coreOnUserTurn,
  wisdomMatch as coreWisdomMatch,
  type HostAdapter,
  type Ledger,
  type MatchOutcome,
  type SessionRef,
  type SpawnFn,
  type SpawnOutcome,
  type VerboseTurn,
  type WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import { spawn } from 'node:child_process';
import { discoverCt, invalidateAcceptedPath } from '../wisdom.js';

/** One v1 memo record: the rendered block plus the fact ids it delivered. */
export interface MemoRecord {
  block: string;
  ids: string[];
}

/** The text block of a ContentBlock list (type: 'text' only). */
function blockTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out.push((block as { text: string }).text);
    }
  }
  return out;
}

/** The user message's text (string content or text parts), for the query. */
export function userMessageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return '';
  return blockTexts((message as { content?: unknown }).content).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// SpawnFn: async child_process binding with the same hygiene as the v1
// spawnSync path (argument LIST — never a shell string — killSignal SIGKILL,
// maxBuffer, cwd home, no shell, windowsHide). `spec.signal` aborts: on POSIX
// the child's process group is killed (the child and anything it started);
// on Windows only the direct child is killed. The outcome reports
// `aborted: true` unless the child had already exited or never started.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The binding's one outcome normalization: a binary that could not start
 * and a capped runaway are spawn errors and never `aborted` (the core's
 * classify checks `aborted` first), so ENOENT is never mistaken for an
 * abort. Every other layer relies on this invariant.
 */
export function spawnOutcomeOf(raw: {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: boolean;
  overflow: boolean;
  timedOut: boolean;
  aborted: boolean;
}): SpawnOutcome {
  const spawnError = raw.spawnError || raw.overflow;
  const out: SpawnOutcome = { code: raw.code, stdout: raw.stdout, stderr: raw.stderr, spawnError, timedOut: raw.timedOut };
  if (raw.aborted && !spawnError) out.aborted = true;
  return out;
}

/**
 * After a kill, how long to wait for 'close' once the child has exited. A
 * kill cannot always close the pipes (Windows kills only the direct child;
 * a descendant that left the process group keeps stdout open), and a
 * promise that never settles would leak the plan and skip the budget miss.
 */
const KILL_GRACE_MS = 250;

export function nodeSpawnFn(env: NodeJS.ProcessEnv = process.env): SpawnFn {
  return (spec) =>
    new Promise((resolve) => {
      // Already aborted (the budget ran out before the spawn): start nothing.
      if (spec.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: false, aborted: true });
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args, {
          killSignal: 'SIGKILL' as NodeJS.Signals,
          cwd: env.HOME || env.USERPROFILE || '.',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          // Process-group leader (POSIX): a kill takes the whole group down.
          // Without it a `sh -c <tool>` wrapper survives as a grandchild
          // holding the stdio pipes open and 'close' never fires — the 3 s
          // budget would leak a 30 s hang. windowsHide covers the console
          // flash on Windows; detached there is a no-op for kill.
          detached: process.platform !== 'win32',
        });
      } catch {
        resolve({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false });
        return;
      }
      // Bounded accumulation stands in for maxBuffer (async spawn has none):
      // a runaway binary cannot grow these strings past the same 4 MiB cap
      // the v1 spawnSync path enforced.
      let stdout = '';
      let stderr = '';
      let overflow = false;
      const CAP = 4 * 1024 * 1024;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let killed = false;
      let exitCode: number | null = null;
      let exited = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      /** Killed and exited: give 'close' a short grace, then settle anyway. */
      function armGrace(): void {
        if (grace !== undefined || settled) return;
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, false);
        }, KILL_GRACE_MS);
      }
      /**
       * The one kill path (timeout, abort, overflow). POSIX: the process
       * group (negative pid), falling back to the direct child when the
       * group is gone; Windows: the direct child only. A child that never
       * started has no pid and is never signalled: `child.kill()` on a
       * failed spawn signals pid 0, i.e. OUR OWN process group.
       */
      function killTree(): void {
        const pid = child.pid;
        if (typeof pid !== 'number' || pid <= 0) return;
        killed = true;
        // Already exited: never signal (the leader is reaped, so -pid could
        // hit a reused group); only bound the wait for pipes others hold,
        // keeping the output read so far.
        if (exited) {
          armGrace();
          return;
        }
        if (process.platform !== 'win32') {
          try {
            process.kill(-pid, 'SIGKILL');
            return;
          } catch {
            /* group gone — fall through to the direct kill */
          }
        }
        child.kill('SIGKILL');
      }
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, spec.timeoutMs);
      const finish = (code: number | null, spawnError: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        // Every end path ('close', 'error', the kill grace) drops the abort listener.
        spec.signal?.removeEventListener('abort', onAbort);
        resolve(spawnOutcomeOf({ code, stdout, stderr, spawnError, overflow, timedOut, aborted }));
      };
      child.on('error', () => finish(null, true));
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        if (killed) armGrace();
      });
      // The caller's budget ran out (activity delivery, `spec.signal`): kill
      // the tree now and report `aborted`, which the core classifies as its
      // own outcome (OpenCode / OpenClaw parity). A child that already
      // exited keeps its real result (killTree then only bounds the wait).
      function onAbort(): void {
        if (!exited) aborted = true;
        killTree();
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => finish(code, false));
    });
}

// ─────────────────────────────────────────────────────────────────────────
// The curated_recall_context envelope (N3).
//
// A successful MCP call arrives as a ToolExecutionSuccess: `value` is the
// parsed JSON envelope and `content` its rendered blocks. The envelope's
// result payload is the CT recall shape — { result: "<CT JSON>" } whose inner
// wiki_entries carry fact ids (the Hermes investigation Target 5 shape).
// Anything else — errors, other shapes, other tools — passes through
// untouched.
// ─────────────────────────────────────────────────────────────────────────

export const RECALL_TOOL_SUFFIX = '__curated_recall_context';

/**
 * Inner recall envelope: the FULL parsed object (every CT key, in CT's key
 * order), of which N3 reads and rewrites only `wiki_entries`. Narrowing it to
 * `{ wiki_entries }` dropped every sibling key from the rewritten result.
 */
interface InnerEnvelope {
  wiki_entries: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function parseEnvelope(result: unknown):
  | { outer: Record<string, unknown>; inner: InnerEnvelope }
  | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const outer = result as Record<string, unknown>;
  if (typeof outer.result !== 'string') return null;
  let inner: unknown;
  try {
    inner = JSON.parse(outer.result);
  } catch {
    return null;
  }
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    return null;
  }
  const obj = inner as Record<string, unknown>;
  if (!Array.isArray(obj.wiki_entries)) return null;
  // Keep the whole object: JSON.parse preserves key order, so re-serializing
  // it changes only what the rewrite replaces (OpenCode leg parity).
  return { outer, inner: obj as InnerEnvelope };
}

export function isRecallToolName(name: unknown): boolean {
  return typeof name === 'string' && name.endsWith(RECALL_TOOL_SUFFIX);
}

function stubEntry(factId: string): Record<string, unknown> {
  return {
    id: factId,
    in_context: true,
    note: `already in context: ct-fact:${factId}`,
  };
}

/**
 * Marker ids of one frozen message, memoized by object identity. DSH's
 * `deriveMessages()` returns shared, deep-frozen Message objects that are
 * reused across calls for unchanged history ("pure tail growth costs O(new
 * nodes)", dsh-session `Session.deriveMessages` at 0.2.0-rc.2), so a ledger
 * rebuild rescans only messages that are new since the last one: the tool
 * results that arrived after a plan, a compaction's replacement. A frozen
 * object cannot change, so the memo can never go stale; a mutable message is
 * scanned every time.
 */
const messageIdMemo = new WeakMap<object, readonly string[]>();

function messageIds(message: unknown): readonly string[] {
  if (message === null || typeof message !== 'object') return [];
  const memo = messageIdMemo.get(message);
  if (memo !== undefined) return memo;
  const msg = message as { role?: unknown; content?: unknown };
  const ids: string[] = [];
  if (msg.role === 'user' || msg.role === 'tool') { // N4 scan roles
    for (const text of blockTexts(msg.content)) {
      const re = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) if (!ids.includes(m[1])) ids.push(m[1]);
    }
  }
  if (Object.isFrozen(message)) messageIdMemo.set(message, ids);
  return ids;
}

/** Valid fact id per the core's CT guarantee (mirrors validId's charset). */
function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

// ─────────────────────────────────────────────────────────────────────────
// DshWisdomAdapter
// ─────────────────────────────────────────────────────────────────────────

export interface AdapterDeps {
  /** Resolved brain env for discovery + spawns (CURATED_BRAIN_DIR carried). */
  env: NodeJS.ProcessEnv;
  /** Injected spawn (tests); defaults to the real nodeSpawnFn binding. */
  spawnFn?: SpawnFn;
  /** Injected discovery (tests); defaults to the v1 module discovery. */
  discover?: () => { path: string | null; failure: string | null };
  /** Injected clock for the breaker (tests). */
  now?: () => number;
  /** Injected discovery invalidation (tests); defaults to the v1 module's accepted-path reset. */
  invalidateDiscovery?: () => void;
  /** Verbose-mode recorder; set only when CT_WISDOM_VERBOSE is on. */
  recordVerbose?: (turn: VerboseTurn) => void;
}

/**
 * Per-turn state: the ledger rebuilt at N1, cached BEFORE any early return
 * (m1) so N3 can dedup even on turns that deliver nothing. Turn-scoped only —
 * the next turn's N1 rebuild is the source of truth (INTENT M1).
 */
interface TurnState {
  ledger: Ledger | null;
}

export class DshWisdomAdapter implements HostAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn;
  private readonly discover: () => { path: string | null; failure: string | null };
  private readonly now: () => number;
  private readonly invalidateDiscovery: () => void;
  private readonly turns = new Map<string, TurnState>();
  private capabilityAbsent = false;
  /** The ct path whose `wisdom match --help` probe passed (probe once per path). */
  private probedPath: string | null = null;
  /** Verbose mode only (absent when off, so the adapter is unchanged). */
  declare readonly recordVerbose?: (turn: VerboseTurn) => void;

  constructor(deps: AdapterDeps) {
    if (deps.recordVerbose) this.recordVerbose = deps.recordVerbose;
    this.env = deps.env;
    this.spawnFn = deps.spawnFn ?? nodeSpawnFn(deps.env);
    this.discover = deps.discover ?? (() => discoverCt(deps.env));
    this.now = deps.now ?? (() => Date.now());
    this.invalidateDiscovery = deps.invalidateDiscovery ?? invalidateAcceptedPath;
  }

  /** TEST-ONLY: drop all turn caches. */
  _resetForTests(): void {
    this.turns.clear();
    this.capabilityAbsent = false;
    this.probedPath = null;
  }

  /**
   * The v1 memo record for this agent, when this process rendered one. The
   * index.ts wiring sets this before the N1 rebuild each turn.
   */
  bootstrapMemo: Record<string, MemoRecord> = {};

  /**
   * Bootstrap ids: the memo record's ids — recorded at render time — even
   * when the block text itself was compacted away (m2 advisory cache parity
   * with the Hermes `_last` store).
   */
  private bootstrapIdsFor(sessionId: string): string[] {
    const rec = this.bootstrapMemo[sessionId];
    return rec ? rec.ids : [];
  }

  deliveryEnabled(_session: SessionRef): boolean {
    // DSH has no resume-OFF latch (decision 4d is claude-code-only); the
    // restored+unknown-bootstrap fail-closed rule covers resume below.
    return true;
  }

  restored(_session: SessionRef): boolean {
    // No separate restore path on DSH (host row, Restore rule): resume reuses
    // the same session log, so knownBootstrap below carries the semantics.
    return false;
  }

  /**
   * m5 source of truth: rebuild from the session log the NEXT trigger reads —
   * agent.session.deriveMessages() — plus the memo bootstrap ids. Never from
   * the pre-step decision (its messages are not yet persisted when N1 runs).
   */
  rebuildLedger(session: SessionRef): Ledger {
    const logIds = this.sessionLogIds(session);
    const bootIds = this.bootstrapIdsFor(session.id);
    const merged: string[] = [...logIds];
    for (const id of bootIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    const set = new Set(merged);
    const knownBootstrap = bootIds.length > 0 || logIds.length > 0;
    return {
      idsMostRecentFirst: merged,
      has: (id) => set.has(id),
      knownBootstrap,
    };
  }

  /**
   * Scan the agent's derived session log (user + tool roles) for ct-fact
   * markers, newest message first. The agent handle is registered per turn by
   * the index.ts listeners; a session we never saw is an empty ledger.
   */
  private sessionLogIds(session: SessionRef): string[] {
    const messages = this.sessionMessages.get(session.id);
    if (messages === undefined) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const id of messageIds(messages[i])) {
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
    return out;
  }

  /** Registered per-agent derived-log snapshots (set through snapshotMessages). */
  sessionMessages: Map<string, unknown[]> = new Map();

  /**
   * Publish an agent's derived session log (what the next ledger rebuild
   * reads). The ONE place both the user-turn and the activity path record a
   * snapshot: LRU-refreshed, bounded to SNAPSHOTS_MAX agents.
   */
  snapshotMessages(agentId: string, messages: unknown[]): void {
    lruSet(this.sessionMessages, agentId, messages, DshWisdomAdapter.SNAPSHOTS_MAX);
  }

  /** Agents whose derived-log snapshot is kept. */
  static readonly SNAPSHOTS_MAX = 128;

  /** m1: cache the N1 rebuild before any early return. */
  cacheLedger(session: SessionRef, ledger: Ledger): void {
    lruSet(this.turns, session.id, { ledger }, 256);
  }

  /** m2: the N1 rebuild, when this turn produced one. */
  cachedLedger(session: SessionRef): Ledger | null {
    return this.turns.get(session.id)?.ledger ?? null;
  }

  async wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
    budget?: AbortSignal,
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    if (this.capabilityAbsent) return { outcome: 'timeout_or_exit' };
    const { path } = this.discover();
    if (path === null) return { outcome: 'spawn' };
    const signal = this.spawnSignal(budget);
    if (this.probedPath !== path) {
      // Capability gate per the live-delivery spec: `ct wisdom match --help`
      // exits 0 (Hermes ct_wisdom_live.has_match_capability parity), once
      // per accepted path (OpenCode parity): a per-call probe would spend a
      // second spawn out of the same 3 s budget on every query.
      const probe = await this.spawnFn({
        command: path,
        args: ['wisdom', 'match', '--help'],
        timeoutMs: 3000,
        ...(signal ? { signal } : {}),
      });
      if (probe.spawnError) return { outcome: 'spawn' };
      // A probe that passed is cached even if an abort lands right after it.
      const passed = probe.aborted !== true && !probe.timedOut && probe.code === 0;
      if (passed) this.probedPath = path;
      // Aborted mid-probe (the activity budget ran out, or the plan was
      // cancelled): decide nothing about the capability.
      if (probe.aborted === true || signal?.aborted) return { outcome: 'aborted' };
      // A slow probe is a CT failure the breaker counts, never `spawn`: a
      // spawn-class reset re-runs discovery's blocking walk, so a slow ct
      // would stall every step without ever pausing.
      if (probe.timedOut) return { outcome: 'timeout_or_exit' };
      if (!passed) {
        // Deterministic absence of the subcommand: latch OFF for the process
        // (n3 retry-next-turn does not apply — the binary answered).
        this.capabilityAbsent = true;
        return { outcome: 'timeout_or_exit' };
      }
    }
    const res = await coreWisdomMatch(path, query, max, exclude, this.spawnFn, signal);
    // Cancelled (the host charged the budget miss itself at expiry): a kill
    // that surfaces as a timeout or exit is that same miss, not a second
    // CT failure.
    if (signal?.aborted && res.outcome === 'timeout_or_exit') return { outcome: 'aborted' };
    // A failed match re-probes on the next call: a ct that lost `wisdom
    // match` in place (a downgrade at the same path) then latches quietly
    // instead of charging the breaker on every query. This failure itself
    // still counts once: an exit code cannot tell "unknown command" from
    // any other usage error reliably.
    if (res.outcome === 'timeout_or_exit') this.probedPath = null;
    return res;
  }

  /**
   * Host-side cancels (activity.ts: a plan whose slot was replaced or
   * evicted, a turn the host would not extend, the budget expiry), keyed by
   * the signal the core passes to `wisdomMatch`. A cancel kills the child,
   * but the core sees its own signal still un-aborted, so the outcome is
   * `aborted` and never a breaker failure on its own.
   *
   * This side channel depends on ct-wisdom-core handing `wisdomMatch` the
   * SAME AbortSignal object the host gave `startActivity` (runActivityMatch
   * passes it through untouched). If the core ever wraps or replaces that
   * signal, the lookup misses and a cancel stops killing the child; the
   * host test "a host cancel linked to the budget signal kills the child"
   * catches that. The clean fix is a `cancel` parameter in the core.
   */
  private readonly cancels = new WeakMap<AbortSignal, AbortSignal>();

  /** Link a host cancel signal to the signal handed to the core. */
  linkCancel(budget: AbortSignal, cancel: AbortSignal): void {
    this.cancels.set(budget, cancel);
  }

  private spawnSignal(budget?: AbortSignal): AbortSignal | undefined {
    if (budget === undefined) return undefined;
    const cancel = this.cancels.get(budget);
    return cancel === undefined ? budget : AbortSignal.any([budget, cancel]);
  }

  /** m4: N3 fires on the CT recall surface only, never get_wiki_entry. */
  isCtRecallResult(result: unknown): boolean {
    return parseEnvelope(result) !== null;
  }

  /** Fact ids carried by a recall envelope (empty on malformed). */
  envelopeFactIds(result: unknown): string[] {
    const parsed = parseEnvelope(result);
    if (parsed === null) return [];
    const ids: string[] = [];
    for (const entry of parsed.inner.wiki_entries) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (isValidId(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Reference dedup (ct_tool_dedup.transform_tool_result): stub repeated
   * wiki entries down to one-line stubs (option A), then append a
   * `ct-fact:<id>` trailer line for every NEW id — envelope JSON first,
   * one trailer line per new id after it, exactly as the reference writes
   * `outer['result'] = json.dumps(inner) + trailer`. The persisted tool
   * result then carries the markers the next ledger scan picks up. Other
   * outer keys (`structuredContent`, ...) pass through verbatim; the
   * returned object replaces the result's `value` and its content blocks
   * are rebuilt by the caller (postExecute).
   */
  rewriteEnvelopeStub(result: unknown, repeats: string[], newIds: string[]): unknown {
    const parsed = parseEnvelope(result);
    if (parsed === null) return result;
    const stubs = new Set(repeats);
    parsed.inner.wiki_entries = parsed.inner.wiki_entries.map((entry) => {
      const id = (entry as { id?: unknown } | null)?.id;
      return isValidId(id) && stubs.has(id) ? stubEntry(id) : entry;
    });
    const trailer = newIds.map((id) => `\n${marker(id)}`).join('');
    return { ...parsed.outer, result: JSON.stringify(parsed.inner) + trailer };
  }

  /**
   * n3 (the core calls this on a spawn-class outcome): drop the capability
   * latch, the probe cache and discovery's accepted path, so a ct that moved
   * mid-process is found again (OpenCode parity).
   */
  resetDiscoveryAndProbeCaches(): void {
    this.capabilityAbsent = false;
    this.probedPath = null;
    try {
      this.invalidateDiscovery();
    } catch {
      /* fail quietly */
    }
  }

  wisdomMatchAbsent(): boolean {
    return this.capabilityAbsent;
  }

  /**
   * N2 delivery: the BLOCK text is returned to index.ts (which builds the
   * pre-step message); here we only record the memo's delivered ids so the
   * ledger can find them even if the host never persisted our message
   * (fail-open bookkeeping — the session-log scan stays authoritative).
   */
  deliver(_session: SessionRef, _block: string): void {
    // No host-side write: the N2 channel is the returned block itself.
  }

  noteDelivered(session: SessionRef, ids: string[]): void {
    const rec = this.bootstrapMemo[session.id];
    if (rec) {
      for (const id of ids) if (!rec.ids.includes(id)) rec.ids.push(id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// N1 / N3 entry points for index.ts (thin wrappers around the core so the
// adapter + Breaker pairing lives in one place).
// ─────────────────────────────────────────────────────────────────────────

export { coreOnUserTurn as runUserTurn, coreOnToolResult as runToolResult };
