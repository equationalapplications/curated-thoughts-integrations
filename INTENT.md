# INTENT — curated-thoughts-integrations

**Read this file first.** It explains why this repo exists, the rules every
integration must follow, and what it deliberately does not do. It is written for people first: product owners should be able to read it
and recognize the product they want. Any agent writing a spec must check the
spec against it. If this file and another document disagree, this file wins on
*intent* (what we are trying to do) and the specs win on *detail* (exactly how).

This file says what the product should do, not how far the code has got.
What is built today is recorded in the README, each integration's CHANGELOG,
and the specs. Change this file only when the intent changes.

## Why this repo exists

Curated Thoughts (CT) is a private, local-first "second brain" with a curated
**wisdom layer**: short, trustworthy facts its Librarian distills from your
files. This repo holds the **integrations**: thin plugins for agent harnesses
(Hermes, DeepSeek Harness, OpenCode, Claude Code, OpenClaw, and more to come)
that put those facts in front of the agent automatically, so it doesn't have to
remember to ask.

The goal is **Intuitive Wisdom**: the agent *knows the right fact at the moment
it is relevant*. That is a property, not a mechanism. We reach it in three
steps:

- **At session start.** Before the conversation begins, recall a few facts and
  add them to the system prompt once. There is no conversation yet, so
  relevance is a guess.
- **On each user message.** Ask CT which facts are relevant *now* and append
  the new ones to that turn.
- **During autonomous work.** An agent working on its own between user
  messages (reading files, running commands, editing code) must also be able
  to trigger the inclusion of relevant facts, keyed to what it is doing at
  that moment. Without this, a long autonomous task only ever sees the facts
  that matched the user's opening request. This is the end state. How to do
  it is not decided yet: which host events trigger it, what text to send CT,
  how often to ask, and where a fact can be added mid-task without breaking
  the rules below.

The same rules apply at every step. Every host should reach every step; where
a host can't, its spec says why and what the user loses.

## Glossary

- **CT** — Curated Thoughts, the separate repo and app that owns the brain.
- **Brain** — CT's database of facts.
- **Wisdom layer** — the curated facts that integrations deliver.
- **Harness** / **host** — the agent program an integration plugs into.
- **Injection** — adding facts to the agent's context without the agent asking.
- **Block** — the section of injected facts added to the system prompt at
  session start.
- **Live delivery** — facts appended to a user turn mid-session.
- **Autonomous-work delivery** — facts delivered between user messages,
  triggered by what the agent is doing (a step, tool call, or file it works
  on) rather than by a new user message.
- **Ledger** — the list of fact ids already in the session's context, read
  from `<!-- ct-fact:<id> -->` markers.
- **Supersession** — CT marking an old fact as replaced by a newer one.
- **Correction** — a replacement fact delivered mid-session for one that was
  superseded after it was shown.
- **Provenance** — where a fact came from (for example, stated by a person or
  inferred by the Librarian), from a fixed list CT owns.
- **System One** — CT's small, fast judging models. They live in CT only.
- **`ct recall`** / **`ct wisdom match`** — CT's read-only commands.
  Session-start injection uses `recall`. Live delivery uses `wisdom match`,
  which applies CT's relevance cutoff.

## The rules

### 1. A fact appears at most once in the agent's context

Every delivered fact carries a `ct-fact:<id>` marker. Before delivering
anything, the integration checks which ids are already in context and skips
them. If the agent runs a CT search itself, facts it already has come back as
short "already in context" stubs. "Context" means what the agent can see right
now. A fact that was compacted away may be delivered again. When an
integration can't tell what is already in context (for example, a restored
session), it delivers nothing rather than risk a repeat.

*Why:* repeating a fact wastes the agent's attention and the user's tokens.

### 2. Never edit the system prompt after it is built

The session-start block is computed once and frozen as one unbroken region of
the system prompt, so the host's prompt cache keeps working. Re-renders must be
byte-identical. Anything learned later goes in the append-only channels (the
user turn or tool results), never back into the prompt. When a session is
resumed, the host replays the saved prompt.

*Why:* rewriting the prompt breaks prompt caching on every turn, which costs
money and time.

### 3. No superseded fact is ever shown as current

When a block or a live delivery is built, superseded facts are left out. If a
fact is superseded *after* the agent has seen it, the replacement is appended
as a correction that says which id it replaces. The old line stays visible but
is marked as replaced.

*Why:* the agent must never rely on a fact CT knows is wrong.

### 4. Failing quietly beats failing the session

If CT isn't installed, the brain is unreachable, a call times out, or nothing
matches, the integration does nothing: no empty block and no error in the
session. It logs locally. Every CT call has a short timeout, so a hung backend
can't stall the session, and repeated failures pause CT calls for a while.

*Why:* an agent session must never break because the brain is down.

### 5. Label where each fact came from

Each delivered fact shows its provenance, using CT's vocabulary. Agent-written
facts are never presented as verified.

*Why:* the agent should weigh a person's stated rule above a guess.

### 6. Keep it small

The session-start block and each live delivery have fixed limits on size and
count (for Hermes: 2500 chars at start; per turn, at most 2 facts and 1200
chars). The per-turn limits keep each delivery small; there is no
session-wide cap, so a fact that becomes relevant late in a session still
arrives. Never raise a limit to make up for weak matching.

*Why:* a flood of loosely related facts is noise, not wisdom.

### 7. Integrations only read, and only through CT's commands

Integration code never writes to the brain and never opens its database
directly. It reads only through `ct recall`, `ct wisdom match`, and CT's
read-only sidecar tools. It never reads vault files that CT hasn't ingested
yet. Agents running *inside* the harness may still deposit knowledge through
CT's own deposit tools; that's CT's write path, not ours.

*Why:* CT's Librarian is the single gatekeeper for what becomes a fact.

### 8. Relevance is CT's job

Integrations don't score, rank, threshold, or judge facts, and they never call
System One. CT decides what is relevant. The integration only delivers what CT
returns. If CT matches too little or too much, fix it in CT, never work around
it here.

*Why:* every harness then gets the same quality, and it improves in one place.

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

The process for turning intent into specs, code and releases is in
[CONTRIBUTING.md](CONTRIBUTING.md#how-changes-are-made). It is process, not
intent, so it lives there.
