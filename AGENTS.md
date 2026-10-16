# AGENTS.md

Rules for AI agents working in this repo.

1. **Read [INTENT.md](INTENT.md) before writing a spec or a plan.** It is the
   product's intent, written for people.
2. **Every spec must align with INTENT.md.** Add a short "Alignment with
   INTENT.md" section naming the rules and goals the spec serves. If the spec
   departs from INTENT.md, it must say so plainly and why, and the
   departure needs human approval before implementation starts.
3. **Don't change INTENT.md to fit a spec.** Change it only when a person
   changes the product's intent.
4. **INTENT.md holds intent only.** Never add build status, status tables,
   version numbers or dated work history to it. Those belong in the README,
   CHANGELOGs and specs.
5. **Follow "How changes are made" in INTENT.md:** spec first, then plan, then
   tests that check the rules.
