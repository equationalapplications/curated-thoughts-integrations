# Changelog — Hermes Agent integration

All notable changes to `integrations/hermes/` are recorded here. This file is
the source of the GitHub Release body for every `hermes-v*` tag, so the heading
format below is load-bearing: `## <version> — <date>`.

## Unreleased

## 0.7.2 — 2026-10-17

- Internal: the autonomous-work delivery moved out of the shared builder into
  a Hermes-only `ct_wisdom_activity_delivery.py`. No behavior change. Later
  Hermes-only fixes no longer require Claude Code and Docker Agent releases.

## 0.7.1 — 2026-10-17

- **Privacy: a target is sent only when the tool's result proves it ran.**
  0.7.0 decided "was this call refused?" from a list of refusal words and
  statuses, so a refusal worded some new way still sent its target (for
  example `secrets.env` or `git push`) to Curated Thoughts. Now each
  activity tool must show its own success shape: a terminal `exit_code`
  (or a command handed to the background), read_file `content`,
  write_file `bytes_written`, patch `success`, search_files
  `total_count`, with no `error`. Anything else, including plain text and
  unknown shapes, sends nothing. A command that ran and exited non-zero
  still counts as run. The word list is gone. Tests pin each shape to the
  Hermes commit the plugin is tested against and fail when that commit
  changes, so a Hermes upgrade re-checks them.

## 0.7.0 — 2026-10-17

- **Privacy: nothing is sent for a call you refuse.** Until now the
  autonomous-work query started in `pre_tool_call`, before Hermes asked you
  to approve the call or let other plugins block it. Hermes resolves those
  decisions only after every plugin's `pre_tool_call` has returned, so a
  call you then refused (or another plugin blocked) had already sent its
  target (for example `secrets.env` or `git push`) to Curated Thoughts and
  its embedding provider. Now the plugin registers no `pre_tool_call` hook
  at all. Everything happens in `transform_tool_result`, which Hermes runs
  only for a call it let run: the model step is claimed there, just before
  the query starts, so a call Hermes blocks before it runs never uses the
  step. No query starts when the result is Hermes's own refusal: a denied,
  unanswered or required approval, an `approvals.deny` rule, a blocked
  write. The check is case-insensitive. It matches the statuses `blocked`,
  `pending_approval`, `approval_required`, `denied`, `rejected`, `refused`
  and `cancelled`, `"approved": false` and `"approval_pending": true`, an
  error or message starting `BLOCKED`, `Refusing`, `Denied` or `Command
  denied`, and wording like "not approved", "denied by", "user denied" and
  "was not run", "rejected", "cancelled by user", "operation cancelled",
  "declined", "approval timed out" and "not allowed",
  also in nested or JSON-string errors and in the status and error details
  Hermes passes to the hook. Output fields are never read. A refused call
  leaves the step free for the next call.
- **Timing change:** the query no longer overlaps the tool's run, so a step
  whose first activity is new waits for Curated Thoughts after the tool
  finishes (typically 0.4–2 s, never more than 3 s), at most once per model
  step. Other calls pass through at once. OpenCode and OpenClaw work the
  same way.
