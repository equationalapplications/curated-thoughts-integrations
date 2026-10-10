# Step-0 critique — GLM re-check (r2), confirmation pass

**Subject:** spec `2026-10-09-cross-harness-wisdom-parity-design.md` Draft rev 2 +
investigation rev 3, reviewed against r1 findings (`step0-critique-glm.md`) and the
shipped reference `integrations/hermes/scripts/ct_wisdom_live.py`.

**Scope:** CONFIRMATION ONLY — verify each r1 finding is resolved in rev 2; flag only
NEW issues introduced by the revision. Adjudicated choices (opencode compaction
carry-forward, claude-code clear empirical rule, three-channel openclaw) not re-litigated.

---

## r1 findings — resolution status

| # | r1 finding | Status | Why |
|---|---|---|---|
| 1 | OpenCode wire-only N2 vs N4 ledger contradiction (BLOCKER) | **RESOLVED** | Investigation decision 3 + spec decision 3: `chat.message` persisted append chosen; `messages.transform` explicitly REJECTED; ledger derives from persisted history via `client.session.messages()` — the two cells now cohere. |
| 2 | OpenClaw language decision contradicted evidence (BLOCKER) | **RESOLVED** | Decision 1 splits stacks: TS for DSH/OpenCode/OpenClaw with the stale `language: python` manifest flipped in-PR; Python only where shell-command hooks genuinely work (claude-code, importing the Hermes core directly). Sharing is concretized (`ct-wisdom-core` package). |
| 3 | DSH N2/N3 [V] overstated persistence/registration | **RESOLVED** | Closed by verification, not downgrade: `host-dsh-semantics.md` addendum verifies verbatim `step()` append to the session log and `tools/post-execute` as a CORE event with MCP routing through the harness ToolRuntime; verdict cells now say "PERSISTED [V at pin]" / "CORE event [V at pin]". |
| 4 | CC trigger semantics + subagent double-delivery absent | **RESOLVED** | Decision 4a (provenance filter, fail-safe skip), 4b (main-thread only), 4e (double-delivery named risk); present in both investigation and spec, plus AC coverage. |
| 5 | OpenClaw N2 cache placement [V] while unverified | **RESOLVED** | Decision 5 splits mechanism [V] / cache placement [C — raw-stream gate], ships the claim conditional, and defines the resolution path (pre-merge by default; defer-and-accept default post-merge), with AC 9 as the enforcement. |
| 6 | Verdict column untagged while inputs are [C] | **RESOLVED** | Rev 3 verdict table carries confidence + named conditions per row; OpenCode scope stated honestly ("largest scope … all greenfield, medium confidence"); CC resume choice made explicitly (true fail-closed, no re-arm; transcript-derived recovery = tracked follow-up). |
| 7 | Exactly-once test defined only for Hermes | **RESOLVED** | Decision 6: randomized multi-channel exactly-once test (incl. compaction + restore) is an acceptance criterion per host (spec AC 2); OpenClaw host guarantee rescoped to the durable-injection channel only. |
| 8 | Release decision punted | **RESOLVED** | Decision 7 is explicit: `deepseek-v0.3.1` / `opencode-v0.1.1` never tagged; bumps 0.4.0 / 0.2.0 with folded changelogs; full post-merge tag list given. (Spec delta amends claude-code to 0.1.1→0.2.0 — documented, consistent with the re-base.) |
| 9 | CI stub-host contract hole; no verification table | **RESOLVED** | Decision 8 gives the per-host verification table (CI tier / pre-merge e2e / post-merge tracking) and PR-internal ordering (DSH → OpenCode → CC → OpenClaw); decision 10 documents the weaker shape-level contracts for CC/OpenClaw in ci.yml. |
| 10 | Freshness doc's OpenCode verdict never annulled | **RESOLVED** | Supersession annotation added (investigation method item 4) and freshness-doc annotations are PR deliverable 1. |
| 11 | Pre-spec vs deferred split wrong for three items | **RESOLVED** | "Resolve-before-spec — ALL CLOSED" section: DSH semantics verified by tarball reads, cache path decided; `updatedToolOutput` replay handled design-fail-closed (ledger never depends on rewrites); `allowManagedHooksOnly` in README decision 9. |
| 12 | compatibility.json pin bumps undecided | **RESOLVED** | Decision 2: DSH pin → 0.2.0-rc.2, opencode pin → 1.18.35 (with the byte-identical justification). |
| 13 | OpenClaw runtime matrix + permission gates missing | **RESOLVED** | Decision 9: README matrix states per-runtime support (embedded/CLI v1; Codex/Copilot degraded/unsupported), install-time permission gates (`allowConversationAccess`, prompt-injection not disabled) + timeout requirements. |

**All 13 r1 findings RESOLVED.**

---

## NEW findings (introduced by the revision)

### N-1. MINOR — Annex A's generic fail-closed line cannot directly express CC decision 4d (resume ⇒ OFF-for-life)

**Where:** Annex A `on user_turn`: `if host.restored(session) and not ledger.known_bootstrap: return`
vs decision 4d / A.1 CC row: "`SessionStart(source=resume)` marks the session
live-delivery-OFF for its entire life; NO re-arm path".

**Problem:** The annex gates fail-closed on `restored AND not known_bootstrap`. Under
the CC design, a resumed session's `${CLAUDE_PLUGIN_DATA}` store is on disk keyed by a
surviving session id and the session-start extension seeds bootstrap ids into it
(N5 scope table) — so `known_bootstrap` is True on exactly the sessions 4d wants
OFF. Implementing 4d inside the annex as written requires the CC adapter to define
`known_bootstrap` (or `restored`) so that OFF-marked sessions report unknown — a
semantic overload the annex doesn't state. The compact-continues rule (M2) shares the
same store and must NOT trip the gate, so the distinguishing signal is SessionStart
source, which the annex formula never sees.

**Fix (one line):** add a host gate ahead of the fail-closed check, e.g.
`if not host.delivery_enabled(session): return` (CC: False on resume-marked and
clear-OFF sessions; Hermes/DSH/OpenCode/OpenClaw: always True), or state in A.1 that
CC's `host.restored()` returns True for the whole life of a resume-marked session and
that this check precedes the bootstrap conjunct. No behavior change on any other host;
purely makes the normative pseudocode implementable for the CC leg without redefining
`known_bootstrap`.

No other new issues found: the annex constants, M1 `--max 0` corrections-only rule,
and m8 newest-first exclusion ordering all match the shipped `ct_wisdom_live.py`
(L374 max_n computation; `ct_ledger.history_ids` documented most-recent-first); the M2
SessionStart matcher claim matches the shipped `hooks.json`
(`startup|resume|clear|compact`); the claude-code release-matrix delta matches the
shipped manifest (v0.1.1, `status: implemented`).

---

## Verdict

**LOOP CONVERGED.** All 13 r1 findings resolved in rev 2; the single new finding is
MINOR (one-line annex clarification, no design change) — no new MAJOR issues.
