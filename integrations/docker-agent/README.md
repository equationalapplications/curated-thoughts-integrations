# Curated Thoughts for Docker Agent

Brings [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
to [Docker Agent](https://github.com/docker/docker-agent) (`docker agent run`,
formerly `cagent`). Verified against Docker Agent **v1.150.0**.

> **Where it works:** `docker agent run` on your machine (TUI or non-interactive).
> It does **nothing** in sandboxed runs (`--sandbox`, `runtime.sandbox: true`),
> cloud runs (`--cloud`), the editor integration (ACP), and the API, A2A and
> MCP server modes (`docker agent serve …`). Those modes either cannot reach
> your brain or do not load the hooks file this integration installs. Windows
> is not supported yet.

## What you get

- **Intuitive Wisdom** in every agent you run, with no edits to your agent
  files: relevant curated facts from your brain, each delivered at most once.
- **The MCP sidecar snippet**, for Curated Thoughts' own search tools.
- **A doctor** (`scripts/ct_doctor.py check`) and **verbose mode**.

## Requirements

- Docker Agent v1.150.0 or later, Curated Thoughts ≥ 3.3.0 (`ct` on PATH),
  and **Python 3.9+** (`python3`). On macOS, the `/usr/bin/python3` stub of the
  Xcode Command Line Tools does not count; the installer checks.

## Install

```bash
bash integrations/docker-agent/scripts/install.sh
```

It writes **one file**, `~/.config/cagent/hooks.d/50-curated-thoughts.yaml`
(or under `$DOCKER_AGENT_CONFIG_DIR`), a Docker Agent hooks drop-in that
applies to every agent of `docker agent run`. It points at this checkout's
`hooks/ct_wisdom_da.py` by absolute path, so keep the checkout where it is.
Every hook ignores its own errors (`on_error: ignore`) and ends in `|| exit 0`,
so a missing file or a broken Python can never block a prompt.

The installer **never edits your agent files**. It prints the MCP toolset to
paste into each agent that should have Curated Thoughts' search tools:

```yaml
agents:
  root:
    toolsets:
      - type: mcp
        command: "/usr/local/bin/curated-thoughts-mcp"
        args: ["--mcp"]
        env:
          OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY}
```

The `env:` lines name the keys your brain's embedder needs (by name; the value
is never copied). Docker Agent also passes its whole environment to the
sidecar. A `${env.NAME}` that is not set stops the toolset, so keep only names
that are set where you run `docker agent`.

Uninstall: `bash integrations/docker-agent/scripts/install.sh --uninstall`
(removes only the drop-in). `--print-only` shows everything and writes nothing.

## Verify

```bash
python3 integrations/docker-agent/scripts/ct_doctor.py check
```

Check 7 (`docker-agent-registration`) confirms the drop-in is installed, intact
and points at files that exist.

## Intuitive Wisdom

| Step | What happens | Where it lands |
|---|---|---|
| Session start | A short bootstrap block recalled from your wisdom layer (≤ 2 500 chars) | A system message added to every model call at the same position with identical bytes, from the first call. Helpers started with `transfer_task` get their own. |
| Each user message | `ct wisdom match` on your message (≤ 2 facts, ≤ 1 200 chars) | **Appended to the turn's first tool result.** A reply in which the agent calls no tool gets none. |
| Autonomous work | A new file read or written, command run or search can bring one fact (≤ 600 chars), at most one CT call per model step | Appended to that tool's result, under `## Curated Thoughts — relevant to this step`. |

Why the per-message facts wait for a tool result: in Docker Agent, context
added to your message is placed before the whole conversation and changes on
the next message, which makes the provider re-read the whole conversation
uncached. A tool result is saved in the session and never changes, so it is
safe for the prompt cache.

**Opt-in:** with an Anthropic model and
`provider_opts: {cache_preserving_updates: true}`, set `CT_WISDOM_DA_LIVE=prompt`
in the environment you run `docker agent` from. Per-message facts then arrive
with your message. Do not use it with other providers: each delivery would
cost a cache miss.

What is sent to Curated Thoughts during autonomous work is only the bare
target: a relative path, a search pattern, or a program and its subcommand
(`pnpm test`). User names, whole absolute paths, search values that look like
secrets, file contents, tool output and the agent's own words are never sent
(the Hermes rules, run against the shared vectors in
`tests/fixtures/activity_targets.json`).

**At most once.** Every fact carries a `ct-fact` marker. A per-session record
under `~/.cagent/curated-thoughts/wisdom/` (or `$DOCKER_AGENT_DATA_DIR`) lists
what is in context. A session the integration has not seen before (a branch,
a resumed pre-install session) is scanned on its first model call, and facts
already in it are never delivered again. `--session` resumes keep delivering
with no repeats. A fact compacted out of context is not delivered again. When
the agent runs `curated_recall_context` itself, entries it already has come back
as "already in context" stubs.

Subagents and non-interactive runs (`docker agent run agent.yaml "task"`) get
the same delivery. Sub-agents get no per-message facts, because no user
message reaches them.

### Cost

Each model call starts one short Python process (about 50 ms), and so does
each tool result; a tool result that triggers a CT query can wait up to 3 s.
Three CT timeouts in a row pause all CT calls for 5 minutes.

### Verbose mode

Set `CT_WISDOM_VERBOSE=1` in the environment you run `docker agent` from. Each
delivery decision then shows as a warning line (a TUI notification, or `⚠️` in
a non-interactive run) and is appended to
`~/.cagent/curated-thoughts/wisdom/ct-wisdom-verbose.jsonl`
(`CT_WISDOM_VERBOSE_LOG` overrides). The model never sees either. Read the log
with:

```bash
python3 integrations/docker-agent/scripts/ct_wisdom_log.py --path ~/.cagent/curated-thoughts/wisdom/ct-wisdom-verbose.jsonl
```

## Limits

- Not in sandbox, cloud, ACP/editor, API, A2A or MCP-server modes (above).
- A turn without a tool call gets no per-message facts (unless opted in).
- A `--data-dir` flag is invisible to hooks: the record stays in the default
  data dir (use `DOCKER_AGENT_DATA_DIR` instead to move both).
- If one model call's hook fails, that call goes out without the bootstrap
  block (one prompt-cache miss).
- The MCP toolset must be added to each agent file by hand.

## Environment contract

The doctor and the hooks read the brain location from `CURATED_BRAIN_DIR`,
`CURATED_BRAIN_DB` and `CURATED_BRAIN_CONFIG` (see `scripts/ct_env.py`).

## License

MIT.