- The query now uses the arguments that actually ran (after another
  plugin's `modify`).
- A started query that ends without an answer (the 3 s budget, a CT
  timeout, exit, parse error, spawn failure, discovery or capability miss)
  frees its activity, so a later step can try it again; the step stays
  used. "Nothing relevant" (CT answered) still counts as seen.
- A budget miss now counts as exactly one failure of the shared breaker
  (three pause both wisdom paths for 5 minutes), as on every other host. A
  late success no longer resets it and a late CT timeout is not counted
  twice. A refused or blocked call counts zero. A miss on a cold process
  (finding `ct` and probing `ct wisdom match --help` ran inside the same
  3 s) is not counted: the query's own outcome counts when it finishes, so
  a slow first start cannot pause wisdom while CT is healthy. A result that
  arrives just as the wait runs out is delivered, not dropped.
- `python -mpytest` and `python -umpytest` (the module attached to `-m`) are
  parsed like `python -m pytest`.
- If `ct` is missing, is not Curated Thoughts, lacks `wisdom match`, or its
  `--help` probe hangs, the autonomous-work path remembers that for 5
  minutes (or until PATH changes, which also makes it look for `ct` again)
  and skips at once instead of waiting on every step. A hung probe also
  counts as a breaker failure; a `ct` that was moved or uninstalled does
  not, and is looked up again on the next step. Only one first-time probe
  runs at a time.
- After a query runs past the 3 s wait, the same activity is not queried
  again until that query has finished.
- Internal: project packages are `stat`ed before any directory listing; the
  homes inside a project are computed once per project root; the result is
  parsed once per call, and the other calls of a step are passed through
  before any parsing.
- **Correction to 0.6.8:** its entry said `python -m tests.alice_notes` "now
  sends `python` alone, not `python tests`". 0.6.7 already sent `python`
  alone there (its check on the full module caught the name); 0.6.8 changed
  nothing for that command.

## 0.6.9 — 2026-10-17

- Shared-core change, no behavior change for Hermes:
  `ct_wisdom_live.render_live_block` gains an optional `marker_first`
  argument (default off, so Hermes's user-turn block bytes are unchanged)
  that puts each fact's `ct-fact` marker before its title. The Docker Agent
  integration uses it for blocks it appends to tool results, so the budget
  rule stays in one place. The file is byte-identical in the Claude Code and
  Docker Agent copies.
- Fixed: doctor check 6 (`embedding-backend`) now also accepts
  `EMBED_API_KEY` and `OPENROUTER_API_KEY`, the names the external-embedder
  contract (check 6b, `ct_env.external_embed_key_var`) uses. A valid
  OpenRouter setup no longer gets a false "no embedding API key" warning.

## 0.6.8 — 2026-10-17

- **Privacy fix.** What 0.6.7 could still send to CT and its embedding
  provider (and show in the `_for:` label and the verbose log):
  - **Files inside a sandbox HOME in the project.** With `HOME=repo/.home`,
    reading `.home/Documents/taxes.pdf` or `.home/.aws/credentials` from
    the repo sent that path. Anything inside a home folder that sits in the
    project is now never sent. The project's own files still are.
  - **Windows script names.** `npm.cmd test`, `make.bat build` and
    `tool.com run` were sent as `npm test`, `make build` and `tool`. Only
    `.exe` is dropped now (`git.exe status` → `git status`). Any other
    dotted program sends nothing.
  - **A folder name taken for a Python package.** `python -m mypkg` sent
    `python mypkg` for any folder named `mypkg`, and on macOS and Windows
    even for `Mypkg`. A package now needs `__init__.py` (or is a `.py`
    file), and its name must match exactly.
- `python -m tests.alice_notes` (your name in the module) now sends
  `python` alone, not `python tests`.
- Interpreter flags are parsed in all their forms (`-Xdev`, `-Wignore`,
  `-uB`, `-OO`, `-um`, `-i`, `-R`, `-x`); an unknown flag sends `python`
  alone.
- `python３` (a fullwidth digit) is no longer taken for an interpreter name.

## 0.6.7 — 2026-10-17

- **Privacy fix.** What 0.6.6 could still send to CT and its embedding
  provider (and show in the `_for:` label and the verbose log):
  - **Python submodule names.** `python -m tests.acme_merger_due_diligence`
    sent the full dotted name. Now only the top package of a project module
    is sent (`python tests`). Well-known modules such as `pytest` and
    `http.server` are sent as before.
  - **Home-relative paths under a custom HOME with a project above it.** On
    Windows with `HOME=D:\work\home` and a repo at `D:\work`,
    `D:\work\home\Documents\taxes.pdf` was sent as `home/Documents/taxes.pdf`.
    Every home folder (`HOME`, `USERPROFILE`, `~`, the system account's home)
    again blocks the folders above it. The one exception is a sandbox `HOME`
    at a dot-folder directly in the project (`.home`, `.nix-home`) or at
    `.cache/home` or `tmp/home`, which is not a real user home.
- `git.exe status` (and `.cmd`, `.bat`, `.com`) is now sent as `git status`.
- `python -u -m pytest`, `python -X dev -m pytest` and other interpreter
  flags before `-m` are skipped, so the module is found.
- `python3.11.2` is no longer taken for an interpreter name.

## 0.6.6 — 2026-10-17

- **Privacy fix: commands send only a bare program and known verbs.** 0.6.5
  kept file paths inside your project, but commands could still send private
  words to CT and its embedding provider, and show them in the `_for:` label
  and the verbose log:
  - **File or folder names after ordinary programs.** Any plain word after
    any program was sent: `rm divorce-papers`, `less medical-records`,
    `cd acme-merger`, `cat contract` and `mkdir clients` were sent as typed.
  - **Script names.** `./acme_export.sh`, or an absolute script path, sent
    `acme_export.sh`.

  Now:
  - The program must be a bare command name. A first word with a path
    (`./x`, `/opt/x`, `~/x`, `C:\x`) or a dot (a script) sends nothing at
    all.
  - Only well-known tools with subcommands also send the next word, and only
    when it is one of that tool's known verbs: `git rebase`, `npm test`,
    `cargo clippy`, `docker compose`. For `make`, `just` and `rake` that
    means a common target (`make build`, `make test`). Every other program
    is sent alone: `rm`, `cat`, `cd`, `less`, `mkdir`, …
  - `python -m <module>` sends the module only for well-known modules
    (`pytest`, `pip`, `venv`, `http.server`, `unittest`, `black`, `ruff`,
    `mypy`, `build`, `twine`) or a package inside your project.
- Fixed: a sandbox or Nix `HOME` inside a project (for example
  `repo/.home`) no longer hides the project above it. Only a real user home,
  in a `Users`, `home` or `Profiles` folder or your system account's home,
  blocks the folders above it. Such a `HOME` is still never a project
  itself.
- Internal: one small expiring cache serves project roots, `*.sln` scans and
  home folders, and home folders are no longer re-resolved on every call.

## 0.6.5 — 2026-10-16

- **Privacy redesign: file paths are sent only inside a project.** 0.6.2 through
  0.6.4 tried to clean up any path. Each review found a new layout that slipped
  through. What 0.6.4 could still send to CT and its embedding provider (and
  show in the `_for:` label and the verbose log):
  - **Another user's folder names under WSL**, with the cwd at `/mnt/c/Users`
    or `/mnt/c`: `/mnt/c/Users/Bob/secret.txt` was sent as `Bob/secret.txt`.
  - **Other users' home folders when `HOME=/`** with `/var/home`, `/nfs/home`
    or `/export/home` layouts (`bob/secret.txt`).
  - **Paths that climb out of the project**: `../../bob/secret.txt` was sent as
    `bob/secret.txt`.
  - **Your name** when it has a space (`John Smith`, in `john_smith.md`), when it
    is short and part of a file name (`jo.md`, `jo-notes`), or when it is only
    your home folder's name under a layout like `/nfs/home/alice` with no `USER`
    set.

  Now:
  - A file path is sent only if it resolves (following symlinks) inside the
    **project root**, and it is sent relative to that root. The root is the
    nearest folder at or above the session's working directory holding `.git`,
    `.hg`, `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `pom.xml`,
    `build.gradle`, `Gemfile`, `composer.json`, a `*.sln` or
    `.curated-thoughts-project`.
  - Some folders are never a project root, and the search stops at them:
    - your home folder (from `HOME`, `USERPROFILE`, `~` or the system account,
      so a dotfiles repo there counts even with `HOME` unset) and anything
      above it;
    - `/` itself;
    - the folders that hold users' homes (`/home`, `/Users`, `C:\Users`,
      `D:\Profiles`, `/var/home`, `/nfs/home`, `/export/home`, `/data/home`,
      `/mnt/<letter>/Users`) and anyone's home inside them (so
      `C:\Users\Alice` with a `package.json` is not a project, but
      `C:\Users\Alice\code\proj` is);
    - WSL's `/mnt` and `/mnt/<letter>`.

    Other top-level folders can be projects, so wisdom works in `/app` or
    `/workspace` containers. These rules are checked on the working directory
    as given and again on the project root's real path, so a symlinked or
    aliased working directory that leads into your home folder (for example
    `/work/link -> /Users/bob`, or macOS's `/System/Volumes/Data/Users/bob`)
    finds no project.
  - Anything outside a project root is not sent at all, not even its file name,
    and neither is a path longer than 200 characters (it is never cut). Paths
    are compared case-insensitively only on macOS and Windows.
  - **Commands send only the program plus a plain subcommand word** (`npm test`,
    `git rebase`, `npm run-script`), never a path, a dot or a file name.
    `pytest tests/billing` sends `pytest`, `python deploy.py` sends `python`,
    and `cat Bob/secret.txt` sends `cat`. In 0.6.0–0.6.4 the word after the
    program could be a relative path, so it could name a folder outside the
    project.
  - Nothing that names you is sent. That covers `USER`, `LOGNAME`, `USERNAME`
    and the system account name, plus your home folder's name when it sits
    in a `Users`, `home` or `Profiles` folder (so `HOME=/config` does not
    hide `config`). It catches names with spaces, and short names as a whole
    word. Any punctuation separates words, so `jo–notes.md` counts. Service
    accounts (`root`, `node`, `runner`, …) are still exempt.
  - **Behavior change:** files outside a project get no autonomous-work wisdom.
    To opt a folder in, add an empty `.curated-thoughts-project` file to it.
  - Search patterns keep the 0.6.3 allowlist. A search `path` outside the
    project is left out of the label.

## 0.6.4 — 2026-10-16

- **Privacy fix, part 3.** A further review of 0.6.3 found that the
  autonomous-work activity query (sent to CT and its embedding provider, and
  shown in the `_for:` label and the verbose log) could still carry private
  data. Upgrade from any 0.6.x. What 0.6.3 could still send:
  - **Another user's home-directory name when `HOME=/`** (`nobody`, `daemon`,
    many containers): with the cwd at `/home`, `/home/bob/secret.txt` was sent
    as `bob/secret.txt`, because every cwd counted as "inside HOME".
  - **A bare drive letter**: `\\?\C:\`, `/C:/` and `/mnt/c:` were sent as
    `C:` / `c:`.

  Now:
  - A cwd counts only at depth 2 or more, when it is not a `/Users/<x>` or
    `/home/<x>` directory and is neither HOME nor above it. A HOME of `/` or
    `/root` counts as no HOME.
  - No sent path component may contain `:`.
  - A private name is `USER`, `LOGNAME` or `USERNAME`, or HOME's / USERPROFILE's
    basename only when it sits directly under `/Users`, `/home` or `C:\Users`.
    Service accounts stay exempt. `HOME=/github/home` no longer hides `home`,
    and `HOME=/opt/build` no longer hides `build`.
  - If any sent component, search word, program or subcommand contains your
    user name, the whole activity is dropped. Before, only that component was
    dropped, so `src/sample.py` with `USER=sam` was sent as the misleading `src`.
  - Names under 3 chars are private again, matched only as a whole component or
    word (`jo/notes.md` gives nothing; `src/join.py` is fine).
  - The cwd prefix is compared case- and Unicode-insensitively, so
    `/Users/alice/proj/src/x.py` under cwd `/Users/alice/Proj` is `src/x.py`.
  - The session cwd is looked up only for file and search tools.

## 0.6.3 — 2026-10-16

- **Privacy fix, part 2: the 0.6.2 fix was incomplete.** After 0.6.2 shipped, a
  review that ran cases through the real code found that the autonomous-work
  activity query (which CT sends to the brain's embedding provider, e.g.
  OpenRouter, and which also appears in the `_for:` label and the verbose log)
  could still carry private data. Upgrade from 0.6.0, 0.6.1 or 0.6.2. What
  could still leak in 0.6.2:
  - **Search patterns with a value after a colon, a flag or a bearer word**:
    `password:letmein`, `token: hunter2`, `--password hunter2` and
    `Bearer abc123xyz` were sent as typed.
  - **Emails and other punctuation in search patterns**: `alice@example.com`,
    and rooted Windows paths such as `\ProgramData\corp\secrets.txt`.
  - **Folder layout when the cwd was your home directory**:
    `/Users/alice/clients/acme/contract.md` was sent as
    `clients/acme/contract.md`.
  - **Windows drive-relative paths**: `C:..\Users\alice\x.md` was sent as
    `C:../x.md`, and `C:foo.md` as `C:foo.md`.
  - **Your user name inside a file or folder name**: `notes/alice.txt`,
    `alice-notes.md`, `alice@corp.com.eml`.

  Now:
  - A search pattern is sent only if it passes an **allowlist**: letters (including
    non-ASCII letters), digits, `_`, `.`, `-` and spaces; at most 80 chars and 6 words;
    no word starting with `-`, key-shaped or containing your user name; and none of
    `bearer`, `token`, `password`, `passwd`, `secret`, `apikey`, `api_key` or `auth`
    anywhere. Anything else sends nothing.
  - A cwd counts only when it is inside your home directory or is a non-home
    directory at depth 2 or more. Your home directory itself and its ancestors do
    not count.
  - Drive-relative and rooted backslash paths are cut to their file name.
  - Any path component that contains your user name is dropped.
  - The cwd is now the session's working directory as Hermes tracks it (task
    override, recorded session cwd, `TERMINAL_CWD`), not just the gateway process's.
- Fixed: the user-name filter no longer treats service accounts as private
  (`root`, `node`, `app`, `user`, `admin`, `test`, `ubuntu`, `runner`,
  `docker`, `www-data`, `nobody`, `daemon`, `ec2-user`, `vscode`, `codespace`)
  or names under 3 chars. In 0.6.2, `node server.js` with `USER=node` gave no
  activity and `npm test` with `USER=test` lost `test`. The 0.6.2 entry also
  left out that `USERPROFILE`'s basename counts as a user name. It does, in
  0.6.2 and now.
- Fixed: two files that reduce to the same file name (`/srv/a/README.md`,
  `/srv/b/README.md`) no longer share a de-duplication key. The key is built from
  the full local path, which is never sent.

## 0.6.2 — 2026-10-16

- **Privacy fix (autonomous-work delivery).** Since 0.6.0, the activity query
  built from a tool call's arguments could carry private data. CT sends that
  query to the brain's embedding provider (OpenRouter, for an external
  embedder), and the same text appeared in the visible `_for:` label and the
  verbose log. Upgrade if you run 0.6.0 or 0.6.1. What could have leaked:
  - **Whole paths when the cwd was `/`** (Docker `WORKDIR /`, launchd or
    systemd services): `/Users/alice/clients/acme/contract.md` was sent as
    `Users/alice/clients/acme/contract.md`.
  - **Your user name**: a file directly in your home directory was sent with
    it (`/Users/alice/notes.txt` → `alice/notes.txt`), and a search path such
    as `/home/bob` showed as `home/bob`.
  - **Search patterns with values**: a search for `API_KEY="hunter2pass"` or
    `password=letmein` was sent as typed; only key-shaped words were blocked.

  Now (spec "Privacy amendment", shared test vectors in
  `tests/fixtures/activity_targets.json`): a cwd that is empty, `/`, a drive
  root, of depth < 2 (`/Users`, `/home`) or your home's parent does not count;
  a path outside a valid cwd is reduced to its file name; your user name
  (`USER`, `LOGNAME`, `USERNAME`, `HOME`'s basename) is dropped from every
  path, with a `Users`/`home` just before it; a search pattern with `=`, a
  quote, a key-shaped word, an absolute or `~` path, a `..` or your user name
  sends nothing; the label and the verbose log use the same sanitized text as
  the query. Nothing else changes; the filters only got stricter.

## 0.6.1 — 2026-10-16

- Fixed: a brain with an external embedder lost its API key at the sidecar.
  Hermes passes a stdio MCP server only `PATH`, `HOME`, `USER`, `LANG`,
  `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, `XDG_*` and the entry's own `env:`
  (`tools/mcp_tool_config.py::_build_safe_env` at the `ee8dd6c8` pin), so
  `OPENROUTER_API_KEY` never reached `curated-thoughts-mcp`, and recall and
  wisdom matching degraded without an error. Found by the 0.6.0 live e2e.
  - `install.sh` now reads the brain's `config.json` (read-only) and writes
    an `env:` block into the suggested or appended `mcp_servers` entry: the
    embedder's key as a `"${NAME}"` reference (`EMBED_API_KEY` if set, else
    `OPENROUTER_API_KEY` for an OpenRouter `base_url`, else
    `OPENAI_API_KEY`), and a non-default `CURATED_BRAIN_DIR`,
    `CURATED_BRAIN_DB` or `CURATED_BRAIN_CONFIG` as an absolute path. A key
    value is never written. With a local embedder, an inline key, or an
    unreadable brain config, it prints a commented `env:` example instead.
    An existing entry is still never modified; the installer prints what it
    needs instead.
  - New doctor check `sidecar-env` (after `embedding-backend`). It warns,
    with the exact `env:` lines to add, when a needed name is not forwarded,
    and when a forwarded name is set neither in the environment nor in
    `~/.hermes/.env` (Hermes passes an unset `${NAME}` through as literal
    text). Read-only, and it prints names only, never values. The check is
    shared with Claude Code (`scripts/ct_doctor.py` and `scripts/ct_env.py`
    stay byte-identical outside the harness regions).
  - Spec: `docs/superpowers/specs/2026-10-16-mcp-sidecar-env-design.md`.

## 0.6.0 — 2026-10-16

- Added: Intuitive Wisdom **autonomous-work delivery**. While the agent works
  on its own between user messages, the file it reads or edits, the command
  it runs or the pattern it searches can bring in one relevant fact
  (new `scripts/ct_wisdom_activity.py`; spec
  `docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md`).
  - Trigger: a new `pre_tool_call` hook starts `ct wisdom match --max 1` in
    the background when the tool's activity is new for the session (a new
    file, command or search), at most once per model step
    (`api_request_id`). No ceiling per user message or per session. CT's own
    tools never trigger it.
  - Query: the bare target only (CT 3.5.1 real-gate results, A6): a relative
    path, a search pattern (none if it holds a credential-shaped word), or
    program plus the word right after it for shell commands (never a flag's
    value or a quoted word; `python -m <module>` sends the module name;
    env assignments, URLs and credential-shaped tokens are dropped). Never file contents, tool output,
    diffs, the agent's text or full command lines.
  - Delivery: `transform_tool_result` of the same call adds at most 1 fact in
    at most 600 characters under `## Curated Thoughts — relevant to this
    step`, marker first. JSON-object results get a `curated_thoughts_wisdom`
    key spliced in (Hermes's own result parsers keep working); plain text
    gets the block appended. The system prompt is never touched.
  - Applies in subagents and scheduled runs; fails closed (no delivery)
    without an in-turn ledger, e.g. a restored session.
  - Budget: the 3 s timeout and the 3-failure / 300 s breaker are shared with
    user-turn delivery; the CT call overlaps the tool's own run.
  - Known limit: concept rules reached only via paths need CT activity mode
    ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)).
    From a bare path the gate reaches facts about that file or command, not
    a concept-level rule the path only implies. No query expansion is added
    here (INTENT rule 8).
