# Step-0 critique — GLM 5.3 first-pass critic

**Subject:** `step0-investigation-parity.md` (2026-10-09), reviewed against all five
evidence files and the directive (one PR: spec+plan+impl; parity of DSH, OpenClaw,
Claude Code + OpenCode with Hermes live delivery; releases for all; README +
Intuitive Wisdom section; DRAFT until implemented).

**Severity scale:** blocker = must fix before spec-writing; major = spec author
will be blocked or misled without it; minor = accuracy/hygiene.

---

## Findings

### 1. BLOCKER — OpenCode row is internally contradictory: wire-only N2 cannot feed the N4 ledger

**Where:** Verdict table, OpenCode row (N2 cell: "`experimental.chat.messages.transform`
(wire-only, structuredClone)"; N4 cell: "`client.session.messages()`; compaction ctx
injection").

**Problem:** The recheck (`host-opencode-recheck.md`) is explicit: `messages.transform`
receives a `structuredClone`, so mutations do **not** persist (prompt.ts:1255 vs
persistence at 1046–1047). `client.session.messages()` reads **persisted** history.
If live delivery is injected through the wire-only channel, the facts are invisible
to the ledger-rebuild source, and exactly-once (INTENT Rule 1) is structurally
broken on OpenCode: every LLM call re-appends, nothing records it. If instead
delivery goes through persisted `chat.message` mutations, then N2's "cache-safe /
wire-only" property is abandoned. The two cells describe a design that cannot
coexist; the investigation never chooses a channel.

**Fix:** Add an explicit decision: which OpenCode channel carries delivery
(persisted `chat.message` synthetic part vs wire-only `messages.transform`), and
derive the ledger source from that choice — persisted channel ⇒ `client.session.messages()`
works; wire-only channel ⇒ the plugin must persist its own delivery record (and
the doc must say where). The recheck's own residual-risk section already frames
this tradeoff; the investigation dropped it.

### 2. BLOCKER — Decision #1 contradicts the OpenClaw evidence on language stack

**Where:** "Decisions this investigation forces" #1: "Python for the two new
integrations **per their manifests**".

**Problem:** The authority cited (placeholder `integration.yaml` files with
`language: python`, written before any host investigation) is directly contradicted
by `host-openclaw.md`, which verifies the OpenClaw plugin surface is **TypeScript
ESM** (`definePluginEntry({ register(api) })`, manifest `contracts`,
`registerAgentToolResultMiddleware` — TS APIs throughout, §"Proposed integration
shape" says so explicitly). Claude Code hooks are shell-command handlers (JSON on
stdin), where Python genuinely works; OpenClaw's does not. The "per their
manifests" justification is circular — the manifests predate the evidence.

**Fix:** Split decision #1: Claude Code adapter in Python (as manifested);
OpenClaw adapter in TypeScript, with the `integration.yaml` `language:` field
corrected in the PR. Shared "algorithm" logic is now three stacks (Python, DSH/OpenCode
TS, OpenClaw TS), not two — the spec must say how much is truly shared vs ported
thrice.

### 3. MAJOR — DSH N2/N3 cells marked [V] overstate what was verified

**Where:** Verdict table, DSH row (N2 "pre-step message replacement [V]"; N3
"`tools/post-execute` (transform + additionalContexts) [V]").

**Problem:** `host-dsh-opencode-freshness.md` verifies (a) that `agent/pre-step`
exists and its `PreStepDecision` can **replace the entering messages**, and (b) that
the `dsh-hooks-codex` **reference bridge** wires `PostToolUse` → `tools/post-execute`.
What is *not* verified: whether the pre-step message append is **persisted in the
session log or wire-only** — the exact N2 property the whole ledger design depends
on (same trap as Finding 1); and whether a DSH-native plugin can register
`tools/post-execute` directly, or whether N3 requires depending on the Codex
compatibility bridge. Both are tarball-derivable design-time facts, yet the row
presents the capability as fully verified.

**Fix:** Downgrade both cells or add the missing verification: grep the
0.2.x tarballs for pre-step append persistence semantics and for whether
`tools/post-execute` is a documented core plugin event vs bridge-internal. This
belongs in the pre-spec pass, not implementation-phase e2e (see Finding 11).

### 4. MAJOR — Claude Code trigger semantics: `UserPromptSubmit` fires on non-user turns; subagent double-delivery absent from Risks

**Where:** Verdict table CC N1 ("`UserPromptSubmit` (prompt text; 30 s fail-open)");
Risks section (no mention of either).

**Problem:** `host-claude-code.md` §N1 states [V] that the hook also fires on
scheduled tasks, background-subagent reports, and cross-session messages — there is
no `ctx.trigger === "user"`-style gate documented. It also states [V] that hooks run
inside subagents, and flags [C] the need to dedupe/filter subagent deliveries.
Unfiltered, CT would (a) spend live-delivery budget and session caps on
non-user turns, and (b) count a fact delivered in both main thread and subagent
twice — or stub it inconsistently across two ledgers. Both directly attack INTENT
Rules 1 and 6. Neither requirement appears anywhere in the investigation.

**Fix:** Add to decisions: a trigger filter (inspect hook input for
user-turn provenance; fail-safe default = skip when provenance is unclear) and a
subagent policy (deliver in main thread only, or dedupe via shared
`${CLAUDE_PLUGIN_DATA}` ledger). Add subagent double-delivery to Risks.

### 5. MAJOR — OpenClaw N2 marked [V] while cache placement is explicitly unverified; INTENT Rule 2 hinges on it

**Where:** Verdict table OpenClaw N2 ("prepend/appendContext + enqueueNextTurnInjection
(durable, exactly-once) [V]").

**Problem:** The evidence doc tags the cache-safety question itself [C] and says
the wire placement of `prependContext` relative to provider prompt-cache prefix is
**unspecified** and must be verified with a `--raw-stream` capture "before relying
on prefix-cache behavior" — and it is in the NOT CHECKED list of both the evidence
doc and the investigation. [V] legitimately covers "the mechanism exists", but a
reader of the verdict table will conclude N2 is satisfied; the sharpest stated
failure mode (cache invariant, INTENT Rule 2) is exactly what's unproven here.

**Fix:** Split the cell: mechanism [V] / cache-placement [C — requires raw-stream
test]. Decide pre-spec whether (a) a live OpenClaw runtime test is budgeted before
implementation, or (b) the spec ships OpenClaw delivery with cache-safety claimed
conditionally and verified as an implementation-phase gate. Option (b) must be
stated as a risk, not implied.

### 6. MAJOR — Verdict-table honesty: "Parity verdict" column is untagged while its inputs are [C]

**Where:** Verdict table, last column ("full port feasible" ×2, "full integration
feasible" ×2).

**Problem:** Three of four rows rest on [C] cells (OpenCode N5, CC N4-resume +
N5, OpenClaw N5), and two carry named caveats in the same row — yet the verdict
column issues unqualified "full" verdicts with no confidence level. Two specific
overstatements:
- **OpenCode "full port feasible":** the survey records OpenCode has **no v1
  bootstrap auto-inclusion at all** ("Bootstrap auto-inclusion (v1): NO [V]") and no
  wisdom module. This is the largest scope of any host — bootstrap *and* live
  delivery *and* N5 self-tracking are all greenfield — yet the row reads like the
  cheapest one.
- **Claude Code "full integration feasible":** the fail-closed-restore rule means
  live delivery silently dies on every `--resume` (the dominant CC usage pattern).
  The evidence doc suggests a `transcript_path`-content restore path [C] as an
  alternative; the investigation flattens this to "fail-closed" without weighing the
  behavioral cost or choosing.

**Fix:** Tag the verdict column with confidence + conditions (e.g. "feasible,
medium confidence — conditional on channel decision (F1), cache test (F5), resume
id stability"). State the OpenCode scope honestly (v1 bootstrap included). For CC,
make the restore-semantics choice explicit: fail-closed (accept dead live delivery
post-resume) vs transcript-derived bootstrap-id recovery.

### 7. MAJOR — Exactly-once across five hosts: the acceptance test is defined only for Hermes

**Where:** Risks section; Decisions #1.

**Problem:** The survey documents the only existing guarantee: Hermes'
`test_exactly_once.py` (200 randomized sessions asserting no fact appears twice
across system block + user messages + tool results). Decision #1 ports the
algorithm "faithfully" to three stacks, but nothing requires the randomized
exactly-once test per host — and per-host reality makes copy-paste insufficient:
OpenClaw's "exactly-once" [V] in the verdict table is a **host guarantee for
`enqueueNextTurnInjection` only**, not for the feature (in-turn `prependContext`,
tool middleware, and durable injections are three channels whose interplay the
plugin must dedupe itself); OpenCode has the persisted-vs-wire split (Finding 1);
CC has subagents and replay (Finding 4). A reader could conclude the OpenClaw row's
"exactly-once" means the invariant holds there.

**Fix:** Add a decision: per-host randomized exactly-once test (multi-channel,
including compaction and restore paths) is an acceptance criterion for every host,
adapted to each host's channels. Reword the OpenClaw N2 cell to scope the host
exactly-once guarantee to the durable-injection channel.

### 8. MAJOR — Release decision is punted, not made; deepseek/opencode version path ambiguous

**Where:** Decision #5: "deepseek 0.3.1 / opencode 0.1.1 bumps ride the PR (next
version supersedes)."

**Problem:** The survey explicitly names this as an **open decision** (Gaps #6:
"will likely need to decide whether to ride the pending bumps or cut releases
first"). The investigation doesn't decide it — it gestures. Concrete ambiguity the
spec author hits immediately: `ct_ci_policy.gate_versions` requires a SemVer bump
vs base ref + CHANGELOG section for material changes. If the parity PR adds live
delivery to deepseek, the manifest version must bump again (0.4.0?) — so does
0.3.1 ever get a release tag, or is it superseded inside the same PR? Same for
opencode 0.1.1. "Releases for all" (directive) then means: which tag set exactly,
and does `deepseek-v0.3.1` exist or not?

**Fix:** Replace with an explicit decision, e.g.: "0.3.1/0.1.1 never get release
tags; the parity PR bumps deepseek → 0.4.0 and opencode → 0.2.0 with combined
changelogs; post-merge tags are deepseek-v0.4.0, opencode-v0.2.0,
claude-code-v0.1.0, openclaw-v0.1.0." Any consistent answer works; the absence of
one doesn't.

### 9. MAJOR — CI stub-host contract cost is a decision-shaped hole, and two greenfield hosts have no contract harness at all

**Where:** Decision #7; Risks ("e2e verification matrices and doctor parity are
scope, not afterthoughts").

**Problem:** Decision #7 says contracts "must be defined" but neither defines nor
schedules them, and the risk list doesn't price the asymmetry: Hermes' check works
because the host is importable in CI; opencode has a real-binary harness to extend
(cheap); but **Claude Code and OpenClaw have no in-repo harness, no local checkout
evidence, and (for OpenClaw) no install story in CI at all** — the OpenClaw
evidence doc confirms nothing was ever executed against a real gateway. "Stub-host
contract" for a host you cannot instantiate means the contract test verifies only
manifest/registration shape, which is much weaker than the Hermes pattern the doc
cites as "the pattern". The spec's verification strategy per host is currently
unwritable from this doc.

**Fix:** Add a per-host verification decision table: what CI can prove per host
(stub contract / real-binary contract / nothing beyond unit tests), what e2e is
required pre-merge vs post-merge-tracked, and whether a live OpenClaw/Claude Code
environment is available to Kurt for acceptance. Also state ordering: which hosts'
implementation lands first in the DRAFT PR (recommended: DSH + OpenCode first —
existing test harnesses; greenfield hosts second).

### 10. MINOR — The freshness doc's own OpenCode verdict line contradicts the recheck and is never annulled

**Where:** Method item 5 ("flips the survey's 'structurally impossible' verdict")
vs `host-dsh-opencode-freshness.md` Verdicts: "**OpenCode:** still structural NO
for versions ≥ pin".

**Problem:** The two evidence docs carry opposite headline verdicts for the same
host. Close reading shows the freshness doc means "no *newer version* changes the
surface" while the recheck means "the surface at the pin already suffices" — but
the freshness doc's "still structural NO" wording was written before/without the
recheck's mutation-mechanism analysis and is exactly the kind of stale headline
that already caused the DSH error this investigation had to correct. The
investigation cites the recheck as authoritative but never marks the freshness
doc's OpenCode verdict superseded.

**Fix:** One sentence in the investigation (and ideally an annotation in the
freshness doc): "the freshness doc's 'structural NO' for OpenCode is superseded by
the recheck — the pin *note* understated 1.18.31's own surface; no newer version
changes it."

### 11. MINOR — Pre-spec vs deferred split in NOT CHECKED is wrong for three items

**Where:** "NOT CHECKED (deferred, tracked for review)".

**Problem:** Live e2e for DSH/OpenCode adapters is legitimately deferrable.
But three items are design-time inputs the spec cannot be written without, mislabeled
as deferrable or absent from the list entirely:
- DSH pre-step append **persistence semantics** (Finding 3 — tarball-derivable now);
- DSH N3 **registration path** (core event vs codex bridge — tarball-derivable now);
- OpenClaw `prependContext` **cache placement** (Finding 5 — needs a decision on
  how/when it gets resolved, even if the test itself is later).
Also absent from the list though the evidence flags them: CC `updatedToolOutput`
replay persistence (design fail-closed: derive ledger from `transcript_path`
rather than assuming replay), and CC enterprise `allowManagedHooksOnly` (a
deployment-availability caveat that belongs in the README's degradation paths).

**Fix:** Move the three design-time items into a "resolve before spec" subsection
with an owner and method (tarball grep / raw-stream capture); keep genuinely
empirical items (resume id stability, live gateway behavior) deferred.

### 12. MINOR — Compatibility.json pin bumps not decided

**Where:** Decisions #2, #5; freshness doc Registry state.

**Problem:** Pins are demonstrably stale (DSH 0.1.5-rc.2 vs npm latest 0.2.0-rc.2;
opencode 1.18.31 vs 1.18.35) and the DSH pin's `compatibility.json` note is one of
the two artifacts Decision #2 corrects — but the correction stops at the prose
note. No decision records *what the new pins are*, even though the freshness
evidence supports them (hook surfaces identical across the ranges, so pin latest:
DSH 0.2.0-rc.2 — itself a pre-release, consistent with prior practice — and
opencode 1.18.35). CI policy validates generated compat constants, so this will
block the PR if left implicit.

**Fix:** Extend Decision #2: update the DSH pin and its note in the same PR;
add a decision pinning opencode → 1.18.35 (or justify staying at 1.18.31).

### 13. MINOR — OpenClaw scope: runtime targeting and permission gates not carried into decisions/README scope

**Where:** Verdict table OpenClaw row; Decision #6.

**Problem:** The evidence doc is emphatic that hook coverage is fullest on
embedded/CLI runners and that Codex/Copilot omit `agent_turn_prepare`, injection
draining, and reliable `before_agent_run`; also that two operator permission gates
(`allowConversationAccess: true`, `allowPromptInjection` must not be false) are
required, plus timeout configuration. None of this reaches the investigation's
decisions or the README decision (#6), yet it defines the support matrix the README
section must publish and the compatibility claims the integration may make.

**Fix:** Add to Decision #6: README matrix must state per-runtime support
(embedded/CLI supported; Codex/Copilot degraded/unsupported) and the install-time
permission/timeout requirements.

---

## Pre-spec blockers summary (must resolve before spec-writing, per directive)

1. OpenCode delivery-channel choice and its ledger source (Finding 1) — pure design
   decision; nothing left to research.
2. OpenClaw implementation language + manifest `language:` correction (Finding 2).
3. DSH pre-step persistence semantics and N3 registration path (Findings 3, 11) —
   resolvable by tarball grep today.
4. Claude Code trigger filtering + subagent policy + resume-restore semantics
   choice (Findings 4, 6).
5. OpenClaw cache-placement resolution path: budget a live test or ship the claim
   conditional (Finding 5).
6. Release/version matrix (Finding 8) and per-host verification strategy +
   PR-internal ordering (Finding 9).

## Overall verdict: **NEEDS REVISION**

The investigation's evidence-gathering is strong — the DSH correction and the
OpenCode flip are well-supported, and the N1–N5 framing is sound. But the doc
converts evidence into decisions faster than the evidence supports: one internally
contradictory verdict row (OpenCode), one decision grounded in a pre-evidence
artifact against the verified host surface (OpenClaw language), a verdict column
that omits confidence precisely where its inputs are [C], and six design decisions
the spec author cannot proceed without (channel choice, language, DSH semantics,
CC policies, cache test plan, version/verification matrix). All are fixable
without new investigation except the OpenClaw live capture, which needs an
explicit resolution decision. Revise, then proceed to spec.
