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
(Hermes, DeepSeek Harness, OpenCode, Claude Code, OpenClaw, Docker Agent, and
more to come)
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
  that matched the user's opening request. It is keyed to what the agent just
  did: at most one CT query per model step, sent only when the activity
  changes, naming only the file path or the command's program and subcommand
  (rule 9). Work done by subagents counts too. Each delivery is smaller than
  a user-turn delivery.

The same rules apply at every step. Every host should reach every step; where
a host can't, its spec says why and what the user loses.

**From one agent to a team.** The same idea grows into a company that
largely runs itself: a few agent **teams**, one per product, working in
parallel, each remembering everything about its own product. An **executive
agent** manages the teams and talks to the human
owner, the **CEO**. Only the biggest questions reach the CEO, so the owner
carries less and guides more. The standard is unchanged: each agent knows
the right fact about *its own* work at the moment it is relevant. CT stores
the knowledge and checks answers against it; this repo coordinates, deciding
where each question goes (rule 13). The pattern should suit a household, a
30-person software shop, and one day an enterprise.

## Glossary

- **CT** — Curated Thoughts, the separate repo and app that owns the brain.
- **Brain** — CT's database of facts.
- **Wisdom layer** — the curated facts that integrations deliver.
- **Librarian** — CT's automated curator, which distills deposits into facts.
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
- **System One** — CT's small, fast judging models. They live in CT only;
  they are not the escalation ladder's models (rule 13), which this repo
  chooses and runs.
- **`ct recall`** / **`ct wisdom match`** — CT's read-only commands.
  Session-start injection uses `recall`. Live delivery uses `wisdom match`,
  which applies CT's relevance cutoff.
- **Team** — the agents working on one product, with their own memory.
- **Executive agent** — manages the teams and talks to the CEO; the
  **parent** of the teams, which are its **children**.
- **CEO** / **owner** — the human in charge; every chain of questions ends here.
- **Namespace** — one team's walled-off section of the shared brain, like a
  department's filing cabinet in a shared office.
- **Door** — a permitted way through a wall: asking the executive for one
  fact, being allowed to read a named neighbor's section, or handing a task
  to a neighbor, per rule 17.
- **Seed** — the starting knowledge a parent gives a new team, like an
  onboarding binder.
- **Verified knowledge** — the owner's original source documents, and
  recorded facts a person has confirmed.
- **Escalation ladder** — the steps (**rungs**) a question climbs: a fixed
  non-AI check first, then cheap AI models, then more capable ones, a
  person last.
- **Schema** — the agreed shape of the company's records, like the printed
  headings on a form.
- **Role pack** — an installable bundle of roles, starter knowledge and
  settings, like a franchise kit.
- **Code memory** / **code identity** — a team's memory of its own code;
  recognizing the same piece of code after it is edited, moved or renamed.
- **Gauge** — a measurement we watch: memory size, speed, noise, backlog.
- **Dogfood** — trying the product on our own work first.

## The rules

