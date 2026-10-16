# Intuitive Wisdom verbose mode — design

**Date:** 2026-10-16 · **Status:** Draft (autonomous brainstorm; the user's goal is
stated, no open questions) · **Branch:** `feat/wisdom-verbose-mode` · **Base:**
`origin/main` @ `38437e6`
**Builds on:** [`2026-10-06-intuitive-wisdom-live-delivery-design.md`](2026-10-06-intuitive-wisdom-live-delivery-design.md),
[`2026-10-09-cross-harness-wisdom-parity-design.md`](2026-10-09-cross-harness-wisdom-parity-design.md)
and the three 2026-10-16 leg specs (Claude Code, OpenCode, OpenClaw).

## Goal

The user's words: *"a 'verbose mode' which will print to me somehow the wisdom
context that is being automatically added in my message thread if possible, and
in the log."* They will dogfood Intuitive Wisdom with it and suggest refinements
to CT's gate thresholds, the block sizes and matching quality. So verbose mode
must show:

1. **what was delivered** on a turn: the exact block, its fact ids, titles,
   provenance and CT's scores; and
2. **why nothing was delivered** on a turn that delivered nothing: no match,
   an uncalibrated gate, every match already in context (deduped), the block
   budget, the breaker, a timeout, and so on. These reasons are what make
   tuning possible.

## Decisions

### D1. One opt-in switch, off by default

`CT_WISDOM_VERBOSE=1` turns verbose mode on, on every host. Accepted values
(case-insensitive): `1`, `true`, `yes`, `on`. Anything else, or unset, is off.
There is no host config key in this version: every host already passes the
process environment to the plugin, and one switch is easier to document than
five. A config key can be added later per host without changing the event
format.

`CT_WISDOM_VERBOSE_LOG=<path>` optionally overrides the log file (D4). It is
read only when verbose mode is on.

**Off means identical.** With verbose off, the code path is the same as
before this change: the recorder returns before doing any work, nothing is
written, no host API is called, and every hook returns the same value it
returned before. Tests prove this per host (D8).

### D2. Verbose output never reaches the model (INTENT rule 2)

Verbose output goes only to (a) a host channel that the user sees and the
model does not, and (b) a local log file. It never changes the system prompt,
the delivered block, or any tool result. Each host's channel is checked
against the pinned host source in the table below. Where no such channel is
verified, the host uses the log only.

### D3. Per-host user-visible channel

Tags: **[V]** verified in this session by reading the cited pinned source or
docs; **[U]** unverified, to confirm live.

