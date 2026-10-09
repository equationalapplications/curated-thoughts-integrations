# INTENT — curated-thoughts-integrations

**Read this file first.** It explains why this repo exists, the rules every
integration must follow, what it deliberately does not do, and how changes are
made. If this file and another document disagree, this file wins on *intent*
(what we are trying to do) and the specs win on *detail* (exactly how).

Each rule has a **Status** line saying how much of it the code does today:

- **Built** — the code does this.
- **Partly built** — some of it exists; the line says what is missing.
- **Planned** — decided, but not in the code yet.
- **Open decision** — not decided yet.

Statuses were checked against the code on 2026-10-08. Update a status line in
the same pull request that changes the behavior.

## Why this repo exists

Curated Thoughts (CT) is a private, local-first "second brain" with a curated
**wisdom layer**: short, trustworthy facts its Librarian distills from your
files. This repo holds the **integrations**: thin plugins for agent harnesses
(Hermes, DeepSeek Harness, and more to come) that put those facts in front of
the agent automatically, so it doesn't have to remember to ask.

The goal is **Intuitive Wisdom**: the agent *knows the right fact at the moment
it is relevant*. That is a property, not a mechanism. We reach it in two steps:

- **At session start (v1).** Before the conversation begins, recall a few facts
  and add them to the system prompt once. There is no conversation yet, so
  relevance is a guess.
- **Mid-session (live delivery).** On each user message, ask CT which facts are
  relevant *now* and append the new ones to that turn. This is the end state.
  The Hermes design is in
  `docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md`;
  other ports copy it.

