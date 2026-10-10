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
  marker,
  onToolResult as coreOnToolResult,
  onUserTurn as coreOnUserTurn,
  wisdomMatch as coreWisdomMatch,
  type HostAdapter,
  type Ledger,
  type MatchOutcome,
  type SessionRef,
  type SpawnFn,
  type WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import { spawn } from 'node:child_process';
import { discoverCt } from '../wisdom.js';

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
// maxBuffer, cwd home, no shell, windowsHide).
// ─────────────────────────────────────────────────────────────────────────

export function nodeSpawnFn(env: NodeJS.ProcessEnv = process.env): SpawnFn {
  return (spec) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args, {
          killSignal: 'SIGKILL' as NodeJS.Signals,
          cwd: env.HOME || env.USERPROFILE || '.',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          // Process-group leader (POSIX): the timeout kill takes the whole
          // tree down. Without it a `sh -c <tool>` wrapper survives as a
          // grandchild holding the stdio pipes open and 'close' never fires
          // — the 3 s budget would leak a 30 s hang. windowsHide covers the
          // console flash on Windows; detached there is a no-op for kill.
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
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the whole process group (negative pid); fall back to the
        // direct child when the group is already gone or on Windows.
        if (child.pid !== undefined && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      }, spec.timeoutMs);
      const finish = (code: number | null, spawnError: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, spawnError: spawnError || overflow, timedOut });
      };
      child.on('error', () => finish(null, true));
      const killTree = (): void => {
        if (child.pid !== undefined && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            /* group gone — fall through to the direct kill */
          }
        }
        child.kill('SIGKILL');
      };
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

/** Inner wiki-entry envelope: the parsed shape N3 reads and rewrites. */
interface InnerEnvelope {
  wiki_entries: Array<Record<string, unknown>>;
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
  return {
    outer,
    inner: { wiki_entries: obj.wiki_entries as Array<Record<string, unknown>> },
  };
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
  private readonly turns = new Map<string, TurnState>();
  private capabilityAbsent = false;

  constructor(deps: AdapterDeps) {
    this.env = deps.env;
    this.spawnFn = deps.spawnFn ?? nodeSpawnFn(deps.env);
    this.discover = deps.discover ?? (() => discoverCt(deps.env));
    this.now = deps.now ?? (() => Date.now());
  }

  /** TEST-ONLY: drop all turn caches. */
  _resetForTests(): void {
    this.turns.clear();
    this.capabilityAbsent = false;
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
      liveDeliveredCount: this.liveDeliveredCount(session, set),
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
      const msg = messages[i] as {
        role?: unknown;
        content?: unknown;
      };
      if (msg === null || typeof msg !== 'object') continue;
      const role = msg.role;
      if (role !== 'user' && role !== 'tool') continue; // N4 scan roles
      for (const text of blockTexts(msg.content)) {
        const re = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            out.push(m[1]);
          }
        }
      }
    }
    return out;
  }

  /**
   * M1 live budget: count distinct ids delivered via the LIVE path — markers
   * on USER-role messages of the session log (the N2 channel), same rule as
   * the Hermes reference and the core's SimHost.
   */
  private liveDeliveredCount(session: SessionRef, known: Set<string>): number {
    const messages = this.sessionMessages.get(session.id);
    if (messages === undefined) return 0;
    const live = new Set<string>();
    for (const msg of messages) {
      const m = msg as { role?: unknown; content?: unknown };
      if (m === null || typeof m !== 'object' || m.role !== 'user') continue;
      for (const text of blockTexts(m.content)) {
        const re = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          if (known.has(match[1])) live.add(match[1]);
        }
      }
    }
    return live.size;
  }

  /** Registered per-agent derived-log snapshots (set by index.ts listeners). */
  sessionMessages: Map<string, unknown[]> = new Map();

  /** m1: cache the N1 rebuild before any early return. */
  cacheLedger(session: SessionRef, ledger: Ledger): void {
    this.turns.set(session.id, { ledger });
    while (this.turns.size > 256) {
      const oldest = this.turns.keys().next();
      if (oldest.done) break;
      this.turns.delete(oldest.value);
    }
  }

  /** m2: the N1 rebuild, when this turn produced one. */
  cachedLedger(session: SessionRef): Ledger | null {
    return this.turns.get(session.id)?.ledger ?? null;
  }

  async wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    if (this.capabilityAbsent) return { outcome: 'timeout_or_exit' };
    const { path } = this.discover();
    if (path === null) return { outcome: 'spawn' };
    const probe = await this.spawnFn({
      command: path,
      // Capability gate per the live-delivery spec: `ct wisdom match --help`
      // exits 0 (Hermes ct_wisdom_live.has_match_capability parity).
      args: ['wisdom', 'match', '--help'],
      timeoutMs: 3000,
    });
    if (probe.spawnError || probe.timedOut) {
      return { outcome: 'spawn' };
    }
    if (probe.code !== 0) {
      // Deterministic absence of the subcommand: latch OFF for the process
      // (n3 retry-next-turn does not apply — the binary answered).
      this.capabilityAbsent = true;
      return { outcome: 'timeout_or_exit' };
    }
    return coreWisdomMatch(path, query, max, exclude, this.spawnFn);
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

  /** n3: a spawn-class failure drops the process capability latch. */
  resetDiscoveryAndProbeCaches(): void {
    this.capabilityAbsent = false;
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