Rules 1–9 govern delivering facts to one agent. Rules 10–18
extend them to teams and restate rulings from the decision log (see "How
changes are made"). Anything this file adds beyond those rulings is marked
**derived**.

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
can't stall the session, and repeated failures pause CT calls for a while. A
CT that is missing or keeps failing may cost the session a short wait only a
few times; after that it goes quiet until something changes.

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

*Open decision (derived):* seeds (rule 12), tasks (rule 17), and the
ladder's verdicts (rule 13) must reach the brain. Whether agents write them
through CT's own tools, or this rule is amended to let integration code ask
CT to write them, is still to be decided.

### 8. Relevance is CT's job

Integrations don't score, rank, threshold, or judge facts, and they never call
System One. CT decides what is relevant. The integration only delivers what CT
returns. If CT matches too little or too much, fix it in CT, never work around
it here. The one exception is rule 13: this repo runs the escalation ladder,
which checks consistency, not relevance or truth. Its first rung is a fixed,
non-AI check owned by CT; every model rung is called from here.

*Why:* every harness then gets the same quality, and it improves in one place.

### 9. Send CT only what the agent actually did, and as little as possible

A query names only the target of an action the agent really took: a path, or
a command's program and subcommand. It never contains file contents,
arguments, secrets or the user's name. A call the user refused, or that
another guard blocked, sends nothing. When the integration can't tell whether
a call ran, it sends nothing.

*Why:* CT and its embedding provider should learn no more than they need to
find a relevant fact, and a refusal must mean nothing left the machine.

### 10. One agent alone must work perfectly

A single agent that installs nothing gets the full product. Teams, packs and
the ladder stay invisible until used.

*Why:* most users have one agent and must not pay for features they don't use.

### 11. Each team has its own memory, with walls that have doors

Each team's memory sits in its own walled-off section of one shared brain.
Every agent gets the facts about its own work and nothing else. Walls have
doors: an agent may ask the executive for one fact, be allowed to read a
named neighbor, or hand a task to a neighbor (rule 17). A team's memory
moves to its own storage or machine only when
a gauge shows it must, never on a hunch or a head count.

*Why:* an agent buried in other teams' facts is distracted; one sealed off
from a fact it needs is uninformed. Splitting early adds cost with nothing
to show for it.

### 12. The parent seeds, the children learn, the Librarian curates

The executive gives each new team a curated seed: its goals, requirements and
vocabulary, and keeps that seed current. The team writes what it learns into
its own memory. The Librarian distills it, and the owner approves what
automation can't settle. The parent reviews anything a team wants promoted
to shared knowledge, and the owner can spot-check samples of what the
Librarian approved on its own and read reports on it. Over time each team
owns more of its own memory.

*Why:* teams don't relearn the basics, and the executive's load doesn't grow
with every new team.

### 13. Questions climb a ladder, and the human is the last rung

A question or proposal goes first to a fixed, non-AI check owned by CT, then
to a cheap AI model, then to more capable ones. CT owns that first rung, and
its approval process must never depend on this repo being present; this repo
runs every model rung. Every rung must answer
**only from verified knowledge**, never from its own general knowledge. A
rung checks *consistency* (a duplicate? a contradiction? does the evidence
hold? does it fit the schema? is it ready to share upward?) and never rules
that something is *true*. Three cases always reach the owner, whatever the
rungs say: a brand-new claim with nothing verified to check it against, a
contradiction with verified knowledge, and moving a fact from one team's
section into a shared one. For a promotion, the parent reviews first and the
owner decides (rule 12). Apart from these, the owner sees only what no rung
can settle. A team asking the executive for wisdom climbs the same ladder: the
executive's knowledge answers first, its attention only when that fails.

*Why:* the human should be the final judge, not a clerk with a long queue.
Curation asks only "is this consistent with what we have verified?" and
never "is this true?" for a specific reason: AI models hallucinate and are
overconfident, so a model allowed to declare things true would turn
confident guesses into company rules.

### 14. The owner decides how much reaches them

There is no fixed approval chart. At any time the CEO can say "tell me more"
or "tell me less", and what reaches them changes to match. Turning the dial
never suppresses the cases rule 13 sends to the owner — those always come.
However little they choose to see, the full trail — audit logs and reports —
is always there when they want it.

*Why:* the right amount of oversight shifts with trust, stakes and workload.

### 15. Role packs are generic, and a household can install one

The pattern ships as role packs that a household, a 30-person software shop
or, one day, an enterprise can install. The first is **Software Factory in a
Box**: an executive, a product manager and a developer, with starter
knowledge and settings; a pack for the household follows. A pack never
carries its own copy of the schema; it
follows the company's, fixed to a named version so installs stay
predictable. A household pack must install with no software vocabulary.

*Why:* a private copy of the schema drifts. The household test proves the
pattern is generic, not a developer tool in disguise.

### 16. Code memory is light and exact

Each team also remembers its own code: its structure, what connects to what,
and its words. It finds code by exact words and real connections, not by
"sounds-like" matching (similarity search). Similarity search is left out of
the first version; adding it later would need its own decision backed by a
gauge. Code memory itself waits until the system can reliably recognize the
same piece of code after it changes.

*Why:* exact memory stays small and checkable. Memory that loses track of
code through an edit would attach facts to the wrong code.

### 17. Tasks live in the brain; the board is the user's own app

A task is a record in the brain: it has a name, a state, an owning team, it
may belong to a larger task, and it can link to facts. Handing work between
agents is a message. The visual board is whatever app the user already uses.
This repo provides the truth, never the picture.

*Why:* one record of the work means no one argues from two lists.

### 18. Measure first, then roll out in stages

First measure. Then two prerequisites: a Librarian (in CT) that stops
re-reading unchanged memory, and reliable code identity. Then a small
dogfood on a few of our own repos, then software packs; a household pack
needs none of the code work. Moving a team's memory to its
own machine comes last; teams on other machines can use the shared brain
without it. Code memory reaches every repository in stages, each gated
on the gauges.

*Why:* each stage rests on the one before; skipping ahead builds on guesses.

## Out of scope (don't build these here)

- A general-purpose CT client library. Bind thinly to each host's extension
  points. *Prevents:* a second, drifting copy of CT's interface.
- Recall quality: scoring, ranking, query expansion, judges. That belongs in
  CT. *Prevents:* each harness getting a different quality of answer.
- Human review or attestation screens, including approving what the
  Librarian can't settle. Those belong in the CT app. *Prevents:* two places
  to approve the same fact.
- Following graph links during session-start injection. Graph traversal stays
  in on-demand tools like `wiki_context`, and adding it would need a CT
  decision first. *Prevents:* a bloated, slow session start.
- Harnesses without the extension points we need: a stable system-prompt
  region and a way to run a read-only CT command. *Prevents:* fragile hacks
  that break rules 2 and 7.
- A task board or any other picture of the work. *Prevents:* a second view
  that drifts from the record (rule 17).
- Any step where a model rules a fact true. *Prevents:* guesses becoming
  company rules (rule 13).
- Separate storage per team from day one. *Prevents:* cost and complexity no
  gauge asked for (rule 11).
- Similarity search over code in the first version. *Prevents:* heavy, fuzzy
  code memory (rule 16). Adding it later is a decision plus a gauge, not an
  extension of this one.

## How changes are made

The process for turning intent into specs, code and releases is in
[CONTRIBUTING.md](CONTRIBUTING.md#how-changes-are-made). It is process, not
intent, so it lives there.

How the team intent (rules 10–18) was decided is recorded in decision log
D1–D22 in the company's knowledge vault, at
`immutable-source-files/agents/projects/agent-team-hierarchy-decision-log.md`,
with the consultation material beside it. This file states the outcome; the
log keeps the reasoning and every earlier version.