| Integration | Session-start injection | Live delivery |
|---|---|---|
| Hermes | Built (0.3.0) | Built (0.4.0, draft PR #35) |
| DeepSeek Harness | Built (0.3.0) | Planned |
| OpenCode | Not yet (0.1.0 registers the sidecar only) | Planned |
| Claude Code | Not yet (PR #23 open) | Planned |
| OpenClaw | Planned | Planned |

## Glossary

- **CT** — Curated Thoughts, the separate repo and app that owns the brain.
- **Brain** — CT's database of facts.
- **Wisdom layer** — the curated facts that integrations deliver.
- **Harness** / **host** — the agent program an integration plugs into.
- **Injection** — adding facts to the agent's context without the agent asking.
- **Block** — the section of injected facts added to the system prompt at
  session start.
- **Live delivery** — facts appended to a user turn mid-session.
- **Ledger** — the list of fact ids already in the session's context. It is
  rebuilt every turn from `<!-- ct-fact:<id> -->` markers in the transcript, so
  the plugin stores nothing.
- **Supersession** — CT marking an old fact as replaced by a newer one.
- **Correction** — a replacement fact delivered mid-session for one that was
  superseded after it was shown.
- **Provenance** — where a fact came from (for example, stated by a person or
  inferred by the Librarian), from a fixed list CT owns.
- **System One** — CT's small, fast judging models. They live in CT only.
- **`ct recall`** / **`ct wisdom match`** — CT's read-only commands. Session-start
  injection uses `recall`. Live delivery uses `wisdom match`, which applies CT's
  relevance cutoff.

## The rules

### 1. A fact appears at most once in the agent's context

Every delivered fact carries a `ct-fact:<id>` marker. Before delivering
anything, the integration rebuilds the ledger from the current context and
skips ids already there. If the agent runs a CT search itself, facts it
already has come back as short "already in context" stubs. "Context" means
what the agent can see right now. A fact that was compacted away may be
delivered again.

*Why:* repeating a fact wastes the agent's attention and the user's tokens.

**Status: Partly built.** Hermes 0.4.0 does all of this, with a randomized
exactly-once test. Hermes sessions restored after a restart can't see their
session-start ids, so live delivery stays off there (it fails closed). DeepSeek
Harness injects only at session start, and its agent-run CT searches can repeat
a fact.

### 2. Never edit the system prompt after it is built

The session-start block is computed once and frozen as one unbroken region of
the system prompt, so the host's prompt cache keeps working. Re-renders must be
byte-identical. Anything learned later goes in the append-only channels (the
user turn or tool results), never back into the prompt. When a session is
resumed, the host replays the saved prompt; the plugin doesn't persist
anything to make that work.

*Why:* rewriting the prompt breaks prompt caching on every turn, which costs
money and time.

**Status: Built** (Hermes, DeepSeek Harness). When the first render fails, a
later render may fill it in. Which failures retry is defined in the v1 spec and
`ct_wisdom.py`.

### 3. No superseded fact is ever shown as current

When a block or a live delivery is built, superseded facts are left out. If a
fact is superseded *after* the agent has seen it, the replacement is appended
as a correction that says which id it replaces. The old line stays visible but
is marked as replaced.

*Why:* the agent must never rely on a fact CT knows is wrong.

**Status: Partly built.** Hermes renders corrections, and `ct wisdom match`
filters superseded facts. In practice no corrections arrive yet, because CT's
Librarian doesn't apply supersessions yet (a CT-side gap). Session-start
injection relies on `ct recall`, which doesn't filter superseded facts.

### 4. Failing quietly beats failing the session

If CT isn't installed, the brain is unreachable, a call times out, or nothing
matches, the integration does nothing: no empty block and no error in the
session. It logs locally. Every CT call has a short timeout, so a hung backend
can't stall the session.

*Why:* an agent session must never break because the brain is down.

**Status: Built** (Hermes, DeepSeek Harness). Hermes live delivery also pauses
for 5 minutes after 3 failures in a row.

### 5. Label where each fact came from

Each delivered fact shows its provenance, using CT's vocabulary. Agent-written
facts are never presented as verified.

*Why:* the agent should weigh a person's stated rule above a guess.

**Status: Partly built.** Live delivery labels provenance. Session-start
injection can't yet, because `ct recall` doesn't return provenance. Closing that
gap needs a CT change and a parser change in each integration.

### 6. Keep it small

The session-start block and each live delivery have fixed limits on size and
count (for Hermes: 2500 chars at start; per turn, at most 2 facts and 1200
chars, with at most 12 per session). Never raise a limit to make up for weak
matching.

*Why:* a flood of loosely related facts is noise, not wisdom.

**Status: Built** (Hermes, DeepSeek Harness).

### 7. Integrations only read, and only through CT's commands

Integration code never writes to the brain and never opens its database
directly. It reads only through `ct recall`, `ct wisdom match`, and CT's
read-only sidecar tools. It never reads vault files that CT hasn't ingested
yet. Agents running *inside* the harness may still deposit knowledge through
CT's own deposit tools; that's CT's write path, not ours.

*Why:* CT's Librarian is the single gatekeeper for what becomes a fact.

**Status: Built.**

### 8. Relevance is CT's job

Integrations don't score, rank, threshold, or judge facts, and they never call
System One. CT decides what is relevant. The integration only delivers what CT
returns.

*Why:* every harness then gets the same quality, and it improves in one place.

**Status: Built.** CT's live cutoff currently rarely opens on real messages
(curated-thoughts#271). That is CT's to fix, not something to work around here.

## Out of scope (don't build these here)

- A general-purpose CT client library. Bind thinly to each host's extension
  points.
- Recall quality: scoring, ranking, query expansion, judges. That belongs in CT.
- Human review or attestation screens. Those belong in the CT app.
- Following graph links during session-start injection. Graph traversal stays
  in on-demand tools like `wiki_context`, and adding it would need a CT
  decision first.
- Harnesses without the extension points we need: a stable system-prompt
  region and a way to run a read-only CT command.

## How changes are made

1. **Spec first.** Write a spec under `docs/superpowers/specs/`, based on a
   Step-0 investigation that reads the pinned host source. Mark each claim with
   `[V]` evidence. PR #22 is the model.
2. **New ports copy the Hermes design** and record where they differ on
   purpose.
3. **Test the rules, not just the code.** Any pull request that touches
   injection must show:
   - exactly-once delivery across randomized sessions with tool results;
   - byte-identical blocks across re-renders;
   - no superseded fact at render time.
4. **Run e2e on a scratch profile** in an isolated environment. Never use the
   live default profile or the live brain.
5. **Review, then merge.** Two independent AI reviews (GLM and Opus) until
   neither finds a blocker or major issue, then merge. Unresolved questions
   hold the pull request.
6. **Release hygiene.** Each integration gets a version bump, a CHANGELOG
   entry, and its README row updated.