- Added: verbose mode covers autonomous work. With `CT_WISDOM_VERBOSE=1`,
  each activity delivery, and each activity query that delivered nothing, is
  recorded with `channel: "activity"`, the query CT received, the activity
  label (`read src/x.py`), CT's gate and scores, and the delivered block.
  Per-call rate and filter skips are not recorded. The log gains an optional
  `activity` field (`scripts/ct_wisdom_verbose.py`, byte-identical with
  Claude Code). With verbose off the tool result bytes are unchanged.
- Added: live e2e harness `tests/e2e/` (local only, not in CI; needs
  `ZAI_API_KEY` and `OPENROUTER_API_KEY`). Docker, Hermes at the
  `ee8dd6c8` pin, a scratch `HERMES_HOME` and a scratch brain, CT 3.5.1's
  REAL relevance gate (qwen3-embedding-4b, instr1), GLM-5.3-FLASH as the
  model, verbose mode on. Verified 2026-10-16, all checks pass. From one
  user message the agent ran `pnpm test`, `pnpm test --silent`, wrote and
  read `.env.local`, and called `curated_recall_context`:
  - CT received exactly the bare targets `TASK.md`, `pnpm test` and
    `.env.local`, once each. The second `pnpm test` step and the
    `.env.local` read did not re-query, and no CT tool triggered a query.
  - One fact arrived in the `terminal` result and one in the `write_file`
    result, each with its marker and each visible exactly once. The later
    recall showed the delivered fact as an "already in context" stub.
  - The `write_file` result kept valid JSON with the spliced key, and
    Hermes's own write verifier (`file_mutation_result_landed`) still
    reported the write as landed.
  - Verbose mode printed the `[activity]` notices on stderr and wrote
    activity JSONL lines (query, label, gate, score, block). Neither key
    appears in any artifact.
  - Note: `hermes -z` sends stderr to `/dev/null`, so verbose notices show
    only in `hermes chat` (the JSONL log is written either way).