| Host | What the user sees | Where | Model-visible? | Evidence |
|---|---|---|---|---|
| Hermes | One `[curated-thoughts] wisdom …` summary line per turn, followed by the delivered block, written to **stderr** | the terminal running `hermes` (CLI); the service log for the gateway; the editor's log for ACP | No. Hook stderr is not captured into the conversation. | [V] the host's own plugin debug channel tees plugin logs to stderr (`hermes_cli/plugins.py:90-104`, `HERMES_PLUGINS_DEBUG`, `NousResearch/hermes-agent@ee8dd6c8`). [V] the hooks guide's user-warning example prints from a hook (`website/docs/user-guide/features/hooks.md:617`). stdout is avoided on purpose: [V] Hermes ships an ACP stdio adapter (`acp_adapter/entry.py`), where stdout is the protocol. [U] how the Ink TUI and the gateway display a plugin's stderr. |
| Claude Code | `Curated Thoughts says: …` with the summary and the delivered block, shown in the transcript UI | the hook JSON's top-level `systemMessage` on `UserPromptSubmit` | No. | [V] docs: `systemMessage` is a "Warning message shown to the user" (code.claude.com/docs/en/hooks, JSON output table, fetched 2026-10-16). [V] Claude Code 2.1.301 binary: a `systemMessage` becomes a `hook_system_message` attachment, rendered as `<hookName> says: <content>`, and the attachment-to-API-message table maps `hook_system_message` to `[]` (no model message). `additionalContext` is a separate `hook_additional_context` attachment, so adding `systemMessage` does not change the context bytes. [U] a live transcript capture with both fields set. |
| DeepSeek Harness | One `wisdom …` info record from the plugin's named logger, with the block | the host's logger exporters (`ctx.logger('curated-thoughts')`) | No. Only the pre-step decision's `messages` enter the session. | [V] `ctx.logger(name)` returns a named logger with `info/warn/debug/error` (`@deepseek-ai/cordis@4.0.4` `lib/types/context.d.ts:26-27`, `logger.d.ts`). [U] where DSH 0.2.0-rc.2 renders logger records in its TUI and in headless runs. |
| OpenCode | A TUI toast: `CT wisdom: delivered 2 (412 chars): <titles>` or `CT wisdom: none (deduped)` | `client.tui.showToast` | No. Toasts are TUI events, not session parts. | [V] `tui.showToast({ body: { title?, message, variant, duration? } })` in `@opencode-ai/sdk@1.18.35` (`dist/gen/sdk.gen.d.ts:361-364`, `dist/gen/types.gen.d.ts:3264-3273`). [U] behavior under `opencode run` (no TUI attached): the call is fire-and-forget and its failure is swallowed. |
| OpenClaw | One `wisdom …` info line from the plugin logger, with the block | the gateway log: `openclaw logs --follow`, or `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | No. Only `prependContext` / `prependSystemContext` reach the prompt. | [V] `api.logger` is a scoped `PluginLogger` (`debug`, `info`, `warn`, `error`) (openclaw@2026.10.3 `docs/plugins/sdk-runtime.md:420-422`, `docs/plugins/sdk-overview.md:93`). [V] the gateway's rolling log file and `openclaw logs --follow` (`docs/logging.md:20-27`, `docs/help/faq.md:59-63`). The plugin's chat reply is **not** used: a `message_sending` edit would land in the assistant history the model reads back. |

OpenClaw's channel is a log rather than the chat itself. That is deliberate:
every in-chat surface OpenClaw offers a plugin either becomes model context or
edits the reply, so the gateway log is the closest user-visible channel that
keeps rule 2.

### D4. The log: one JSON Lines file per host

| Host | Default log path |
|---|---|
| Hermes | `$HERMES_HOME/logs/ct-wisdom-verbose.jsonl` (Hermes home from `hermes_constants.get_hermes_home()` when importable [V `hermes_constants.py:111`], else `$HERMES_HOME`, else `~/.hermes`); the `logs/*.jsonl` convention follows the hooks guide [V `hooks.md:161`] |
| Claude Code | `${CLAUDE_PLUGIN_DATA}/wisdom/ct-wisdom-verbose.jsonl`, next to the session store the plugin already keeps there. Without `CLAUDE_PLUGIN_DATA` live delivery is already off; the `systemMessage` still shows. |
| DeepSeek Harness | `$DSH_HOME/logs/ct-wisdom-verbose.jsonl`, default `~/.dsh/logs/…` (the home rule of `@deepseek-ai/dsh-home-paths@0.2.0-rc.2` `resolveDshHome`: `$DSH_HOME`, blank treated as unset, then `~/.dsh` [V `lib/types/index.d.ts`]) |
| OpenCode | `$XDG_DATA_HOME/opencode/log/ct-wisdom-verbose.jsonl`, default `~/.local/share/opencode/log/…`, OpenCode's own log directory ([V] `packages/core/src/global.ts:11,23` in the OpenCode source at `5a8335857b`; [U] identical at the 1.18.35 pin) |
| OpenClaw | `$OPENCLAW_STATE_DIR/logs/ct-wisdom-verbose.jsonl`, default `~/.openclaw/logs/…` ([V] state dir and its `~` default: `docs/help/environment.md:23,40`) |

`CT_WISDOM_VERBOSE_LOG` overrides every default. A leading `~` is expanded.
The log is the integration's own file (rule 7): nothing is written to the
brain or the vault. The file is append-only; when it grows past 5 MiB it is
renamed to `<file>.1` (one backup, replacing any older one) and a new file
starts.

#### Event schema (version 1)

One JSON object per line:

| Field | Meaning |
|---|---|
| `v` | schema version, `1` |
| `ts` | ISO-8601 UTC timestamp with milliseconds |
| `host` | `hermes`, `claude-code`, `deepseek`, `opencode` or `openclaw` |
| `channel` | the trigger that ran, such as `pre_llm_call`, `UserPromptSubmit`, `agent/pre-step`, `chat.message`, `before_prompt_build` |
| `session_id` | the host session id the ledger is keyed by |
| `event` | `delivery` or `skip` |
| `reason` | `null` for a delivery; otherwise the non-delivery class (below) |
| `query` | the query exactly as CT received it (already truncated to 2000 chars); absent when no query was built |
| `gate` | CT's `gate` field (`semantic-v1:<model>` or `uncalibrated`), when CT answered |
| `matched` | what CT returned: `[{id, kind: "entry"\|"correction", title, text, score, provenance, supersedes, outcome}]` where `outcome` is `delivered`, `in_context`, `budget` or `not_applicable` (a correction for a fact not in context) |
| `delivered_ids` | ids whose marker reached the block |
| `block_chars` / `block` | the delivered block's length and exact text (deliveries only) |
| `ledger_size` | how many fact ids were already in context |

`score` is CT's raw cosine (`entries[].score` in the `ct wisdom match --json`
contract; `null` for corrections) [V `curated-thoughts` `src-tauri/src/wisdom_match.rs:69-86`].
The CT floor itself is not in the output, so the log shows the score and the
gate name, and the floor is read from CT's docs.

**Non-delivery reasons.** The existing failure classes keep their names:
`empty_id`, `restored_unknown_bootstrap`, `breaker_open`, `empty_query`,
`discovery_miss` (and the discovery classes), `probe_timeout`,
`capability_missing`, `timeout`, `spawn`, `exit`, `parse_error`; on Claude Code
also `provenance`, `no_data_dir`, `no_store`, `delivery_off`, `store_changed`.
The TypeScript core reports its coarser classes `no_session`, `delivery_off`,
`restored_unknown_bootstrap`, `capability_missing`, `breaker_open`,
`empty_query`, `timeout_or_exit`, `spawn`. The old catch-all `zero_hits` is
split, for the log only, into:

- `gate_uncalibrated`: CT answered `gate: uncalibrated` and returned nothing;
- `no_match`: CT returned nothing;
- `deduped`: CT returned facts, but every one was already in context;
- `budget`: CT returned facts not in context, but none fit the block (or a
  correction superseded nothing in context).

The debug-log lines the integrations already write keep their current text.

#### What is never logged

No environment variables, keys, tokens, paths from the environment, or
command lines. The only user text is the query in the truncated form CT
receives, which is the user's own message. Event fields are built from an
allowlist; there is no "dump the context" path. A test plants a secret in the
environment and asserts it is absent from the log and the user-visible text.

### D5. Fail quietly (rule 4)

Every recorder entry point catches everything. A failure to format, write the
log, or call the host channel is dropped silently. The recorder runs after the
delivery decision is made and is handed copies, so it cannot change the block
or the ledger. Tests make the recorder's sink and file write raise and assert
the hook returns the same value.

### D6. Code layout and call sites (coordination with autonomous-work delivery)

The parallel autonomous-work PR (`feat/hermes-autonomous-work-wisdom`) edits
`ct_wisdom_live.py` and the tool-result path. To keep the merge trivial:

- **Python:** a new shared module `scripts/ct_wisdom_verbose.py` exposing
  `record_delivery(event, env=None) -> None` and
  `record_non_delivery(event, env=None) -> None`, plus a pluggable notice sink
  (`set_sink`). Hermes uses the default sink (stderr). Claude Code installs a
  collecting sink in `main()` and merges the collected text into the hook
  output's `systemMessage`. The Claude Code copy is byte-identical to the Hermes
  copy and is added to `IDENTICAL` in `tests/tools/test_shared_script_parity.py`.
  A small reader, `scripts/ct_wisdom_log.py`, is shared the same way.
- **Edits to `ct_wisdom_live.py`:** the import; one line in `_skip` (the single
  non-delivery point: it gains `**detail`); the `zero_hits` call passes its
  query, result and ledger; one line before the delivery `return`; and two
  additive lines in `match_wisdom`/`_normalize_item` that keep CT's `gate` and
  `score` when present (render never reads them, so the block bytes are
  unchanged).
- **Hermes autonomous-work hook-up:** the other PR exposes a local no-op
  `_record_activity_delivery`. Whichever PR merges second wires it to
  `ct_wisdom_verbose.record_delivery` / `record_non_delivery` with
  `channel: "activity"` (one line each).
- **TypeScript:** a new core module `packages/ct-wisdom-core/src/verbose.ts`
  (event type, `verboseEnabled`, `createVerboseRecorder`, `formatNotice`,
  `formatLogLine`, JSONL append with rotation) and an optional
  `HostAdapter.recordVerbose?(event)`. `onUserTurn` reports one event at every
  exit, built only when the adapter has a recorder, so hosts without one pay
  nothing. Each adapter sets `recordVerbose` only when verbose is on and wires
  its channel from D3. A tiny reader CLI ships in the core as
  `lib/cli/ct-wisdom-log.js`.

### D7. The reader

`ct_wisdom_log.py` (Hermes, Claude Code) and `ct-wisdom-log.js` (core, so in
every TypeScript payload) print the log in readable form:

```
python3 <plugin>/scripts/ct_wisdom_log.py --host hermes [-n 20] [-f] [--path FILE]
node <plugin>/lib/ct-wisdom-core/cli/ct-wisdom-log.js --host opencode [-n 20] [-f] [--path FILE]
```

Output per event: a header line (`time host channel session DELIVERED n facts
(chars) gate=…` or `SKIP <reason>`), the query, and one line per matched fact
(`+` delivered, `=` already in context, `-` budget or not applicable) with its
id, score, provenance and title. `-f` follows the file like `tail -f`.
Unparseable lines are skipped.

### D8. Tests (per host)

1. **Off ⇒ identical:** with `CT_WISDOM_VERBOSE` unset (and with `0`), the
   hook's return value is equal to a run with the recorder module stubbed out,
   no log file is created, and the host channel is never called.
2. **On ⇒ recorded, bytes unchanged:** with verbose on, the model-visible
   value (Hermes `{"context": …}`, Claude Code `additionalContext`, the DSH
   pre-step message, the OpenCode synthetic part, the OpenClaw
   `prependContext`) is byte-equal to the off run; one event is written with
   the expected fields; the host channel received the notice.
3. **Non-delivery reasons:** `deduped`, `no_match`, `gate_uncalibrated`,
   `budget`, `breaker_open`, `empty_query` are logged with the right `reason`.
4. **Recorder failures are swallowed:** a raising sink and an unwritable log
   leave the hook's return value unchanged.
5. **No env or keys:** a planted secret in the environment never appears in
   the log or the notice.
6. **Shared-script parity:** `ct_wisdom_verbose.py` and `ct_wisdom_log.py`
   are byte-identical across Hermes and Claude Code.

## Alignment with INTENT.md

- **Goal (Intuitive Wisdom):** verbose mode makes the delivery mechanism
  observable so the user can judge whether the agent got the right fact at the
  right moment, and feed tuning back to CT.
- **Rule 1 (at most once):** unchanged. The recorder reads the ledger and the
  delivered ids; it never writes them.
- **Rule 2 (never edit the system prompt):** verbose output goes only to
  channels verified as not model-visible, or to a file. The tests compare the
  model-visible bytes with verbose on and off.
- **Rule 4 (fail quietly):** every recorder path swallows its own errors, and
  verbose mode is off by default. It is the "logs locally" the rule asks for,
  made readable.
- **Rule 6 (keep it small):** budgets are untouched; verbose mode reports the
  `budget` reason so a too-small budget is visible rather than guessed.
- **Rule 7 (integrations only read):** the log is the integration's own file
  under the host's data directory. Nothing is written to the brain.
- **Rule 8 (relevance is CT's job):** the integration logs CT's gate and
  scores; it does not threshold, rank or judge them. Tuning goes to CT.
- **Departures:** none.

## Out of scope

- Host config keys for verbose mode (env only for now).
- Showing session-start bootstrap blocks (they are visible in the system
  prompt dumps hosts already offer, and the user asked about per-message
  context).
- Logging tool-result dedup stubs (N3). The event format allows adding it later
  with `channel: "tool_result"`.
- Any change to CT.

## Self-review

- Placeholders: none. Every host has a channel or an explicit log-only
  fallback, a log path, and an evidence tag.
- Consistency: the Python and TypeScript reason names differ where the code
  paths differ (`timeout`/`exit` vs `timeout_or_exit`); the split of
  `zero_hits` is shared.
- Scope: one feature, five hosts, one shared module per language plus a reader.
- Ambiguity: "off ⇒ identical" is defined as equal return values and no file
  or host-channel side effects, which is testable.
