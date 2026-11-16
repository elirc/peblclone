# Meridian on .NET — proposal

A design journal for a **hypothetical** rewrite of Meridian's backend in C# and .NET.

**Nothing in this folder has been built.** No code was changed, compiled or run. The C#
snippets are illustrative sketches; version-specific and licence-specific claims are
marked **⚑ verify** and listed in the journal's Appendix D.

- **[JOURNAL.md](JOURNAL.md)** — the proposal, in 18 chapters:
  - *Part I — Should we?* The case against rewriting, what a rewrite keeps, stack choices.
  - *Part II — The foundation, rebuilt.* Solution layout, the lost shared-contract package,
    domain types (`Money`, typed ids), EF Core, tenant isolation as a mechanism,
    concurrency, the API kernel, a reference module, testing.
  - *Part III — Building it with agents.* What changes about delegation; the build order.
  - *Part IV — Judgement.* The fifteen real bugs replayed against .NET, twenty new failure
    modes the platform adds, an incremental migration path, and the verdict.

Read [the build journal](../JOURNAL.md) first — this one refers back to it constantly.

## The short version

| Question | Answer |
| --- | --- |
| Should the working system be migrated? | No, not on technical grounds found in this repository. |
| Would .NET have been a reasonable choice on day zero? | Yes — and so was TypeScript. It depends on the team and the surroundings. |
| What does .NET make structurally safer? | Tenant isolation (global query filters), money and id types, rules enforced by compiler and architecture tests. |
| What does it cost? | The shared TypeScript contract package: types must be generated across the language boundary, and validation and domain maths can no longer simply run in the browser. |
| Of the 15 real defects in the build, how many would .NET have prevented? | 1 prevented, 2 made less likely, 1 replaced by a different problem, **11 unchanged**. |