- Added: `ct_ledger.LedgerCache.claim()`, an atomic check-and-add used by
  autonomous-work delivery and `ct_tool_dedup`, so parallel tool threads can
  never both show one fact. `ct_tool_dedup`'s output is unchanged.
- Unchanged: user-turn live delivery, the session-start block and the
  system prompt.

## 0.5.0 — 2026-10-16

- Added: Verbose mode for Intuitive Wisdom (opt-in, off by default). With
  `CT_WISDOM_VERBOSE=1`, every live-delivery decision is recorded: the
  delivered block with its fact ids, titles, provenance and CT's scores, or
  the reason nothing was delivered (`deduped`, `no_match`,
  `gate_uncalibrated`, `budget`, `breaker_open`, a timeout, ...). It goes to a
  local JSON Lines log (`CT_WISDOM_VERBOSE_LOG` overrides the path) and to a
  channel the user sees and the model does not. Verbose output never changes
  the system prompt, the delivered block or any tool result; with verbose off
  the hooks behave and return exactly as before (tests compare both).
  Spec: `docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md`.
  On Hermes the notice goes to stderr and the log is
  `$HERMES_HOME/logs/ct-wisdom-verbose.jsonl`. New shared modules
  `scripts/ct_wisdom_verbose.py` (the recorder) and `scripts/ct_wisdom_log.py`
  (the reader: `python3 scripts/ct_wisdom_log.py --host hermes [-n N] [-f]`),
  byte-identical with the Claude Code copies.
- Changed: `ct_wisdom_live.match_wisdom` keeps CT's `gate` and each item's
  `score` when CT sends them, for the log only. Rendering never reads them,
  so the delivered bytes are unchanged.

## 0.4.3 — 2026-10-16

- Changed: Intuitive Wisdom live delivery has no per-session cap. The
  `LIVE_MAX_PER_SESSION = 12` constant and the switch to `--max 0` once a
  session had received 12 live facts are removed from
  `scripts/ct_wisdom_live.py`; every turn now asks `ct wisdom match --max 2`.
  Why: an autonomous agent is better served by more wisdom than less. The
  cap stopped delivery after about 6 matching turns, though a fact that
  matches late in a session is as valuable as an early one. Noise stays
  bounded per turn (at most 2 facts in a 1200-character block, only facts
  past CT's relevance gate), delivery never touches the system prompt, and
  dedup keeps the session total to the distinct facts that match.
  Unchanged: the per-turn limits, CT's score gate, dedup and exactly-once
  delivery, the breaker, timeouts and the 256-id exclude bound.

## 0.4.2 — 2026-10-16

- Changed: the spawn-time env merge moved from `ct_doctor._merged_env` into
  `ct_env.merged_env(env=None)`, the single source of truth (issue #32).
  Semantics are unchanged: `os.environ` overlaid with `env`; a `None` value
  means "not specified" (ambient shows through); `""` suppresses the ambient
  value. `ct_doctor._merged_env` is now a thin delegate.
- Changed: `ct_status.snapshot(env=...)` (and `context_section(env=...)`)
  now MERGE `env` over `os.environ` instead of replacing the view, matching
  the doctor (issue #32). No shipped caller passes `env`, so live behavior
  is unchanged; an env-passing caller now keeps the ambient HOME/PATH.
- Changed: `ct_doctor.run_checks` accepts an optional `cwd=` (registration
  context, unused by Hermes's check 7), and check 7 is reached through a
  `_check_registration` adapter. Harness-specific doctor code is now
  delimited by `# >>> harness-specific: <name>` markers so the shared-script
  parity gate (`tests/tools/test_shared_script_parity.py`, issue #33) can
  hold the Claude Code copy to the rest verbatim.
- Fixed (packaging): release tarballs no longer pick up `.ruff_cache/` and
  other tool caches — the packager now filters them centrally (issue #33).

## 0.4.1 — YYYY-MM-DD

- Fixed: `scripts/install.sh` honors a pre-set `HERMES_HOME` instead of
  silently resetting it to `~/.hermes`. Profile-scoped installs
  (`HERMES_HOME=~/.hermes/profiles/ct-test bash install.sh`) previously
  overwrote the live default profile's plugin.

## 0.4.0 — YYYY-MM-DD

- Added: relevance-timed mid-session wisdom delivery (Intuitive Wisdom, spec
  2026-10-06-intuitive-wisdom-live-delivery-design.md). A `pre_llm_call` hook
  asks `ct wisdom match` which facts are relevant to the user's message and
  appends new ones to that turn (≤2/turn, ≤1200 chars, ≤12/session;
  corrections for superseded facts always flow). A `transform_tool_result`
  hook stubs `curated_recall_context` wiki entries already in context.
  Exactly-once is enforced by a ledger rebuilt each turn from `ct-fact:<id>`
  markers in the transcript — no plugin persistence. Requires CT ≥ 3.3.0
  (`ct wisdom match`); otherwise a silent no-op. Restored sessions fail closed.
- Changed: the bootstrap wisdom block now tags each fact with its CT id
  (`<!-- ct-fact:<id> -->`) and drops wiki entries without a valid id; the
  sanitizer strips forged `ct-fact:` tokens.

## 0.3.3 — 2026-10-06

- Fixed: the doctor's bundled-fallback spawn gate (issue #28). When a
  caller's env overrides `PATH` but that override fails to resolve the
  sidecar, discovery used to fall back to the ambient install locations and
  the probe then EXECUTED that ambient binary under the caller's env — on a
  test machine, the real installed sidecar ran against the fixture brain
  (the residual risk named in 0.3.1). `run_checks` now detects that
  combination (raw caller env has a `PATH` key; discovery reports the
  bundled source), warns on `sidecar-binary`, refuses to spawn
  (`sidecar-mcp` WARN), and withholds the path from the import-preflight
  engine lookup. A caller that overrides PATH deliberately and accepts the
  ambient install being probed under its env can opt out with
  `CT_DOCTOR_ALLOW_BUNDLED=1` in the env. Callers that do not override
  `PATH` — including the real user with a bundled install and no PATH
  entry — are unaffected.
  Test-suite hardening in the same change: the mock sidecar fixture now has
  an absolute shebang, the shared helpers put ONLY the mock dir on PATH, and
  a `setUp` precondition asserts discovery resolves the mock (realpath
  check), so a broken fixture fails the suite instead of silently probing
  the real binary. `ct_env` gained `SOURCE_PATH`/`SOURCE_BUNDLED`/
  `SOURCE_NONE` constants; the issue #28 resolution rationale is at
  `docs/superpowers/open-questions/2026-10-06-issue28-bundled-fallback-resolution.md`.
- Hardened the gate against the /code-review r4 findings (4 applied):
  the discriminator is now `env.get("PATH") is not None` (not `"PATH" in env`),
  aligning with `_merged_env`'s documented None=ambient semantics — a caller
  that passes `env={"PATH": None}` (per `_merged_env`, "caller did not
  specify") no longer falsely trips the gate; `bool(env)` collapsed to
  `env is not None` to match the gate's own view; `find_sidecar` is now
  called with the raw caller env (its wrapper re-merges), removing one
  redundant dict copy + filter pass per check; and `check_version_compat`
  short-circuits to a single PASS line when gated so a third WARN cannot
  dilute the actionable hint on a PATH-override defect. Pinned by three
  new tests (PATH=None no-gate; gated version-compat stays PASS; caller-env
  `HERMES_CONFIG` cannot override the import-time module constant).

## 0.3.2 — 2026-10-06

- Fixed: the doctor's env-reading checks (`check_brain_dir`,
  `check_vault`, `check_embedding`, `check_import_preflight`) read ambient
  `os.environ` even when the caller passed an `env` — a caller using the
  merged env view got brain directories, embedding-key verdicts, and the
  engine-manifest lookup resolved from a *different* environment than the
  one it asked about (issue #29; follow-up to the #14 fix). Every
  env-reading check now accepts `env` and resolves through the same merged
  view, and `run_checks` threads its merged env into all of them.
  Ambient-only callers (`ct_doctor check`) see no behavior change.
- Changed: the MCP probe's clientInfo version is now derived from
  `plugin.yaml` at call time instead of a hard-coded literal that had
  drifted to 0.2.0; a missing manifest degrades to `0.0.0-unknown` rather
  than crashing. Ambient-only reading of `HERMES_CONFIG` in check 7 is now
  documented as deliberate (the Hermes config is a property of the host
  install, not of the probed environment). (GLM 5.3 independent review of
  this PR, 2026-10-06 — all findings adjudicated, none Critical/Important.)

## 0.3.1 — 2026-10-06

- Fixed: `run_checks` discovered the sidecar from the ambient `os.environ`
  PATH even when callers passed an `env` whose PATH pointed elsewhere — so
  on machines with a real installed sidecar, the real binary was probed (and
  its startup migration ran) against whatever brain the caller's environment
  pointed at, including test fixture brains (issue #14; the read-only and
  self-test failures on sidecar-equipped machines). Discovery, brain-path
  resolution, and the spawn now all use the same merged env view
  (`os.environ` overlaid with the caller's `env`, matching
  `subprocess.run(env=...)`). Regression test: poison sidecar on the ambient
  PATH must never run when an env PATH override is supplied. Residual risk
  (bundled-path fallback reaching a real sidecar when the env-PATH mock is
  absent) is tracked in issue #28.

## 0.3.0 — 2026-09-30

- New system-prompt section `curated-thoughts-wisdom` that recalls the wisdom
  layer at session start and injects a short (max 2500 chars) digest of
  relevant procedures and facts, alongside the existing health section. The
  recall runs through the installed `ct` CLI with a seed query widened by the
  session's working directory; results are memoized per session id (LRU,
  256 sessions) in the `ct_wisdom` module so re-renders within a session are
  byte-identical and free.
- Known v1 limitations: (1) a *restored* session — including an in-process
  `/branch`, and `/resume` after the Hermes process restarted — receives its
  persisted prompt bytes back without a recall and its new id starts with an
  empty memo, so the first compression afterwards re-recalls and the block may
  change; (2) legacy non-in-place compression rotates the session id, which
  can trigger one extra recall after compaction; (3) live sessions beyond the
  256-slot memo window evict each other and re-recall.
- Graceful no-op: when Curated Thoughts is not installed or the brain is
  unreachable, the section silently renders empty — no errors, no prompt
  noise, sessions never block on it.

## 0.2.2 — 2026-09-10

- `import-preflight` no longer counts soft-deleted `llm_wiki_entries` rows as
  live damage. The census is now scoped to rows with `deleted_at IS NULL` when
  that column exists, so retained issue-#186 corpses can no longer flip a
  healthy brain to FAIL. Soft-deleted rows are reported separately in the
  PASS/WARN detail as informational context. On brains with no `deleted_at`
  column the behavior is unchanged.

## 0.2.1 — 2026-09-09

- Clarify the import pre-flight damage detection rule in the ops skill:
  detection applies to non-`NULL` `source_ref` values only, which the
  previous wording did not make explicit.

## 0.2.1-rc.1 — 2026-09-06

- Release rehearsal: exercise the tag-driven release pipeline end to end
  (matrix verification, tarball, SHA256SUMS, prerelease notes). This release
  is deleted after confirmation and carries no functional changes.

## 0.2.0 — 2026-09-06

- Match the Hermes runtime contracts for system-prompt sections and skills.
- Environment contract: resolve the brain via `CURATED_BRAIN_DIR`,
  `CURATED_BRAIN_DB` and `CURATED_BRAIN_CONFIG` only.
- Import pre-flight reporting engine-mangled `source_ref` provenance damage.
