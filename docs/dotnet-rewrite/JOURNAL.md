# Meridian on .NET — a design journal

*What would change, and what would not, if Meridian had been built in C# and .NET from
the first commit. A companion to [the build journal](../JOURNAL.md), written for the same
reader: a junior engineer who wants to see how the decisions get made.*

---

## How to read this

The first journal recorded something that **happened**. This one records something that
**has not**. Nothing described here has been built, compiled or run. That changes what
the document is allowed to contain, so the rules are stated up front:

- **No invented evidence.** The first journal pasted real command output, real test
  counts, real commit hashes. This one has none, because there are none. Where the first
  journal had a **Result** block, this one has **What to check** — the evidence the lead
  would demand before believing the step was done.
- **Code is illustrative.** Every C# snippet is a sketch to make a design decision
  concrete. None of it has been through a compiler. Treat a snippet as "this is the
  shape", never as "paste this".
- **Version-specific claims are flagged.** The .NET ecosystem moves, library licences
  change, and an AI model's knowledge of a library ends at its training date (build
  journal, chapter 4). Anything that depends on a particular version or a library's
  current licence is marked **⚑ verify** and collected in [Appendix D](#appendix-d--claims-to-verify-before-acting-on-this-document).
  Look those up with a command before acting on them.

The voices are the same as before. **The lead** decides and reviews. **The assistant** is
the AI the lead thinks out loud with. **Builders** are the agents that would be given
modules. **Prompt** blocks are what the lead would say. **Lesson** blocks are what to
carry to your next project.

You should read the build journal first. This document constantly says "as in chapter 9"
or "the bug from chapter 17", and those references are the point: the interesting thing
about a rewrite is not the new code, it is seeing *which decisions were about the
problem* and *which were only about the tools*.

### Contents

- **Part I — Should we?**
  - [1. The proposal, and why to be suspicious of it](#1-the-proposal-and-why-to-be-suspicious-of-it)
  - [2. What a rewrite keeps](#2-what-a-rewrite-keeps)
  - [3. Choosing the stack, again](#3-choosing-the-stack-again)
- **Part II — The foundation, rebuilt**
  - [4. The solution layout](#4-the-solution-layout)
  - [5. The contract problem: losing the shared package](#5-the-contract-problem-losing-the-shared-package)
  - [6. The domain model: what a stronger type system buys](#6-the-domain-model-what-a-stronger-type-system-buys)
  - [7. The data layer: EF Core](#7-the-data-layer-ef-core)
  - [8. Tenancy: from convention to mechanism](#8-tenancy-from-convention-to-mechanism)
  - [9. Concurrency, revisited](#9-concurrency-revisited)
  - [10. The API kernel](#10-the-api-kernel)
  - [11. A module, end to end](#11-a-module-end-to-end)
  - [12. Testing](#12-testing)
- **Part III — Building it with agents**
  - [13. Delegation on .NET: what changes](#13-delegation-on-net-what-changes)
  - [14. The build order](#14-the-build-order)
- **Part IV — Judgement**
  - [15. The fifteen bugs, replayed](#15-the-fifteen-bugs-replayed)
  - [16. The new ways to get it wrong](#16-the-new-ways-to-get-it-wrong)
  - [17. If we really had to migrate](#17-if-we-really-had-to-migrate)
  - [18. The verdict](#18-the-verdict)
- **Appendices** —
  [A. File-by-file map](#appendix-a--file-by-file-map) ·
  [B. Vocabulary](#appendix-b--vocabulary-for-someone-coming-from-typescript) ·
  [C. Commands](#appendix-c--command-cheat-sheet) ·
  [D. Claims to verify](#appendix-d--claims-to-verify-before-acting-on-this-document)

> **In a hurry?** Read chapter 5 (the one thing the TypeScript version gets for free and
> .NET does not), chapter 8 (the one thing .NET makes structurally safer), and chapter 15
> (which of the real bugs a different language would and would not have prevented).

---

# Part I — Should we?

## 1. The proposal, and why to be suspicious of it

The proposal on the table: **rewrite Meridian's backend in C# on .NET.**

Before any design, the lead does what the build journal's first chapter did — restate the
request and look for what is hiding inside it. Three different things are hiding inside
this one:

1. *"If we were starting today, would we choose .NET?"* — a question about **day zero**.
2. *"Should we migrate the system we have?"* — a question about **the working product**.
3. *"What would it have looked like?"* — a **thought experiment**, valuable for learning
   even if the answer to the other two is no.

They have different answers and they must not be allowed to blur. Most of this journal
answers the third. Chapter 17 answers the second. Chapter 18 answers the first.

### The default answer to "should we rewrite?" is no

A working system contains knowledge that is not written down anywhere except in its code.
Meridian is one day old and it already has fifteen of these (build journal, chapter 19):
yen has no cents; a cancelled hire must lose its login but a terminated worker must keep
theirs; contracts and workers must be locked in the same order. Each one is a line or two
of code and a test with a name on it. Each one was *expensive to learn* and is *cheap to
keep*.

A rewrite throws away the code and keeps only whatever knowledge somebody remembered to
carry across. The classic failure is a rewrite that ships, looks cleaner, and re-opens
bugs the old system fixed years ago — because the fix looked like an odd special case,
and odd special cases are the first thing a tidy rewrite removes.

> **Prompt (lead → assistant)**
> Before we design anything, argue *against* this rewrite as hard as you can. What does
> the current system do well that we would be putting at risk? Then tell me what would
> have to be true for the rewrite to be the right call anyway.

**What a good answer contains.** Against: one language across API and web means the
request schemas, response types and payroll maths are *the same source files* on both
sides — the build journal's chapter 6 and chapter 15 are both about that paying off.
Against: 385 integration tests and a journey test already pass. Against: nobody has shown
a problem that the language is causing.

For: a rewrite is justified by something *outside* the code — the team that will own the
system writes C#; the company's other services, deployment and monitoring are .NET; a
customer or regulator requires a supported enterprise platform; or the domain model is
going to grow in ways where a stricter type system pays for itself every week. None of
those is a statement about TypeScript being worse. They are statements about **fit**.

**Lesson — "should we rewrite it in X?" is almost never a question about X.** It is a
question about who maintains the system, what surrounds it, and what it will have to
become. Decide those first. If the honest answer is "we would just like it better", the
answer is no.

### Why do the thought experiment anyway

Because it is the fastest way to find out which of your decisions were *about the problem*
and which were *about the tools*. Hold the domain still, change the stack, and watch what
moves:

- Decisions that **do not move** were about the problem. (Money in minor units. A tenant
  id on every table. The audit record in the same transaction.) These are the durable
  lessons, and you can take them to any language.
- Decisions that **move** were about the tools. (A hand-written list of tables for test
  cleanup. Passing a transaction handle into every helper.) These are worth knowing as
  *local* knowledge — true here, not everywhere.

That sorting is the real output of this journal.

---

## 2. What a rewrite keeps

It is tempting to picture a rewrite as starting from an empty folder. It should start
from a very full one. Before choosing a single library, the lead lists what is carried
over **unchanged**, because that list is the specification the new system is built to.

| Asset | Where it lives now | Status in a rewrite |
| --- | --- | --- |
| The domain understanding | Build journal ch. 2 | Unchanged. An EOR is an EOR. |
| The scope and the "no" list | Build journal ch. 3 | Unchanged. |
| The API contract | `docs/api-contract.md` | **Unchanged, and now load-bearing.** |
| The database schema | `apps/api/drizzle/0000_init.sql` | Unchanged — 17 tables, every constraint. |
| The business rules and error codes | The contract's bullet lists | Unchanged. |
| The React web app | `apps/web` | Unchanged *(see chapter 3 for why)*. |
| The journey scenario | `apps/api/src/test/journey.test.ts` | Re-expressed, same steps. |
| The fifteen lessons | Build journal ch. 19 | Carried as a checklist — chapter 15. |
| The method | Build journal ch. 20.3 | Unchanged. |

Two rows deserve a second look.

**The contract becomes load-bearing.** In the TypeScript build, `docs/api-contract.md`
was a coordination document: it let six builders work without meeting. In a rewrite it is
promoted to *the definition of correct*. The new API is right if and only if it honours
every row and every rule in that file — same paths, same status codes, same error codes,
same JSON field names. A rewrite with a precise external contract is a tractable
engineering task. A rewrite without one is archaeology.

**The schema is kept exactly.** This is a choice, and a strong one. The .NET version
could design its own tables. It will not, for three reasons: the existing schema's
constraints encode rules that were hard-won (the partial unique indexes from chapter 7);
keeping it means the two implementations can run against **the same database**, which is
what makes an incremental migration possible at all (chapter 17); and it removes an
entire category of "is this difference intentional?" from every review.

**Lesson — the more of the old system you can pin down as a fixed external fact, the
smaller the rewrite really is.** Contract fixed, schema fixed, UI fixed: what is left is
"implement these endpoints against these tables", which is a far smaller and far more
checkable job than "build an EOR platform in C#".

---

## 3. Choosing the stack, again

Same discipline as the build journal's chapter 4: one line of reasoning per choice, and
**look versions up rather than trusting memory**.

> **Prompt (lead → assistant)**
> List the current stable versions of the .NET SDK, EF Core, the Npgsql EF provider and
> xUnit by running the commands that report them — do not answer from memory. For every
> library you propose, also tell me its current licence and whether that changed
> recently. I know several popular .NET libraries moved to commercial licences; I do not
> want to discover one in a dependency three weeks in.

That last sentence matters more on .NET than it did on npm. Several libraries that were
the default choice for years changed their licensing terms. **⚑ verify** each one before
adopting it — the lead's working assumption is to prefer what ships in the box.

### The choices

| Concern | TypeScript build | .NET proposal | The reasoning in one line |
| --- | --- | --- | --- |
| Runtime | Node 22 | .NET, current LTS **⚑** | Long-term-support release; pin the SDK in `global.json` |
| Web framework | Express 5 | ASP.NET Core **Minimal APIs** | Closest to "a route is a function"; less ceremony than controllers |
| Data access | Drizzle | **EF Core** + Npgsql | Change tracking, migrations, query filters; Dapper for the two hot raw queries |
| Validation | zod | **FluentValidation** **⚑**, or built-in validation | Rules as code next to the request type |
| Request/response types | zod-inferred types + interfaces | C# `record` types | Immutable, value-equal, concise |
| Auth | hand-rolled sessions | **Custom authentication handler** over the same sessions table | Keeps instant revocation; plugs into ASP.NET Core's policy system |
| Password hashing | scrypt (Node stdlib) | `PasswordHasher<T>` (PBKDF2) | In the box, versioned hash format, no native dependency |
| Rate limiting | hand-written, in memory | `Microsoft.AspNetCore.RateLimiting` | In the box (still per-instance — same known gap) |
| Errors | `AppError` + custom envelope | Domain exceptions + `IExceptionHandler` → **ProblemDetails** | The standard error shape, with our `code` as an extension |
| Mapping row → DTO | hand-written | hand-written `Select` projections | Same principle; no mapping library |
| Dispatch | direct function calls | direct calls to handler classes | No mediator library — see below |
| Logging | pino | `ILogger` + OpenTelemetry | Structured logging and tracing are part of the platform |
| Tests | Vitest + supertest | **xUnit** + `WebApplicationFactory` | In-process HTTP against the real app, like supertest |
| Test database reset | hand-written ordered `DELETE`s | **Respawn** **⚑** | Computes the deletion order from the foreign keys |
| Architecture rules | a paragraph in `CLAUDE.md` | **Architecture tests** | "Modules do not reference each other" becomes a failing test |
| Web app | React 19 + Vite | **React 19 + Vite, unchanged** | See below |

Three of those rows are real decisions rather than translations.

### 3.1 Minimal APIs, not controllers

ASP.NET Core offers two styles. *Controllers* are classes with attribute-decorated
methods; *Minimal APIs* map a route directly to a function. The build journal's rule was
"a handler does three things: parse, call one service function, respond" (chapter 9).
Minimal APIs express that rule almost literally:

```csharp
// Illustrative.
group.MapPatch("/team/{id:guid}", async (
        Guid id, UpdateTeamMemberRequest request, Actor actor, TeamService team, CancellationToken ct) =>
        TypedResults.Ok(await team.UpdateMemberAsync(actor, id, request, ct)))
    .RequireAuthorization(Policies.Admin);
```

Read it against the Express version from chapter 9.1: the route, the guard, one service
call. The framework did the parsing (`request` is already a validated, typed object;
`id` is already a `Guid` or the request never reached this line). Controllers would work
too; for a codebase whose stated goal is that handlers contain no logic, the style with
the least room for logic is the better fit.

### 3.2 No mediator, no mapping library

Two libraries were close to mandatory in .NET line-of-business code for a decade: a
*mediator* (handlers looked up by request type) and an *object mapper* (automatic
entity-to-DTO copying). The proposal uses neither, for reasons that are about this
codebase rather than fashion:

- **The mapper contradicts a rule we already have.** Build journal chapter 9.2: *"the
  return value is an explicit list of fields… a new column is private until someone
  deliberately exposes it."* An automatic mapper copies properties by matching names. Add
  a `PasswordHash` property to an entity and a matching one appears in the DTO the moment
  someone adds it there by accident. We chose explicitness for a security reason; a
  convenience library that undoes it is not a convenience.
- **The mediator hides the call graph.** With one, an endpoint sends a request object
  "somewhere" and a handler is found by reflection. "Go to definition" stops at the
  library. In a teaching codebase where the point is that you can read a request from top
  to bottom, an endpoint that calls `team.UpdateMemberAsync(...)` on a class you can
  click through to is worth more than the decoupling.
- **Licensing.** **⚑ verify** the current terms of any such library before adopting it.

**Lesson — "everybody uses it" describes the last decade, not your requirements.** Each
dependency should be able to say what rule of *yours* it helps enforce. If it contradicts
one of your rules, it is not a default, however common.

### 3.3 Keep React. Do not rewrite the frontend.

The proposal said "rewrite to C# and .NET". A literal reading includes the web app:
.NET has Blazor, which builds interactive UIs in C#. The lead rules it out, and the
reasoning is a small lesson in scoping a migration:

| | Rewrite the web app in Blazor | Keep the React app |
| --- | --- | --- |
| One language everywhere | Yes — and the shared-types problem (chapter 5) disappears | No |
| Work | Twenty pages, a UI kit, 78 component tests — all again | **Zero** |
| Risk | Two rewrites at once; a failure cannot be attributed | One moving part |
| Verification | No oracle: new UI against new API | The existing UI *is* a test of the new API |

The last row decides it. If the React app is untouched and it still works against the
.NET API — every page, every flow, the same browser sweep from chapter 18 — that is very
strong evidence the new API honours the contract. Rewrite both at once and each side's
bugs hide the other's.

There is a real argument for Blazor and it should be stated fairly: with one language,
the contract problem in chapter 5 does not exist, exactly as it did not exist in the
TypeScript build. A team starting from an empty repository with only C# skills might well
choose it. But "change one thing at a time" beats "end up tidier", every time.

**Lesson — in a migration, anything you can leave alone becomes part of your test
suite.**

---

# Part II — The foundation, rebuilt

## 4. The solution layout

In .NET, code is organised into **projects** (each compiles to one assembly) grouped in a
**solution**. A project can only use another project it explicitly *references*. That is
a far stronger boundary than a folder: the compiler enforces it.

The TypeScript build had one soft rule about structure — `CLAUDE.md` rule 9, *"modules
do not import other modules"* — enforced by review and by builders doing as they were
told. The first design question on .NET is how much of that to turn into project
boundaries.

### 4.1 The temptation: one project per layer

The textbook .NET layout ("Clean Architecture") has four or more projects — Domain,
Application, Infrastructure, Web — with references pointing inward. It is a legitimate
design. It also front-loads a lot of structure, and it slices the code by *technical
layer*: to follow one feature you open four projects.

> **Prompt (lead → assistant)**
> Propose the smallest set of projects that enforces the boundaries we actually care
> about, and no others. For each project boundary, name the specific mistake it prevents.
> If you cannot name one, it should be a folder.

### 4.2 The proposal: three projects and a test for the rest

```
Meridian.sln
├── global.json                      pins the SDK version
├── Directory.Build.props            nullable on, warnings as errors, analyzers — for every project
├── Directory.Packages.props         every package version, once (central package management)
│
├── src/
│   ├── Meridian.Domain/             PURE. No database, no HTTP, no clock, no packages.
│   │   ├── Money/                   Money, Currency, BasisPoints, FxRate
│   │   ├── Payroll/                 EmploymentCost, Payslip, Proration        ← was shared/calc.ts
│   │   ├── Lifecycles/              the state machines                        ← was shared/state-machines.ts
│   │   └── Time/                    business days, leave entitlement          ← was shared/dates.ts
│   │
│   ├── Meridian.Api/                The application. One assembly.
│   │   ├── Program.cs               composition root
│   │   ├── Kernel/                  Actor, errors, auth, tenancy, audit, onboarding seam  ← was lib/ + middleware/
│   │   ├── Data/                    DbContext, entity configurations, migrations          ← was db/
│   │   └── Modules/
│   │       ├── Workers/             Endpoints.cs, WorkerService.cs, Contracts.cs (DTOs), Validators.cs
│   │       ├── Contracts/  Payroll/  Invoices/  …                             ← was modules/<name>/
│   │
│   └── Meridian.Seed/               console app: builds demo data through the HTTP API  ← was db/seed.ts
│
└── tests/
    ├── Meridian.Domain.Tests/       fast unit tests, no I/O
    ├── Meridian.Api.Tests/          integration tests: real HTTP, real Postgres
    └── Meridian.Architecture.Tests/ the structural rules, as tests
```

Each boundary, and the mistake it prevents:

- **`Meridian.Domain` is its own project** so that it *cannot* reference EF Core, ASP.NET
  Core or anything else. The build journal's chapter 6.4 praised `calc.ts` for what it
  did not do — no database, no clock, no I/O — but nothing stopped a future edit from
  importing the database client into it. Here the project has no such reference to give.
  "Pure" stops being a virtue the code has and becomes a property it cannot lose.
- **`Meridian.Api` is one project, with modules as folders.** Splitting twelve modules
  into twelve projects would enforce "modules do not reference each other" at compile
  time, at the cost of twelve project files, slower builds and a great deal of ceremony
  for a codebase this size.
- **So the module rule is enforced by a test instead.**

### 4.3 Architecture as a test

```csharp
// Illustrative — Meridian.Architecture.Tests
[Theory]
[MemberData(nameof(ModuleNames))]
public void A_module_does_not_depend_on_another_module(string module)
{
    var others = ModuleNames().Select(m => (string)m[0]).Where(m => m != module)
                              .Select(m => $"Meridian.Api.Modules.{m}").ToArray();

    var result = Types.InAssembly(typeof(Program).Assembly)
        .That().ResideInNamespace($"Meridian.Api.Modules.{module}")
        .ShouldNot().HaveDependencyOnAny(others)
        .GetResult();

    Assert.True(result.IsSuccessful, "Modules talk through Meridian.Api.Kernel, never to each other. " +
        "Offending types: " + string.Join(", ", result.FailingTypeNames ?? []));
}
```

This is the same move the build journal made in chapter 14 with the cleanup list: *when a
rule depends on people remembering, write a test that remembers for them.* In the
TypeScript build this particular rule held because six builders obeyed their briefs. That
worked — and it would have stopped working, silently, the first time someone in a hurry
added one import. A structural test turns "we agreed not to" into a red build.

More rules worth encoding the same way:

- `Meridian.Domain` references no other assembly.
- Nothing outside `Data/` and the module services touches `DbContext`.
- Endpoint classes do not reference `DbContext` at all (handlers stay thin).
- Every type named `*Dto` or `*Response` is a `record` with no reference to an entity
  type (rows never leak — chapter 9.2 of the build journal, mechanised).

**Lesson — a compiler-enforced boundary is the strongest, a test-enforced boundary is
next, and a documented convention is the weakest.** Choose the cheapest one that is
strong enough. Projects for the boundary you must never cross; tests for the ones you
merely must not cross by accident; prose for taste.

### 4.4 The files that configure everything

Three small files do for .NET what `tsconfig.base.json` and the root `package.json` did
before, and they are worth knowing by name:

```xml
<!-- Directory.Build.props — applies to every project in the solution. Illustrative. -->
<Project>
  <PropertyGroup>
    <Nullable>enable</Nullable>                       <!-- null is a type error, not a runtime surprise -->
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AnalysisLevel>latest-recommended</AnalysisLevel>
    <ImplicitUsings>enable</ImplicitUsings>
    <InvariantGlobalization>false</InvariantGlobalization>  <!-- we format currencies; we need cultures -->
  </PropertyGroup>
</Project>
```

`Nullable` plus `TreatWarningsAsErrors` is the equivalent of TypeScript's `strict` — and
like `strict`, it must be on from the first commit. Turning it on later means fixing a
thousand warnings at once, which in practice means never.

`Directory.Packages.props` lists every package version in one place — the role the single
lockfile played in chapter 5 of the build journal. `global.json` pins the SDK, so "it
builds on my machine" means the same compiler on every machine and in CI.

---

## 5. The contract problem: losing the shared package

This is the most important chapter in the journal, because it describes the one thing the
TypeScript build got **for free** that a .NET backend has to **pay for**.

### 5.1 What we had

`packages/shared` was TypeScript source imported by both the API and the web app (build
journal, chapter 6). Because both sides were the same language, three things were
literally *the same code* in the browser and on the server:

1. **Request validation** — `createWorkerSchema` validated the hire form in the browser
   and the request body on the server.
2. **Response types** — `WorkerDto` was the type the API returned and the type the page
   rendered.
3. **Domain logic** — `calculateEmploymentCost` ran on the server for quotes and payroll
   *and* in the browser for the hire form's live cost preview.

If the two sides disagreed, the build failed. The journey test's most satisfying
assertion — the quoted employer cost equals the billed employer cost, to the cent
(chapter 15) — was true by construction.

With a C# backend and a TypeScript frontend, **none of that is automatic any more.** The
server's types are C# records. The browser's types are TypeScript. Nothing connects them
unless we build the connection.

> **Prompt (lead → assistant)**
> We are about to lose the shared package. For each of the three things it gave us —
> request validation, response types, domain logic in the browser — give me the options
> for getting it back, what each costs, and what can still drift afterwards. I want to
> know exactly what guarantee we end up with compared to today.

### 5.2 Response and request types: generate them

The standard answer is a machine-readable description of the API — an **OpenAPI
document** — produced *from the C# code*, and TypeScript types produced *from that
document*.

```
C# records + endpoints  ──build──▶  openapi.json  ──generate──▶  apps/web/src/api/schema.d.ts
        (source of truth)                                          (never edited by hand)
```

ASP.NET Core can emit the OpenAPI document from the endpoint definitions and their typed
results; a generator turns it into TypeScript types **⚑ verify the current tooling**. The
web app's hand-written `api/*.ts` hooks stay, but import their types from the generated
file instead of from `@meridian/shared`.

The guarantee this gives is *nearly* what we had, with one crucial weakness: it only
holds if the generated file is **current**. A developer who changes a C# record and
forgets to regenerate has a frontend that typechecks against yesterday's API. So the
generation is not a courtesy step; it is a gate:

```
CI:  build API → emit openapi.json → generate TypeScript → git diff --exit-code
```

If the generated file differs from what is committed, the build fails with "you changed
the API and did not regenerate the client". That single CI step is what turns "we have
types" into "the types cannot be stale".

There is a second, quieter benefit. The OpenAPI document is itself a reviewable artefact.
A pull request that changes the API shows the change in `openapi.json` in plain view —
including changes nobody intended, like a field quietly becoming nullable.

### 5.3 Enums: mind the default

Here is a trap specific to this stack. C# enums are numbers. By default the JSON
serialiser writes them as numbers:

```json
{ "status": 2 }
```

The contract says `"status": "active"`. Every page in the React app compares against
strings. This must be configured once, globally, and locked with a test:

```csharp
// Illustrative. Program.cs
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;   // salaryMinor, not SalaryMinor
});
```

`PendingApproval` in C# must leave the server as `pending_approval`, exactly as the
TypeScript tuple spelled it. The safest test is not a unit test of the converter; it is a
**contract test** that serialises one instance of every DTO and compares the JSON against
a stored example (chapter 12.5). The TypeScript build never needed this test, because the
same string literal was the value on both sides. Now the wire format is a translation,
and translations get tests.

### 5.4 Client-side validation: accept a weaker guarantee

In the TypeScript build, the browser ran the *server's own schema* before submitting. On
.NET the rules live in C# validators. Options:

| Option | What you get | What it costs |
| --- | --- | --- |
| **A. Server only.** The form submits; the API's field errors are mapped onto the inputs. | One source of truth. Zero drift. | A round trip to learn that an email is malformed. |
| **B. Generate zod schemas from OpenAPI.** | Instant feedback for *structural* rules (required, length, pattern, enum). | Only rules OpenAPI can express. `endDate >= startDate` does not survive. |
| **C. Hand-write a second set of zod schemas.** | Full instant feedback. | Two sources of truth that will drift. |

The lead chooses **A, plus the cheap parts of B**. The reasoning: `useZodForm` in the web
shell *already* maps the server's `details` onto fields (build journal, chapter 12.3) —
that path exists and is tested. So the app loses nothing in correctness; it loses some
immediacy on a handful of forms. Option C buys that immediacy back at the price of the
exact drift the shared package existed to prevent.

This is the honest cost of the rewrite, stated plainly: **the browser can no longer run
the server's validation, so it either waits for the server or keeps an approximate
copy.**

### 5.5 Domain logic in the browser: move the call, not the code

The hire form shows a live cost preview by calling `calculateEmploymentCost` *in the
browser* with the selected country's rules — no network request (build journal, chapter
18 screenshots). That function is now C#.

- **Port it to TypeScript as well?** Then there are two implementations of payroll maths.
  The cent-for-cent agreement between quote and invoice — the thing chapter 15 was
  proudest of — becomes something we have to *test* rather than something that is true
  by construction. This is exactly how the "quote said one number, invoice said another"
  class of bug gets born. No.
- **Compile the C# to WebAssembly and run it in the browser?** Technically possible, and
  a large amount of machinery for one preview panel.
- **Call the server.** `POST /quotes/calculate` already exists and already returns the
  full breakdown. The hire form debounces its inputs and asks the API.

The lead chooses the third. One implementation, on the server. The preview gains a
~100 ms delay and a loading state; it loses nothing in correctness.

Notice what happened: a *design* changed because of a *language* boundary. In the
TypeScript build, "where does this calculation run?" was a free choice — anywhere. With
two languages, logic has a home, and anything that needs it has to go there.

**Lesson — a shared language is an architectural feature, not a matter of taste.** It
removes a boundary. When you add that boundary back, you must decide — for types, for
validation, and for logic separately — whether to *generate* across it, *duplicate*
across it, or *call* across it. Duplicating is the one that feels cheapest on the day and
costs the most over a year.

### 5.6 What the guarantee looks like afterwards

| | TypeScript build | .NET backend + React |
| --- | --- | --- |
| Response types agree | By construction | By generation + a CI diff gate |
| Request types agree | By construction | By generation + a CI diff gate |
| Enum spellings agree | Same literal | Converter config + contract tests |
| Browser runs server validation | Yes | No — server round trip (or partial generated copy) |
| Browser runs server maths | Yes | No — calls the API |
| Quote equals invoice | By construction | By construction *(one implementation, server side)* |

The right-hand column is a perfectly good engineering position. It is also strictly more
machinery to reach roughly the same place. That is the single biggest entry on the cost
side of the ledger in chapter 18.

---

## 6. The domain model: what a stronger type system buys

Now the entry on the *benefit* side. The build journal's chapter 6 set four rules for
money and kept them by discipline: integers in minor units; an amount always travels with
its currency; percentages are basis points; rounding happens in one function. Three of
those four were conventions the compiler knew nothing about. In C# they can be types.

> **Prompt (lead → assistant)**
> Design the domain primitives so that the bugs we actually had become hard to write.
> Start from chapter 17 of the build journal — the yen conversion — and work backwards:
> what would the *signature* of the conversion function have to be for that bug not to
> compile? Then apply the same thinking to ids and to percentages. No behaviour yet; I
> want to review the types.

### 6.1 Money as a type

In TypeScript an amount was `number` and its currency was a separate `string` that code
was *supposed* to keep beside it. Nothing stopped this:

```ts
const total = grossMinor + feeUsdMinor;   // euros plus dollars. Compiles. Runs. Wrong.
```

In C#:

```csharp
// Illustrative — Meridian.Domain/Money
public readonly record struct Currency
{
    public string Code { get; }
    /// <summary>Decimal places of the minor unit: 2 for USD (cents), 0 for JPY.</summary>
    public int MinorUnitDigits { get; }

    private Currency(string code, int digits) => (Code, MinorUnitDigits) = (code, digits);

    public static Currency Of(string code) => code switch
    {
        "JPY" or "KRW" or "VND" or "CLP" => new(code, 0),
        { Length: 3 } => new(code, 2),
        _ => throw new ArgumentException($"'{code}' is not an ISO 4217 code", nameof(code)),
    };
}

public readonly record struct Money(long Minor, Currency Currency)
{
    public static Money operator +(Money a, Money b) =>
        a.Currency == b.Currency
            ? a with { Minor = checked(a.Minor + b.Minor) }
            : throw new CurrencyMismatchException(a.Currency, b.Currency);

    public Money Apply(BasisPoints rate) => this with { Minor = Rounding.HalfUp(Minor * (decimal)rate.Value / 10_000m) };

    public decimal ToMajor() => Minor / (decimal)Math.Pow(10, Currency.MinorUnitDigits);
}
```

Three things are now true that were not before:

- **An amount cannot exist without a currency.** There is no `Money` without one.
- **Adding euros to dollars throws**, at the line where it happens, with both currencies
  in the message — instead of producing a plausible wrong number that surfaces on an
  invoice.
- **`checked` arithmetic** turns an integer overflow into an exception. The TypeScript
  build handled this with a validation ceiling and a paragraph in ADR 0003; here the
  runtime checks.

### 6.2 The yen bug, as a type signature

The original function, from chapter 17:

```ts
convertMinor(amountMinor: number, fromPerUsd: string, toPerUsd: string): number
```

The diagnosis in the build journal was precise: *"a bug that came from a function not
having the information it needed."* It took three plain values; nothing in its signature
said which currency any of them belonged to, so it could not know that yen has no cents.

With `Money`, the natural signature carries the missing information whether the author
thinks of it or not:

```csharp
// Illustrative
public readonly record struct FxRate(Currency Currency, decimal PerUsd);

public static Money Convert(Money amount, FxRate from, FxRate to)
{
    if (amount.Currency != from.Currency) throw new CurrencyMismatchException(amount.Currency, from.Currency);
    var usd = amount.ToMajor() / from.PerUsd;                    // minor → major, then to USD
    var targetMajor = usd * to.PerUsd;
    var factor = (decimal)Math.Pow(10, to.Currency.MinorUnitDigits);
    return new Money(Rounding.HalfUp(targetMajor * factor), to.Currency);   // major → minor
}
```

`amount.ToMajor()` is the step the original skipped — and here it is the *only obvious
way* to get a number out of a `Money` to divide. The correct path has become the path of
least resistance.

Now the careful part, because this is where a journal like this one could easily
overclaim:

> **The type does not make the bug impossible. It makes the bug unnatural.**

A developer who writes `new Money(amount.Minor / (long)rate.PerUsd, usd)` has reproduced
the 100× error in C#, and it compiles. What changed is that they had to reach *around*
the type to do it. In review, raw `.Minor` arithmetic outside the `Money` type is a
visible smell — and it can even be made an analyzer rule. In TypeScript the buggy line
looked exactly like every correct line around it.

And the test-data lesson from chapter 17 is untouched: **if every test still uses euros,
a yen bug still ships.** Types narrow where bugs can live. They do not look for them.

### 6.3 A hazard C# adds: the default rounding mode

The build journal's rule 4 was "rounding happens in exactly one function". That rule
becomes *more* important on .NET, because the platform's default is not the one payroll
expects:

```csharp
Math.Round(0.5m)   // → 0      "banker's rounding": halves go to the nearest EVEN number
Math.Round(1.5m)   // → 2
Math.Round(2.5m)   // → 2      ← not 3
```

`Math.Round` defaults to `MidpointRounding.ToEven`. The TypeScript build's `roundHalfUp`
rounds halves away from zero. A straight port that reaches for `Math.Round` would be off
by one cent on exactly the amounts that end in a half — rarely, unpredictably, and in a
way no German-employee test would catch.

```csharp
// Illustrative — the ONE place rounding happens
public static class Rounding
{
    public static long HalfUp(decimal value) => (long)Math.Round(value, MidpointRounding.AwayFromZero);
}
```

…plus an analyzer rule (or an architecture test scanning for the call) that **bans
`Math.Round` everywhere else**. The existing test `expect(applyBps(333, 5000)).toBe(167)`
— 166.5 rounds up — is the regression test for it and must be ported on day one.

**Lesson — when you port code, port the *tests of its edge cases* first.** The edges are
exactly where two platforms' defaults differ. A port that passes only the happy-path
tests has proven it handles the cases where the platforms agree.

### 6.4 `decimal` exists — do we still store integers?

A fair challenge. JavaScript has no decimal type, which is half of why chapter 6 chose
integer minor units. C# has `decimal`: base-10, 28 significant digits, `0.1m + 0.2m ==
0.3m` is true. Should `Money` just hold a `decimal`?

The lead keeps **integer minor units in the database and on the wire**, and uses
`decimal` for *intermediate* arithmetic (rates, FX, proration):

- The schema is fixed (chapter 2) and its columns are `bigint`.
- The contract is fixed and says `salaryMinor: 6000000`.
- An integer count of minor units cannot represent a third of a cent. A `decimal` can —
  and a fractional cent that sneaks into a stored total is a reconciliation problem
  months later.
- `decimal` removes binary-fraction errors. It does not remove the need to decide *when*
  to round; it only makes it easier to postpone the decision by accident.

So: `long` at rest and in transit, `decimal` in the middle, one rounding function at the
boundary. The rule from the build journal survives; the tool for the middle got better.

### 6.5 Ids that cannot be confused

Every id in the TypeScript build was a `string`. `completeOnboardingTask(tx, workerId,
key, actorUserId)` takes two of them; swap the arguments and it compiles. In C#, give
each kind of id its own type:

```csharp
// Illustrative
public readonly record struct WorkerId(Guid Value);
public readonly record struct UserId(Guid Value);
public readonly record struct OrganizationId(Guid Value);

Task CompleteAsync(WorkerId worker, OnboardingTaskKey key, UserId? actor, CancellationToken ct);
```

Passing a `UserId` where a `WorkerId` is expected is now a compile error. This matters
more than it looks for one specific argument: **`OrganizationId`**. A method that needs a
tenant and is handed any other id cannot compile. It is a small structural reinforcement
of the build journal's most important rule.

The cost is real and should be admitted: each id type needs an EF Core value converter, a
JSON converter and a route-parameter binder. Written once in the kernel, that is roughly
a hundred lines — but it is a hundred lines of plumbing the TypeScript build did not
need.

### 6.6 Dates and the clock

Two improvements that are simply better tools:

- **`DateOnly`** is a calendar date with no time and no zone — precisely what
  `packages/shared/src/dates.ts` simulated with `YYYY-MM-DD` strings and careful UTC
  arithmetic. `startDate` can be a `DateOnly`, and the helper functions that parsed and
  re-formatted strings mostly disappear.
- **`TimeProvider`** is an injectable clock. The TypeScript services called `new Date()`
  directly, so tests that depended on "today" had to compute their dates relative to the
  real clock (the journey test does this; so did the builders' time-off tests). With an
  injected clock, a test simply *sets* the date:

```csharp
// Illustrative
var clock = new FakeTimeProvider(new DateTimeOffset(2026, 12, 31, 12, 0, 0, TimeSpan.Zero));
// …now assert what happens to a time-off request that spans New Year's Eve.
```

The build journal's own advice in chapter 17 was to test "the weirdest legal input… a
worker who starts on the 31st". With a real clock, the year-boundary case can only be
tested on the 31st of December. With an injected clock it is one line.

And one hazard that comes with them: the Postgres driver is strict about time zones. A
`timestamptz` column expects a UTC value; hand it a local `DateTime` and it throws
**⚑ verify current behaviour**. The rule is simple — `DateTimeOffset` in UTC for
instants, `DateOnly` for calendar days, and never `DateTime.Now` anywhere (ban it with an
analyzer, as with `Math.Round`).

### 6.7 State machines

The transition tables translate directly:

```csharp
// Illustrative
public static class PayrollRunLifecycle
{
    private static readonly FrozenDictionary<PayrollRunStatus, PayrollRunStatus[]> Allowed =
        new Dictionary<PayrollRunStatus, PayrollRunStatus[]>
        {
            [PayrollRunStatus.Draft]           = [PayrollRunStatus.PendingApproval],
            [PayrollRunStatus.PendingApproval] = [PayrollRunStatus.Approved, PayrollRunStatus.Draft],
            [PayrollRunStatus.Approved]        = [PayrollRunStatus.Processing],
            [PayrollRunStatus.Processing]      = [PayrollRunStatus.Paid],
            [PayrollRunStatus.Paid]            = [],
        }.ToFrozenDictionary();

    public static bool CanMove(PayrollRunStatus from, PayrollRunStatus to) => Allowed[from].Contains(to);
}
```

One honest disappointment: TypeScript's `Record<PayrollRunStatus, …>` made it a compile
error to forget a status. A C# dictionary keyed by an enum has no such check — add a
sixth status and this compiles, then throws `KeyNotFoundException` at runtime. So the
exhaustiveness the TypeScript compiler gave for free needs a (trivial) test here:

```csharp
[Fact] public void Every_status_has_an_entry() =>
    Assert.All(Enum.GetValues<PayrollRunStatus>(), s => Assert.True(PayrollRunLifecycle.Knows(s)));
```

A stronger type system is not uniformly stronger. Here TypeScript's is.

**Lesson — "more types" is not the goal; "the mistake I am worried about does not
compile" is.** Money, ids and dates each earn a type because each corresponds to a real
bug class from this very project. Wrapping every string in a type because one can is how
a domain model becomes exhausting to work in.

---

## 7. The data layer: EF Core

Drizzle, in the TypeScript build, was a thin layer: the schema was TypeScript, the
queries looked like SQL, and nothing happened that you did not write. **Entity Framework
Core** is a different kind of tool — a full object-relational mapper. It loads rows as
objects, *tracks* the changes you make to them, and writes those changes back when you
call `SaveChangesAsync`. That is more power and more to understand.

> **Prompt (lead → assistant)**
> Map the existing schema with EF Core — do not design a new one. The first migration,
> when scripted to SQL, must be equivalent to `apps/api/drizzle/0000_init.sql`: same
> table and column names (snake_case), same types, every index, every partial index,
> every check constraint, the sequence. Then show me a diff between the two SQL files
> and explain every remaining difference.

### 7.1 Mapping to a schema that already exists

```csharp
// Illustrative — Data/Configurations/WorkerConfiguration.cs
public sealed class WorkerConfiguration : IEntityTypeConfiguration<Worker>
{
    public void Configure(EntityTypeBuilder<Worker> b)
    {
        b.ToTable("workers", t =>
        {
            t.HasCheckConstraint("workers_salary_positive", "salary_minor > 0");
            t.HasCheckConstraint("workers_dates_ordered", "end_date is null or end_date >= start_date");
        });
        b.HasKey(w => w.Id);
        b.Property(w => w.Id).HasConversion(id => id.Value, v => new WorkerId(v));
        b.HasIndex(w => new { w.OrganizationId, w.Email }).IsUnique()
            .HasDatabaseName("workers_org_email_unique");
        b.HasOne<Organization>().WithMany().HasForeignKey(w => w.OrganizationId)
            .OnDelete(DeleteBehavior.Restrict);                 // history must not vanish (ch. 7.4)
    }
}

// The partial unique index from chapter 7.3 of the build journal:
b.HasIndex(c => c.WorkerId).IsUnique()
    .HasDatabaseName("contracts_one_live_per_worker")
    .HasFilter("status in ('draft', 'sent', 'signed', 'active')");
```

Every constraint the build journal listed in its chapter 7.3 table has an EF Core
spelling. A naming-convention plugin maps `SalaryMinor` to `salary_minor` so entities
read like C# and the database reads like Postgres **⚑ verify the package**.

**What to check.** The lead does not accept "the model is mapped". The evidence is a
file:

```bash
dotnet ef migrations script --idempotent -o new.sql
diff <(normalise new.sql) <(normalise apps/api/drizzle/0000_init.sql)
```

and a written explanation of each line that still differs. This is the build journal's
chapter 7.5 — *never apply a generated migration you have not read* — with a sharper
edge, because here there is an existing schema to be **equal to**, not merely plausible.

### 7.2 Two EF Core defaults that would bite immediately

**Cascade delete.** For a required relationship, EF Core's convention is to *cascade*:
delete the parent and the children go too. The build journal's rule was the opposite —
RESTRICT nearly everywhere, because "financial history that can be deleted by accident is
not history". Left at the default, a port would silently turn `ON DELETE RESTRICT` into
`ON DELETE CASCADE` on a dozen foreign keys. Deleting a worker would delete their
payslips.

The defence is to set the default for the whole model, once, and opt *in* to cascade for
the handful of pure child tables:

```csharp
// Illustrative — in OnModelCreating
foreach (var fk in modelBuilder.Model.GetEntityTypes().SelectMany(e => e.GetForeignKeys()))
    fk.DeleteBehavior = DeleteBehavior.Restrict;
```

…and the SQL diff from 7.1 is what proves it worked.

**Enums.** Two reasonable mappings exist: native Postgres enum types (what the Drizzle
schema uses) or text columns with a conversion. Since the schema is fixed and uses native
enums, the port maps to them **⚑ verify the provider's current enum-mapping API**. This
is a place where "keep the schema identical" costs a little convenience — text columns
are easier to evolve — and the lead pays it knowingly, for the reasons in chapter 2.

### 7.3 The change tracker: a unit of work for free

Here is the first place the .NET version is *shorter*. In the TypeScript build, every
multi-row write opened a transaction and threaded its handle through every helper:

```ts
return db.transaction(async (tx) => {
  const [row] = await tx.update(users)…
  await deleteUserSessions(tx, userId);
  await recordAudit(tx, actor, {…});
});
```

Chapter 8.6 of the build journal explained why `recordAudit` takes `dbOrTx`: so the
change and its audit row commit together.

In EF Core, a `DbContext` instance is a **unit of work**. You modify objects, add new
ones, and nothing touches the database until `SaveChangesAsync` — which writes everything
in a single transaction:

```csharp
// Illustrative
member.IsActive = false;                                   // tracked change
db.Sessions.RemoveRange(db.Sessions.Where(s => s.UserId == member.Id));
audit.Record(actor, "team.member_updated", member.Id);     // adds an AuditLog entity to the same context
await db.SaveChangesAsync(ct);                             // one transaction: all of it or none of it
```

No transaction handle to pass around. The audit row cannot be written outside the
transaction, because it is not written at all until the same `SaveChangesAsync` that
writes the change. A whole class of mistake — "called the audit helper with `db` instead
of `tx`" — has no way to be expressed.

**But.** This only holds while there is exactly *one* `SaveChangesAsync` per operation.
The moment a service calls it twice — or mixes it with a bulk `ExecuteUpdateAsync`, which
runs immediately and bypasses the tracker — there are two transactions and the guarantee
is gone, silently. So the rule becomes:

> One operation, one `SaveChangesAsync`. If an operation genuinely needs more than one
> database round trip that must commit together (a bulk update *and* tracked changes),
> open an explicit transaction around both.

Payroll approval is exactly such a case (conditional status update, then invoice rows,
then audit) and gets an explicit `BeginTransactionAsync`.

### 7.4 The audit trail: explicit, not magic

EF Core has *interceptors* — hooks that run on every save. It is tempting to write one
that inspects the change tracker and writes an audit row for every modified entity
automatically. No call sites to forget.

The lead declines, and the reason is about what an audit log is *for*. An interceptor
sees "the `status` column of `payroll_runs` changed from `pending_approval` to
`approved`". The business event is "Alex **approved** the November payroll for Germany,
which issued invoice INV-2026-001011". The first is a database diff; the second is what
an auditor reads. The build journal's action names (`payroll_run.approved`,
`worker.status_changed` with a reason) carry meaning that only the service knows.

So the call stays explicit — `audit.Record(...)` in the service — and the *safety*
comes from the unit of work (7.3), with an architecture test that every endpoint mapped
with a mutating verb reaches an `audit.Record` call.

**Lesson — automate the part that is mechanical, keep explicit the part that is
meaning.** "Make sure the audit row commits with the change" is mechanical; let the
framework guarantee it. "Say what happened" is meaning; a person has to write it.

### 7.5 Reads: projections, and the loading trap

The rule *never return a database row* (build journal, chapter 9.2) is expressed with
`Select`:

```csharp
// Illustrative
var team = await db.Users.AsNoTracking()
    .Where(u => u.Role != UserRole.Worker)
    .OrderBy(u => u.FullName)
    .Select(u => new TeamMemberDto(u.Id, u.Email, u.FullName, u.Role, u.IsActive, u.CreatedAt))
    .ToListAsync(ct);
```

This is better than the TypeScript version in one concrete way: the projection is
translated to SQL, so only the six selected columns leave the database. `password_hash`
is not merely omitted from the response; it is never read.

Two habits to enforce from the first commit:

- **`AsNoTracking()` on every read.** A tracked query makes EF Core keep a copy of every
  row to detect changes. For a list endpoint that is pure waste.
- **Lazy loading stays off.** With it on, touching `worker.Country.Name` inside a loop
  quietly issues one query per worker — the "N+1" problem — and nothing in the code
  shows it. Drizzle could not do this to you: a join you did not write did not happen.
  EF Core can, so the project never enables the feature, and list endpoints are tested
  with a query counter (chapter 12.6).

### 7.6 Translating a constraint violation

The pattern from the build journal survives exactly — *the unique index is the real
guard; code only translates the error* (chapter 9.4):

```csharp
// Illustrative
try { await db.SaveChangesAsync(ct); }
catch (DbUpdateException e) when (e.IsUniqueViolation("workers_org_email_unique"))
{
    throw new ConflictException("worker_email_taken", "A worker with this email already exists");
}
```

`IsUniqueViolation` is a small kernel extension that looks for Postgres error `23505` and
the constraint name on the inner exception — the same job `isUniqueViolation` did in
`lib/errors.ts`. One detail differs and matters: after a failed `SaveChangesAsync`, the
context still holds the entities that failed to save. It must not be reused for another
attempt in the same request. In practice the exception propagates and the request ends,
which is correct; a retry loop on the same context is a bug.

---

## 8. Tenancy: from convention to mechanism

This is the chapter where .NET is unambiguously stronger, and it concerns the rule the
build journal called the most important one in the system.

### 8.1 What we had

ADR 0002 chose shared-schema tenancy enforced "by convention plus tests": every query on
a tenant table includes `WHERE organization_id = <actor's org>`, and every module has a
cross-tenant test. The independent review found the convention had been followed
perfectly in all twelve modules (chapter 17.6).

"Followed perfectly" is the phrase to worry about. It means the guarantee is exactly as
strong as the least careful query anyone will ever write. Roughly a hundred and fifty
queries carry the filter today; the hundred-and-fifty-first, written in a hurry next
year, is the one that leaks.

### 8.2 Global query filters

EF Core can attach a filter to an entity type that is applied to **every** query for
that type, automatically:

```csharp
// Illustrative — Data/MeridianDbContext.cs
public sealed class MeridianDbContext(DbContextOptions<MeridianDbContext> options, ITenantContext tenant)
    : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Every entity that implements ITenantOwned gets the same filter. No exceptions to remember.
        foreach (var type in modelBuilder.Model.GetEntityTypes()
                     .Where(t => typeof(ITenantOwned).IsAssignableFrom(t.ClrType)))
        {
            modelBuilder.Entity(type.ClrType).HasQueryFilter(TenantFilterFor(type.ClrType));
            // Effectively:  entity => entity.OrganizationId == tenant.OrganizationId
        }
    }
}
```

With this in place, `db.Workers.Where(w => w.Status == WorkerStatus.Active)` *is*
tenant-scoped. The developer did not write the filter and cannot forget it. A worker id
from another tenant returns nothing — which is the 404 the contract requires, with no
code.

The build journal described the old approach as "a habit so uniform it becomes
impossible to forget" (chapter 7.2). A global filter is the honest version of that
sentence: it is no longer a habit.

### 8.3 The four ways it can still leak

A mechanism you trust blindly is more dangerous than a convention you check. So the lead
lists exactly where the filter does **not** apply, and puts a guard on each:

| Escape hatch | Why it exists | The guard |
| --- | --- | --- |
| `IgnoreQueryFilters()` | Platform admins genuinely need cross-tenant queries (`GET /admin/organizations`) | An architecture test: the method may only be called from `Modules/Admin` and a named allow-list |
| Raw SQL (`FromSql`, Dapper) | The two `FOR UPDATE` locks (chapter 9) | Raw SQL is confined to one kernel class; every statement takes `OrganizationId` as a typed parameter |
| **Inserts** | A filter is about *reading*. Nothing stops `new Worker { OrganizationId = someOtherOrg }` | A `SaveChanges` interceptor stamps `OrganizationId` from the tenant context on every added `ITenantOwned` entity and **throws** if one is already set to a different tenant |
| No tenant in context | A background job, the seed, a platform admin who has not picked an organization | The tenant context **throws** rather than returning null; a missing tenant can never mean "all tenants" |

That last row is the subtle one, and it is the kind of bug that only appears in a system
with an automatic filter. If the tenant context returned `null` when no tenant is set,
the filter becomes `OrganizationId == null`, which matches nothing — safe by luck. But a
careless variant — "if there is no tenant, skip the filter" — turns one missing header
into *every tenant's data*. The proposal makes the absent-tenant case an exception, so
the failure mode is a loud 400 (`organization_required`, as the contract already says)
and never a quiet leak.

### 8.4 And then the second layer

ADR 0002 deferred Postgres row-level security because setting the tenant per transaction
"complicates connection handling beyond what this teaching codebase should carry on day
one". On .NET that cost is lower: a connection interceptor can run
`SET LOCAL app.organization_id = …` at the start of each transaction, in one place.

With both, tenant isolation is enforced twice, by two unrelated mechanisms: the ORM
filter (which a raw SQL query bypasses) and the database policy (which nothing running as
the application role bypasses). That is defence in depth in the sense of chapter 13.4 —
two independent defences for one threat.

The cross-tenant test in every module **stays**. It is no longer the main defence. It is
the thing that tells you if somebody disabled one.

**Lesson — convention scales with discipline; mechanism scales with nothing.** The
TypeScript build's convention held because it was one day old and every author had just
read the rule. Ask how a safeguard behaves in year three, with the third team, on the
bad day — and prefer the one that does not need anyone to remember.

---

## 9. Concurrency, revisited

The build journal used two tools for races: a conditional `UPDATE … WHERE status =
<expected>` so that two requests cannot both win a state change (`CLAUDE.md` rule 6), and
`SELECT … FOR UPDATE` to serialise the few read-check-write sequences (onboarding
activation, time-off overlap). Both still work on .NET. A third becomes natural.

### 9.1 Optimistic concurrency tokens

EF Core can treat one column as a **version**: every `UPDATE` it generates includes
`WHERE version = <the value I loaded>`. If another transaction changed the row in the
meantime, zero rows match and EF Core throws `DbUpdateConcurrencyException`. Postgres
even provides a suitable column on every table for free (`xmin`, which changes on every
write) **⚑ verify the provider's current API**.

```csharp
// Illustrative
var run = await db.PayrollRuns.SingleOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Payroll run");

if (!PayrollRunLifecycle.CanMove(run.Status, PayrollRunStatus.Approved))
    throw new ConflictException("invalid_transition", $"Cannot approve a run that is {run.Status}");

run.Approve(actor.UserId, clock.GetUtcNow());      // changes status, approvedBy, approvedAt
audit.Record(actor, "payroll_run.approved", run.Id);
await db.SaveChangesAsync(ct);                      // throws if someone else changed the row first
```

One kernel-level exception handler maps `DbUpdateConcurrencyException` to
`409 invalid_transition`, and the "two admins approve at once" case is handled for
*every* entity that has a token, with no per-endpoint code.

### 9.2 What this changes — and the trade to notice

Compare with the hand-written conditional update. The condition there was
`status = <from>`: "refuse if the *status* changed". A version token says "refuse if
*anything* on the row changed". That is stricter, and it catches a class of bug the
status check cannot. The build journal's defect #11 — voiding a signed contract while
the worker was being activated — was a decision made on a stale read of a *different
field*. With a token on the row, the stale write fails.

The strictness has a price: unrelated edits now conflict. If an admin fixes a typo in a
worker's job title while payroll is locking that worker's row, one of them gets a 409 and
a "reload and retry". For financial records, the lead takes that trade without
hesitation. For a high-traffic row it would deserve more thought.

### 9.3 Where a token is not enough

A version token protects **one row**. Two of the build journal's races were about a rule
spanning *several* rows:

- *"No two overlapping time-off requests"* — the conflicting row does not exist yet, so
  there is nothing to version.
- *"Activate the worker when no task is pending"* — the check reads the task rows, the
  write goes to the worker row.

Both still need a pessimistic lock on a parent row, and EF Core has no LINQ method for
`FOR UPDATE`. This is the one place the port drops to raw SQL:

```csharp
// Illustrative — Kernel/Locks.cs. The ONLY raw SQL in the application.
public static Task<Worker?> LockWorkerAsync(this MeridianDbContext db, OrganizationId org, WorkerId id, CancellationToken ct) =>
    db.Workers.FromSql($"select * from workers where id = {id.Value} and organization_id = {org.Value} for update")
              .SingleOrDefaultAsync(ct);
```

The interpolated string is safe — EF Core turns each `{…}` into a parameter, never into
SQL text — and note that the tenant is passed explicitly, because raw SQL is escape hatch
number two from chapter 8.3.

### 9.4 The deadlock does not care what language you use

Defect #10 in the build journal: signing locked *contract then worker*; cancelling locked
*worker then contract*; two transactions taking the same locks in opposite orders
deadlocked. That bug lives entirely in the database. Rewriting the application in C# does
nothing to it.

What .NET *can* add is a way to make the rule — "always lock the worker first" —
harder to break. Put every lock behind one kernel class that takes them in a fixed
order:

```csharp
// Illustrative
await using var scope = await locks.AcquireAsync(org, worker: workerId, contract: contractId, ct);
// Internally: worker first, then contract. Always. Callers cannot choose the order.
```

and add an architecture test that nothing else calls `FromSql`. The rule moves from a
comment in two services (where it lives today) to a single method that is the only way
to take a lock.

**Lesson — know which layer a bug lives in before deciding what will fix it.** Deadlocks,
missing indexes and wrong constraints are database facts. A new language can make the
right pattern easier to follow; it cannot change what the database does.

---

## 10. The API kernel

The kernel is where the largest amount of hand-written TypeScript is simply *deleted*,
because ASP.NET Core ships most of it. That is a genuine benefit and it comes with a
genuine risk: code you did not write is code whose defaults you did not choose.

> **Prompt (lead → assistant)**
> Rebuild the kernel from the build journal's chapter 8 on ASP.NET Core. For each piece —
> config, errors, sessions, CSRF, rate limiting, the Actor, logging — tell me whether we
> use the framework's version or write our own, and for every framework feature we adopt,
> list the defaults that differ from what the contract promises.

### 10.1 Configuration that fails fast

`config.ts` validated the environment with zod and exited on a bad value. The .NET
equivalent is the *options pattern* with validation at startup:

```csharp
// Illustrative
public sealed class MeridianOptions
{
    [Required] public required string DatabaseUrl { get; init; }
    [Required, Url] public required string WebOrigin { get; init; }
    [Range(1, 24 * 90)] public int SessionTtlHours { get; init; } = 168;
}

builder.Services.AddOptions<MeridianOptions>()
    .BindConfiguration("Meridian")
    .ValidateDataAnnotations()
    .ValidateOnStart();          // ← without this line, validation waits until first use
```

`ValidateOnStart()` is the entire point and the easiest line to forget. Without it the
options are validated lazily — the process starts happily with a missing connection
string and fails on the first request. That is precisely the "discovering `undefined` at
2am" outcome the build journal's chapter 8.1 set out to prevent.

**What to check:** a test that boots the application with one required setting removed
and asserts it refuses to start.

### 10.2 Errors: adopt the standard shape

The TypeScript build invented its envelope: `{ "error": { "code", "message", "details" } }`.
ASP.NET Core has first-class support for **Problem Details**, the IETF standard format
for HTTP API errors:

```json
{
  "type": "https://meridian.example/errors/invoice_unpaid",
  "title": "The invoice for this payroll run has not been paid",
  "status": 409,
  "code": "invoice_unpaid",
  "errors": { "endDate": ["End date must be on or after start date"] }
}
```

Here the lead faces a real fork, and it is a fork about the *contract*, not the code:

- **Keep the custom envelope.** The React app keeps working unchanged. We fight the
  framework a little: its built-in validation and its own error responses emit Problem
  Details and would have to be reshaped.
- **Adopt Problem Details.** Standard, understood by tooling and by other teams' clients.
  But it is a **breaking change to the contract** — every error response changes shape,
  and `apps/web/src/lib/api.ts` must change with it.

For a *migration* (chapter 17) the answer is fixed by chapter 2: the contract does not
move, so the .NET API emits the existing envelope, and the framework's own errors are
converted to it in one place. For a *day-zero* build the lead would choose Problem
Details and keep the stable `code` as an extension member.

The mechanism is the same either way — one handler, exactly as in chapter 8.2 of the
build journal:

```csharp
// Illustrative
internal sealed class MeridianExceptionHandler(ILogger<MeridianExceptionHandler> log) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext http, Exception ex, CancellationToken ct)
    {
        var (status, code, message, details) = ex switch
        {
            AppException app                 => (app.Status, app.Code, app.Message, app.Details),
            DbUpdateConcurrencyException     => (409, "invalid_transition", "This record was changed by someone else; reload and retry", null),
            BadHttpRequestException bad      => (bad.StatusCode, "bad_request", "Malformed request", null),
            _                                => (500, "internal_error", "Something went wrong on our side", null),
        };
        if (status == 500) log.LogError(ex, "Unhandled error on {Method} {Path}", http.Request.Method, http.Request.Path);

        http.Response.StatusCode = status;
        await http.Response.WriteAsJsonAsync(new ErrorEnvelope(code, message, details), ct);
        return true;
    }
}
```

The principle from the build journal is intact: expected failures get a stable code and a
helpful message; unexpected ones are logged in full and tell the client nothing.

**A side-debate worth knowing about: exceptions or results?** Many C# teams prefer
returning a `Result<T>` to throwing for expected failures — "exceptions are for the
exceptional". It makes failure visible in every signature, at the cost of every caller
handling it. The proposal throws, for the reason the TypeScript build did: a service that
is five calls deep can refuse with one line, and there is exactly one place that turns
refusals into HTTP. In a codebase where failures needed to be *composed* (retry this,
fall back to that), `Result<T>` would win. Know both; choose on purpose.

### 10.3 Authentication: plug the same sessions into the framework

ADR 0004 chose server-side sessions for instant revocation. That decision is about the
problem, so it survives. What changes is *how it connects*.

ASP.NET Core separates **authentication** ("who is this?" — produces a `ClaimsPrincipal`)
from **authorization** ("may they?" — policies evaluated against that principal). The
port writes one small custom authentication handler that does exactly what the
`authenticate` middleware did — read the cookie, hash it, look up the session, re-read
the user row — and hands the result to the framework:

```csharp
// Illustrative
protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
{
    if (!Request.Cookies.TryGetValue(SessionCookie.Name, out var token) || string.IsNullOrEmpty(token))
        return AuthenticateResult.NoResult();

    var actor = await sessions.ResolveActorAsync(token, Request.Headers["X-Org-Id"], Context.RequestAborted);
    if (actor is null) return AuthenticateResult.Fail("Invalid or expired session");

    Context.Features.Set(actor);                                    // the Actor, for services
    return AuthenticateResult.Success(new AuthenticationTicket(actor.ToPrincipal(), Scheme.Name));
}
```

From there, the role rules from the contract's "Who" column become named policies,
declared once:

```csharp
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(Policies.Staff,         p => p.RequireRole("platform_admin", "client_admin", "client_manager"))
    .AddPolicy(Policies.Admin,         p => p.RequireRole("platform_admin", "client_admin"))
    .AddPolicy(Policies.PlatformAdmin, p => p.RequireRole("platform_admin"))
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
```

That last line is a structural improvement over the Express version. In Express, a route
was protected only if someone remembered to list `authenticate` in its middleware. With a
**fallback policy**, every endpoint requires a signed-in user *unless it explicitly opts
out* with `.AllowAnonymous()`. The dangerous mistake (a forgotten guard) becomes
impossible; the visible one (an explicit opt-out) shows up in review. Same idea as the
RESTRICT-by-default foreign keys: make the safe thing the default and the risky thing a
deliberate act.

**Why not ASP.NET Core Identity?** It is the framework's full account system — users,
password hashing, lockout, two-factor, external logins — with its own tables. For a real
product, taking it is usually right: account security is a place to use the well-reviewed
thing. The proposal does not, for two reasons that are specific to *this* situation: the
schema is fixed (chapter 2) and Identity brings its own; and the build journal's purpose
is to show how sessions work, which a framework that does it all would hide. The lead
writes that reasoning into an ADR, because "we did not use the standard thing" is exactly
the kind of decision a future maintainer deserves an explanation for.

### 10.4 Passwords: a migration detail that decides whether users can log in

The TypeScript build stores `scrypt$N$r$p$salt$hash`. The framework's `PasswordHasher<T>`
uses PBKDF2 with its own format. They are not compatible.

For a day-zero build this does not matter. For a migration it is a hard requirement
hiding in a library choice: **every existing user must still be able to log in the
morning after.** The standard answer is a hasher that understands both:

```csharp
// Illustrative
public PasswordVerificationResult VerifyHashedPassword(User user, string stored, string provided) =>
    stored.StartsWith("scrypt$", StringComparison.Ordinal)
        ? (LegacyScrypt.Verify(provided, stored) ? PasswordVerificationResult.SuccessRehashNeeded
                                                 : PasswordVerificationResult.Failed)
        : inner.VerifyHashedPassword(user, stored, provided);
```

`SuccessRehashNeeded` tells the login code to re-hash with the new algorithm and store
it. Users migrate themselves, one successful login at a time, with no reset emails. The
build journal's comment in `crypto.ts` — *"keeping the parameters in the string means we
can raise the cost later and still verify old hashes"* — was written for exactly this
day.

The two security details from chapter 8.4 must be ported deliberately, because the
framework does not do them for you: the **same error** for unknown email and wrong
password, and a **dummy verification** when the user does not exist so the timing does
not reveal which emails are registered.

### 10.5 The Actor: explicit parameter or ambient service?

This is the most interesting design question in the kernel, because the idiomatic .NET
answer and the build journal's answer disagree.

The build journal was emphatic (chapter 8.5): every service function takes an `Actor` as
its first argument. *"The permission question is in every signature. You cannot call a
service without saying who is asking."*

The idiomatic .NET approach is dependency injection: register a scoped `ICurrentActor`
and let any service that needs it ask for it in its constructor. Signatures get shorter.
The actor becomes **ambient** — present, but invisible at the call site.

| | Explicit parameter (build journal) | Injected `ICurrentActor` (idiomatic .NET) |
| --- | --- | --- |
| Who is asking? | Visible at every call | Hidden in the constructor |
| Calling from a job or a test | Pass any actor you like | Must set up a scope with the right actor |
| Acting *as someone else* | Trivial — pass a different actor | Awkward — the ambient one is fixed per request |
| Boilerplate | One extra parameter everywhere | None |

The lead splits it, and the split follows what each piece of information is *for*:

- **The tenant is ambient.** It feeds the EF Core query filter (chapter 8), which must
  apply to every query whether or not a developer thinks about it. Making it a parameter
  would defeat the purpose.
- **The actor is explicit.** Authorization decisions — "may this person approve this
  run?" — are business logic. They should be visible in the signature and trivial to
  exercise in a test with any actor.

```csharp
public Task<PayrollRunDetailDto> ApproveAsync(Actor actor, PayrollRunId id, CancellationToken ct);
```

The seed tool is the proof this is right: it needs to act as an admin, then a worker,
then a platform admin, in one process. With an explicit actor that is three different
arguments. With an ambient one it is three carefully constructed scopes.

**Lesson — do not adopt an idiom without asking what it hides.** Dependency injection is
excellent for *infrastructure* (the clock, the database, the logger): things every caller
wants the same instance of and no caller should have to think about. It is a poor fit for
*the subject of the business rule*. "Who is asking?" is the business rule.

### 10.6 Things that come in the box

Quickly, the rest — each replaces hand-written code from the TypeScript kernel:

- **Rate limiting.** A built-in middleware with fixed-window, sliding-window and
  token-bucket limiters. It is still in-memory and per-instance, so the known gap from
  chapter 20.2 is unchanged — only the forty lines of `rate-limit.ts` are gone.
- **CSRF.** The framework's antiforgery system is designed for server-rendered forms. For
  a JSON API consumed by a same-site single-page app, the build journal's approach —
  `SameSite=Lax` plus an `Origin` allow-list — remains the right fit and ports as a
  twenty-line middleware. *Do not* assume the framework's antiforgery feature is
  protecting a JSON API; **⚑ verify** what it covers for minimal APIs in the version in
  use.
- **Graceful shutdown, health checks, structured logging, tracing.** All built in.
  `server.ts` shrinks to nothing. OpenTelemetry gives a per-request trace through HTTP →
  EF Core → Postgres with no code, which the TypeScript build did not have at all.
- **Cancellation.** Every async method takes a `CancellationToken`; when a client
  disconnects, the in-flight database query is cancelled. Express had no equivalent. It
  is a real improvement and a real chore — the token must be passed down *every* call,
  and an analyzer should fail the build when it is not.

---

## 11. A module, end to end

The build journal built `organizations` as the reference every builder copied (chapter
9). The .NET reference module would be the same one, for the same reason. Here is what a
builder would be shown.

### 11.1 The files

```
Modules/Organizations/
├── OrganizationEndpoints.cs     routes: parse → one service call → respond
├── TeamService.cs               the business rules
├── Contracts.cs                 request and response records (the DTOs)
└── Validators.cs                validation rules for the requests
```

Four files instead of two. The extra two exist because the shared package is gone:
request and response shapes used to live in `packages/shared` and now live with the
module, where the OpenAPI generator picks them up.

### 11.2 Requests, responses, validation

```csharp
// Illustrative — Contracts.cs
public sealed record UpdateTeamMemberRequest(TeamRole? Role, bool? IsActive);

public sealed record TeamMemberDto(
    UserId Id, string Email, string FullName, UserRole Role, bool IsActive, DateTimeOffset CreatedAt);

// Validators.cs
public sealed class CreateTeamInviteValidator : AbstractValidator<CreateTeamInviteRequest>
{
    public CreateTeamInviteValidator()
    {
        RuleFor(r => r.Email).NotEmpty().EmailAddress().MaximumLength(254);
        RuleFor(r => r.Role).IsInEnum();
    }
}
```

`TeamRole` is its own enum with two members, not `UserRole` with four. The TypeScript
build made the same point with `INVITABLE_TEAM_ROLES` and a test that inviting a
`platform_admin` returns 400. Here the request type *cannot represent* the forbidden
value — the JSON fails to bind before any code runs.

**Normalisation needs a decision.** The zod schemas *transformed* as they validated:
emails were trimmed and lower-cased at the boundary (build journal, chapter 6.5), which
is why every later comparison could be a plain `=`. A C# validator only checks; it does
not change the value. Trimming and lower-casing must therefore happen somewhere explicit
— the proposal uses a tiny `Email` value type whose constructor normalises, so an
un-normalised email cannot reach a query:

```csharp
public readonly record struct Email
{
    public string Value { get; }
    public Email(string raw) => Value = raw.Trim().ToLowerInvariant();   // Invariant: not the server's locale!
}
```

That `ToLowerInvariant` is not pedantry. `ToLower()` uses the current culture, and under
a Turkish locale the lower-case of `I` is `ı` (dotless), not `i`. An email that
lower-cases differently on two servers is a duplicate-account bug. It is the same family
of mistake as banker's rounding (chapter 6.3): a platform default that is right for some
other program.

### 11.3 The endpoints

```csharp
// Illustrative — OrganizationEndpoints.cs
public static class OrganizationEndpoints
{
    public static IEndpointRouteBuilder MapOrganizations(this IEndpointRouteBuilder app)
    {
        var team = app.MapGroup("/team").WithTags("Team").AddEndpointFilter<ValidationFilter>();

        team.MapGet("/", async (Actor actor, TeamService svc, CancellationToken ct) =>
                TypedResults.Ok(new Items<TeamMemberDto>(await svc.ListAsync(actor, ct))))
            .RequireAuthorization(Policies.Staff);

        team.MapPatch("/{id:guid}", async (UserId id, UpdateTeamMemberRequest req, Actor actor, TeamService svc, CancellationToken ct) =>
                TypedResults.Ok(await svc.UpdateMemberAsync(actor, id, req, ct)))
            .RequireAuthorization(Policies.Admin);

        return app;
    }
}
```

Three things the framework did that Express needed helper functions for:

- `{id:guid}` — a malformed id never reaches the handler. (This is the `uuidParam` helper
  and, incidentally, the whole of defect #5.)
- `req` arrives already deserialised and, via the filter, already validated.
- `TypedResults.Ok(...)` carries the response type into the OpenAPI document, which
  becomes the TypeScript type in the web app (chapter 5).

### 11.4 The service

Side by side with the function the build journal annotated in chapter 9.2:

```csharp
// Illustrative — TeamService.cs
public async Task<TeamMemberDto> UpdateMemberAsync(Actor actor, UserId userId, UpdateTeamMemberRequest request, CancellationToken ct)
{
    if (userId == actor.UserId)
        // Otherwise the last admin can lock the whole organization out.
        throw new BadRequestException("cannot_modify_self", "You cannot change your own role or status");

    // No tenant filter written here — the global query filter applies it (chapter 8).
    var member = await db.Users.SingleOrDefaultAsync(u => u.Id == userId && u.Role != UserRole.Worker, ct)
                 ?? throw new NotFoundException("Team member");

    if (request.Role is { } role) member.Role = role.ToUserRole();
    if (request.IsActive is { } active)
    {
        member.IsActive = active;
        // Deactivation must bite immediately, not when the session cookie expires.
        if (!active) db.Sessions.RemoveRange(db.Sessions.Where(s => s.UserId == member.Id));
    }

    audit.Record(actor, "team.member_updated", member.Id.Value, new { request.Role, request.IsActive });
    await db.SaveChangesAsync(ct);          // one transaction: update + session purge + audit

    return new TeamMemberDto(member.Id, member.Email, member.FullName, member.Role, member.IsActive, member.CreatedAt);
}
```

Run the build journal's "four habits" against it:

1. *The tenant filter is inside the `WHERE`* → it is now **automatic** (and absent from
   the code, which a reader must know to look for in the `DbContext`).
2. *Zero rows → 404, not 403* → unchanged: `?? throw new NotFoundException`.
3. *Side effects share the transaction* → now **structural**: one `SaveChangesAsync`.
4. *The return value is an explicit list of fields* → unchanged, by hand, on purpose.

Two of the four moved from "the author must do this" to "the platform does this". That
is the gain. The cost is in the first parenthesis: **a reader no longer sees the tenant
check.** Someone new to the codebase will read that query and reasonably ask "where is
the tenant filter?" The answer has to be in the onboarding document, in a comment on the
`DbContext`, and — because both of those can be missed — in a test.

**Lesson — moving a safeguard from the call site into the framework makes it more
reliable and less visible.** Both effects are real. Compensate for the second with a
comment where people will look and a test that fails if the safeguard is removed.

---

## 12. Testing

The testing *strategy* from the build journal is about the problem and survives whole:
real Postgres, real HTTP, factories with overrides, tests named as promises, one journey
test across every seam. The *tooling* changes, and in two places it gets noticeably
better.

### 12.1 In-process HTTP

`WebApplicationFactory<Program>` boots the real application inside the test process and
hands out an `HttpClient` wired to it — no port, no network. It is the direct equivalent
of `supertest(createApp())`, and the helper the build journal called `client(token)`
becomes:

```csharp
// Illustrative
var tenant = await Given.Tenant();                      // organization + logged-in admin, like createTenant()
var response = await tenant.Admin.PatchAsJsonAsync($"/api/v1/team/{someone.Id}", new { isActive = false });
response.StatusCode.Should().Be(HttpStatusCode.OK);     // ⚑ verify the assertion library's licence
```

### 12.2 The database: containers, and a constraint of this machine

The fashionable way to get a real Postgres in .NET tests is **Testcontainers**: the test
run starts a throwaway Postgres in Docker and discards it afterwards. Nothing to install,
identical everywhere.

It needs Docker. The build journal recorded that this development machine runs its
databases as native Postgres clusters on dedicated ports, not in containers. So the
proposal reads a connection string from configuration and defaults to the existing
cluster on port 5443, with Testcontainers as the path for CI and for anyone who has
Docker. The principle — tests run against the real database engine — does not depend on
which one starts it.

The safety catch from chapter 5 of the build journal ports verbatim: the reset code
refuses to run against any database whose name does not contain `test`.

### 12.3 Cleanup: the list we no longer maintain

Chapter 14 of the build journal replaced `TRUNCATE … CASCADE` (350 ms per test) with
ordered `DELETE`s (about 10 ms), then had to write a guard test because the list of
tables was now maintained by hand.

**Respawn** **⚑** does that job as a library: it reads the foreign-key graph from the
database, works out a valid deletion order itself, and issues the `DELETE`s. Add a
table and it is included automatically. The hand-written list, and the test that guards
it, both disappear:

```csharp
// Illustrative
_respawner = await Respawner.CreateAsync(connection, new RespawnerOptions
{
    DbAdapter = DbAdapter.Postgres,
    TablesToIgnore = ["countries", "fx_rates", "__EFMigrationsHistory"],   // reference data survives
});
```

This is a nice illustration of the sorting exercise from chapter 1. *"Measure before you
optimise"* was a lesson about the problem — it applies here unchanged. *"Maintain an
ordered list of tables and guard it with a test"* was a lesson about the tools. In an
ecosystem with a library for it, that particular piece of cleverness is simply not
needed.

### 12.4 Parallelism: the default is the opposite

Vitest was configured with `fileParallelism: false` because every file shared one
database. xUnit's default is the reverse: **test classes run in parallel**. Port the
tests naively and they will truncate each other's data — the exact failure mode the
build journal's chapter 11 warned about, now inside a single test run.

Two sound options:

- **One database, serial.** Put every integration test class in one xUnit *collection*,
  which makes them run one at a time. Simple; as slow as today.
- **A database per worker, parallel.** Create N databases (`meridian_test_1…N`) and give
  each parallel collection its own. The build journal already did this for the builder
  agents (`meridian_test_a/b/c`); the same trick, applied to the test runner, would cut
  the suite's wall-clock time roughly by N.

The second is the better end state and is entirely feasible *because* the first build
proved the per-database isolation works.

### 12.5 Tests the TypeScript build did not need

Three kinds, each covering a risk the rewrite *introduces*:

**Contract tests.** Serialise one representative instance of every DTO and compare with
a stored JSON file. They exist to catch the wire format drifting — an enum emitted as a
number, `salaryMinor` becoming `SalaryMinor`, a `DateOnly` rendered with a time. In the
TypeScript build, the wire format was just the object. Here it is a translation.

**The OpenAPI gate.** Chapter 5.2's CI step: regenerate the TypeScript client and fail if
it differs from what is committed.

**Architecture tests.** Chapter 4.3.

### 12.6 Tests the stronger tooling makes cheap

**Property-based tests for the money maths.** Instead of choosing examples, state a
property and let a library generate hundreds of inputs:

```csharp
// Illustrative
[Property]
public Property Converting_there_and_back_returns_the_original_amount_within_one_minor_unit(
    Money amount, FxRate target) => /* for ANY currency, including the zero-decimal ones */ …
```

Would this have caught the yen bug? **Yes — if and only if the generator produces yen.**
A generator that only makes two-decimal currencies would have passed, exactly as the
EUR→USD example did. The tool does not replace the lesson from chapter 17 ("your test
data has a comfort zone"); it gives you a place to write the lesson down *once* — in the
`Currency` generator — and have it apply to every money test from then on.

**Query-count assertions.** A test helper that counts the SQL statements a request
issued, so that a list endpoint can assert "this took at most 3 queries" and an
accidental N+1 fails the build rather than a load test months later.

**Snapshot tests for the contract template.** The rendered employment agreement is a
long text. Rather than asserting on fragments, store the whole expected document and diff
against it; a change to the template then shows up as a reviewable text diff.

### 12.7 The journey test

It ports step for step — register, quote, hire, accept invite, contract, documents,
checklist, time off, expense, payroll, invoice, payslip — with one significant addition.
In chapter 15 its best assertion was that the quoted employer cost equalled the billed
one. In the .NET version both numbers come from the same C# function, so that is still
true by construction. But there is now a seam that did not exist before, and the journey
test should cross it:

> The React app, built against the **generated** types, completes the same flow against
> the .NET API in a real browser.

That is the build journal's browser flow from chapter 18.6, promoted from a throwaway
script to a committed test. It is the only thing that proves the two halves — now in two
languages — still fit.

**Lesson — every boundary you add needs a test that crosses it.** One language, one
process: unit and integration tests were enough. Add a language boundary and you need
contract tests. Add a generated client and you need the generation gate. The test suite's
shape should mirror the system's seams.

---

# Part III — Building it with agents

## 13. Delegation on .NET: what changes

The method from the build journal's chapter 11 is about the problem of parallel work, so
it carries over intact: pre-write everything shared, give each builder a disjoint file
list, one database each, a written contract, a required report. What changes is the
*mechanics*, and three of them are sharp enough to break a parallel build on the first
attempt.

### 13.1 The build output is a shared resource

In the TypeScript build, a builder's check was `npx tsc -p apps/api` — a typecheck that
writes nothing. Three builders could run it at the same moment in the same folder.

`dotnet build` **writes files**: compiled assemblies into `bin/`, intermediate files
into `obj/`. Three builders building the same solution in the same working tree will
collide on those files. On Windows, where an open file is locked, the result is builds
that fail with file-in-use errors that have nothing to do with anyone's code — which is
precisely the "looks like a real bug, is not" failure the build journal's chapter 11.1
ranked as the second most expensive.

This is the npm-install lesson in a new costume, and it has the same shape of answer:
*find the shared resource, then either serialise access or give everyone their own.*

| Option | How | Trade-off |
| --- | --- | --- |
| **A git worktree per builder** | Each builder gets its own checkout of the repo on its own branch | Cleanest isolation; each worktree restores and builds separately (slower start); merging becomes a real step |
| A separate build-output folder per builder | Point each builder's build at its own artifacts directory **⚑ verify the flag** | One working tree, isolated outputs; builders must remember the flag every time |
| One builder at a time builds | The lead runs builds serially | No isolation needed; throws away most of the parallelism |

The lead chooses **worktrees**. The decisive reason is the next section.

### 13.2 The migration snapshot is a merge-conflict magnet

EF Core migrations come with a *model snapshot* — one generated file describing the
whole database model. Every `dotnet ef migrations add` rewrites it. Two builders who each
add a migration both rewrite that one file, in incompatible ways; whichever merges second
has a snapshot that no longer matches the migrations before it.

The build journal sidestepped this entire problem without naming it: the lead wrote the
*complete* schema before any builder started, so no builder ever needed a migration.
On .NET that decision is promoted from "good idea" to "hard rule in the brief":

> **Builders do not create migrations.** The schema is final. If you believe a table or
> column is missing, describe it in your report. Only the lead runs `dotnet ef migrations
> add`.

### 13.3 One restore, like one install

`dotnet restore` downloads packages into a machine-wide cache and writes per-project
files under `obj/`. The rule from the build journal still applies and for the same
reason: the lead restores once, before anyone starts, and the briefs forbid adding
packages. With central package management (chapter 4.4), "adding a package" is an edit to
one shared file — which a builder is not allowed to touch anyway.

### 13.4 The compiler becomes a reviewer

Here is where .NET helps an agent-driven build rather than complicating it.

With nullable reference types on, warnings as errors, the analyzers enabled and the
architecture tests in place, a builder gets a *great deal* of feedback before a human
looks at anything:

- pass a `UserId` where a `WorkerId` is expected → does not compile;
- return an entity from an endpoint → architecture test fails;
- reference another module → architecture test fails;
- call `Math.Round` or `DateTime.Now` → analyzer error;
- forget to pass a `CancellationToken` → analyzer error;
- dereference something that might be null → compile error.

Each of those is a rule the TypeScript build stated in `CLAUDE.md` and hoped for. Rules
an agent can *check for itself in a loop* are followed far more reliably than rules it
has to remember — the agent sees the red build, reads the message, fixes it, and never
needs the lead. That is the same insight as chapter 9 of the build journal ("an AI
matches the style of what it is shown far more reliably than the style it is told
about"), one step further: best of all is what it is **stopped from doing**.

The briefs get correspondingly shorter. A whole section of "things that are easy to get
wrong" turns into "the build will tell you".

**Lesson — every rule you can turn into a compiler error, an analyzer or a test is a
rule you no longer have to brief, review or trust.** With human teams that is a nice
efficiency. With agents it is the difference between a rule that holds and one that
holds only as long as it is remembered.

### 13.5 What a .NET brief adds

The common brief from `docs/briefs/wave1-common.md` would be reused nearly word for word.
The additions:

```markdown
## .NET-specific ground rules

- You are working in your own git worktree at `<path>` on branch `<name>`. Build and test
  only inside it. Do not touch any other worktree.
- Do not run `dotnet ef migrations add`. The schema is final.
- Do not edit `Directory.Packages.props`, `Directory.Build.props`, `global.json`,
  `Program.cs`, the `DbContext`, or anything under `Kernel/` or `Data/`.
- Register your module's endpoints and services in `Modules/<Name>/<Name>Module.cs`
  only (it already exists as a stub that `Program.cs` calls).
- Verify with:  `dotnet build -warnaserror`  then
  `dotnet test tests/Meridian.Api.Tests --filter "FullyQualifiedName~Modules.<Name>"`
  and `dotnet test tests/Meridian.Architecture.Tests`.
  Your test database is `<db>` (environment variable `MERIDIAN_TEST_DB`).
- Every async method takes and forwards a `CancellationToken`.
- Never call `SaveChangesAsync` more than once in an operation without an explicit
  transaction. Never call `IgnoreQueryFilters()`. Never write raw SQL — if you need a
  lock, use `Kernel/Locks`.
```

Notice the stub: `Modules/<Name>/<Name>Module.cs`, pre-written and already called from
`Program.cs`. It is the same device as the pre-written `routes.ts` stubs in the build
journal — the one file every module must hook into is created *before* the builders
start, so no builder ever edits the composition root.

### 13.6 Merging, which the TypeScript build never had to do

Because every TypeScript builder worked in the same tree on disjoint files, "integration"
was just running all the tests together (build journal, chapter 13.5). With worktrees
there is a real merge step, and the lead plans it:

1. Merge builder branches one at a time into an integration branch.
2. After each merge: build, architecture tests, that builder's module tests.
3. After all merges: the full suite, then the journey test.

With disjoint file lists the merges should be conflict-free. If one is not, that is
*information*: a builder edited something outside its list, and the brief asked it to
report that instead.

---

## 14. The build order

Putting the previous chapters in sequence. Each wave ends with evidence, not a feeling.

### Wave 0 — the lead, alone, with the assistant

| Step | Produces | What to check before moving on |
| --- | --- | --- |
| 0.1 Versions and licences | `global.json`, `Directory.Packages.props` | Every version came from a command; every licence was read |
| 0.2 Solution skeleton | Three `src` projects, three test projects, shared props | `dotnet build -warnaserror` is clean on an empty solution |
| 0.3 Domain primitives | `Money`, `Currency`, `BasisPoints`, `FxRate`, ids, `Rounding` | Ported edge-case tests pass: half-up rounding, yen conversion, proration, leap February |
| 0.4 Payroll maths | `EmploymentCost`, `Payslip`, `Proration`, lifecycles | Every case in `calc.test.ts` and `primitives.test.ts` ported and green; property tests with a currency generator that includes JPY |
| 0.5 EF Core model | Entities, configurations, first migration | Scripted migration diffed against `0000_init.sql`; every difference explained in writing |
| 0.6 Kernel | Config, error handler, session auth, policies, tenant filter, audit, locks, onboarding seam | App refuses to start with a missing setting; each tenant-filter escape hatch has a guard test |
| 0.7 Architecture tests | The structural rules | Each rule demonstrated to **fail** when deliberately violated, then reverted |
| 0.8 Reference module | `Auth` and `Organizations`, with tests | Every test in `auth.test.ts` and `organizations.test.ts` has a counterpart |
| 0.9 Contract plumbing | OpenAPI emission, TypeScript generation, contract tests, CI diff gate | The React app's login and team pages work against the .NET API, changed only in their type imports |
| 0.10 Module stubs and briefs | One `…Module.cs` per module; worktrees; test databases | A stub build is green in every worktree |

Step 0.7 contains a habit worth pulling out. An architecture test, a guard, an analyzer
rule — each of these is a claim that "this mistake will be caught". The only way to know
the claim is true is to *make the mistake on purpose* and watch the build go red. The
build journal asked of every test, "what change to the code would make this fail?"
(chapter 9.5). For a safeguard, do not just ask. Try it.

Step 0.9 is the one with no equivalent in the TypeScript build, and it is deliberately
placed *before* delegation. If the generated types do not line up with what the React app
expects, that is a foundation problem, and discovering it after twelve modules are built
would mean twelve modules of rework.

### Wave 1 — three builders, backend modules

The same split as before — People, Work, Money — because the split followed the domain's
natural seams, not the language. Each in its own worktree, on its own database.

### Wave 2 — there is no frontend wave

This is where the "keep React" decision from chapter 3.3 pays out in schedule. The
TypeScript build needed three more builders and twenty pages here. The .NET build needs
one person to swap the type imports from `@meridian/shared` to the generated file, change
the hire form's cost preview to call the API (chapter 5.5), and re-run the browser sweep.

### Wave 3 — verification, in the same order as before

1. Every builder's suites re-run by the lead.
2. The full suite, together.
3. The journey test.
4. The browser sweep and click-through flow against the .NET API.
5. An independent review, with the same prompt as the build journal's chapter 17 — plus
   the checklist from chapter 16 of *this* journal, which lists the failure modes the new
   stack adds.

---

# Part IV — Judgement

## 15. The fifteen bugs, replayed

The build journal's chapter 19 tabulated every real defect and what found it. The most
useful thing this thought experiment can do is run that table again and ask, of each one:
**would a C# and .NET build have prevented it?**

The answers are sorted into four honest categories, because "the language would have
caught it" is claimed far more often than it is true.

- **Prevented** — the mistake does not compile, or cannot be expressed.
- **Harder** — still possible, but the natural way to write the code avoids it.
- **Unchanged** — the bug is in logic, a specification, the database or the frontend. The
  language is irrelevant.
- **Different** — the tooling removes this problem and typically supplies another.

| # | Defect | On .NET | Why |
| --- | --- | --- | --- |
| 1 | Yen invoices under-billed 100× | **Harder** | A `Money` type carries its currency, so the conversion has the information the original lacked (chapter 6.2). Still expressible by reaching for `.Minor`. Still shipped if no test uses yen. |
| 2 | Login bounces back to the login page | **Unchanged** | A React state bug. The frontend is not being rewritten. |
| 3 | `formatBps(2000)` shows "2%" | **Unchanged** | Frontend formatting. (The same slip is just as writable in C#.) |
| 4 | Team invite destroys a worker's portal invite | **Unchanged** | A logic error: a delete that was too broad. No type system has an opinion on which invitations a query should match. |
| 5 | Malformed `X-Org-Id` → 500 | **Prevented** | A value bound as `Guid` cannot be a non-GUID when it reaches a query. |
| 6 | Tables widen the page on phones | **Unchanged** | CSS. |
| 7 | Hiring an email that already has a login → dead invite | **Unchanged** | A gap in the specification. |
| 8 | Cancelled hire keeps a working login | **Unchanged** | A gap in the specification. |
| 9 | The fix for #7 applied only when an invite was sent | **Unchanged** | An incomplete fix to a specification gap. |
| 10 | Deadlock: sign versus cancel | **Unchanged** | Lives in the database (chapter 9.4). A single locking helper makes the rule easier to follow; it does not enforce it. |
| 11 | Stale read when voiding a signed contract | **Harder** | An optimistic concurrency token rejects a write based on a stale row (chapter 9.2) — for that row. A stale read of a *different* row still slips through. |
| 12 | Cancelled hire could keep an active contract | **Unchanged** | A gap in the specification. |
| 13 | A search-escaping test that could not fail | **Unchanged** | A test whose data did not exercise the behaviour. Language-independent. |
| 14 | Recalculate did not release every claimed expense | **Unchanged** | A wrong filter condition. |
| 15 | Slow suite: 350 ms of cleanup per test | **Different** | A reset library deletes in dependency order by default, so this never arises. xUnit's parallel-by-default supplies a new problem in its place (chapter 12.4). |

### The count

| Outcome | Bugs |
| --- | --- |
| Prevented | 1 |
| Harder | 2 |
| Different | 1 |
| **Unchanged** | **11** |

Eleven of fifteen are untouched by the choice of language. That is the single most
important number in this document, and it deserves to be read slowly.

Look at what the eleven have in common. Four are gaps in the *specification* (#7, 8, 9,
12): the code did what was asked and what was asked was incomplete. Three are in the
*frontend* (#2, 3, 6). Two are plain *logic* slips (#4, 14). One is a *test* that proved
nothing (#13). One lives in the *database* (#10).

None of those is the kind of mistake a compiler is in a position to notice. A compiler
checks that the code is consistent with itself. It has no way to know that a terminated
worker should keep read access to their payslips.

And the three that .NET does improve are all the same *kind* of bug: a value used
without the information that should have travelled with it — an amount without its
currency (#1), a string that should have been an id (#5), a row without its version
(#11). That is exactly what a type system is for. It is real, and it is a narrow slice.

**Lesson — a stronger type system prevents a specific family of bugs: values used
without their context. It does nothing for wrong requirements, wrong logic, or wrong
assumptions.** Those were the majority here, and they are the majority in most systems.
What found them in the build journal was not a tool. It was a contract precise enough to
have gaps pointed out, builders required to state their doubts, a reviewer with fresh
eyes, and somebody clicking through the product. None of that changes with the language,
and all of it would be needed again.

### What this means for the decision

If the argument for a rewrite is "C# would have caught our bugs", the evidence from this
project says: one in fifteen, with two more made less likely. That is not nothing — #1
was the most severe defect in the whole build, and making it unnatural to write is worth
something. But it is nowhere near enough to justify a rewrite on its own. The
justification has to come from chapter 1's list: who maintains it, what surrounds it,
what it must become.

---

## 16. The new ways to get it wrong

A rewrite does not only remove failure modes. It introduces the new platform's own. A
journal that listed only what gets better would be an advertisement, so here is the other
side: the mistakes that **could not have been made** in the TypeScript build and become
possible on .NET.

This list is also the extra checklist the independent reviewer would be handed in
Wave 3.

| # | New failure mode | How it happens | Guard |
| --- | --- | --- | --- |
| N1 | **Banker's rounding** | `Math.Round` defaults to round-half-to-even; payroll expects half-up | One `Rounding.HalfUp`; analyzer bans `Math.Round`; ported edge-case test |
| N2 | **Enums serialised as numbers** | The JSON default; the contract and the React app expect strings | Global converter; contract tests against stored JSON |
| N3 | **Stale generated client** | A C# type changes and nobody regenerates the TypeScript | CI regenerates and fails on any diff |
| N4 | **Cascade delete by convention** | EF Core cascades required relationships unless told otherwise; payroll history is deleted with a worker | Set `Restrict` model-wide; diff the migration SQL against the original |
| N5 | **Tenant filter bypassed** | `IgnoreQueryFilters()`, raw SQL, or an insert carrying another tenant's id | Architecture test on the method; raw SQL confined to one class; insert interceptor |
| N6 | **"No tenant" treated as "all tenants"** | A job or admin path with no tenant in context skips the filter | The tenant context throws; a test proves it |
| N7 | **Two `SaveChanges` calls in one operation** | The unit-of-work guarantee quietly becomes two transactions | Rule in the brief; review item; explicit transaction where genuinely needed |
| N8 | **N+1 queries** | Lazy loading, or a navigation property touched in a loop | Lazy loading off; projections; query-count assertions |
| N9 | **Culture-sensitive string operations** | `ToLower()` under a Turkish locale; number parsing with a comma decimal separator | `ToLowerInvariant`, `CultureInfo.InvariantCulture`; analyzer rules |
| N10 | **Local time sent to `timestamptz`** | `DateTime.Now` or an unspecified `Kind` | `DateTimeOffset` in UTC; `TimeProvider`; ban `DateTime.Now` |
| N11 | **Captive dependency** | A singleton service holds a scoped `DbContext`, sharing one context — and one tenant — across requests | Scope validation on at startup; the `DbContext` is never injected into a singleton |
| N12 | **Blocking on async** | `.Result` or `.Wait()` on a task: thread-pool starvation under load | Analyzer rule; async all the way down |
| N13 | **Dropped cancellation** | A method does not forward its `CancellationToken`; abandoned requests keep running queries | Analyzer rule |
| N14 | **Validators do not normalise** | The zod schemas trimmed and lower-cased; a validator only checks, so an un-normalised email reaches a query | Normalising value types (`Email`) rather than raw strings |
| N15 | **Existing password hashes rejected** | The framework's hasher does not understand the old scrypt format; nobody can log in | A hasher that verifies both and re-hashes on success (chapter 10.4) |
| N16 | **Options not validated at startup** | `ValidateOnStart()` omitted; the app boots with a missing setting and fails on first use | A test that boots with a setting removed |
| N17 | **Over-posting** | Binding a request directly onto an entity lets a client set fields it should not | Requests are dedicated record types, never entities; architecture test |
| N18 | **Shared build output** | Parallel builders collide on `bin/` and `obj/` | A worktree per builder |
| N19 | **Model-snapshot conflicts** | Two builders add migrations | Only the lead adds migrations |
| N20 | **Parallel tests on one database** | xUnit runs classes in parallel by default | One collection, or a database per worker |

Twenty new ways to fail, against three old ones made less likely. That comparison is
*not* the argument against .NET it might look like — and it is worth being precise about
why.

Nearly every row in that table has a guard that is **mechanical**: an analyzer, a
compiler setting, an architecture test, a CI gate. Set up once, in Wave 0, they hold
with no one's attention. The TypeScript build's equivalent risks were guarded by
*convention and review*. So the true picture is:

- .NET has **more** sharp edges than the TypeScript stack did,
- and **better tools for blunting them permanently**,
- but only if someone knows the edges exist and sets the guards up **before** the first
  feature is written.

A team that knows the platform pays that cost in the first week and rarely thinks about
it again. A team — or an AI model — porting from another ecosystem and assuming the
defaults are the same is likely to hit N1, N2, N4 and N9 early, and each will look like a
mysterious one-in-a-thousand bug.

**Lesson — the dangerous part of a new platform is not what it lacks; it is the defaults
that differ from the ones you are used to.** You will not look up what you believe you
already know. Before porting anything, list the defaults explicitly: rounding, string
comparison, time zones, serialisation, delete behaviour, test parallelism. Then write a
test for each.

---

## 17. If we really had to migrate

Chapters 4 to 14 described building on .NET from an empty repository. This chapter
answers the other question from chapter 1: a decision has been made, for reasons outside
the code, that the *existing, working* Meridian must move. How?

### 17.1 Not a big bang

The obvious plan — build the whole .NET API beside the old one, then switch over one
night — fails in a characteristic way. For months, two systems exist and only one has
users. Every bug fixed in the old system must be fixed again in the new one, or it is
lost. Nobody knows whether the new system works until the switch. And the switch is all
or nothing: if payroll is wrong the next morning, the choices are to roll everything back
or to fix a live payroll system under pressure.

### 17.2 The strangler approach

Named after a fig that grows around a host tree until, eventually, the host is gone and
the fig is standing in its shape. Put a reverse proxy in front of both APIs. At first it
sends every request to the old one. Then, one module at a time, a route is redirected to
the new implementation.

```
                       ┌──────────────────────────┐
  browser ──▶ proxy ──▶│  /api/v1/countries/**    │──▶  .NET API   (migrated)
                       │  /api/v1/quotes/**       │──▶  .NET API
                       │  everything else         │──▶  Node API   (not yet)
                       └──────────────────────────┘
                                       │
                         both read and write the SAME Postgres
```

Each step is small, visible to real traffic, and reversible by changing one routing
rule. This only works because of two decisions made much earlier:

- **The schema is identical** (chapter 2), so both implementations can share one database
  with no synchronisation.
- **Sessions are opaque rows in a table** (ADR 0004), so a cookie issued by one API is
  understood by the other. Had the build chosen signed tokens, both sides would have had
  to share signing keys and agree on claims from the first day.

Neither decision was made with a migration in mind. Both were made because they were the
simple, explicit option. That is a pattern worth noticing: *boring, explicit designs
migrate well*, because their state is in plain sight rather than inside a framework.

### 17.3 The test suite is already a portable specification

Here is the most valuable asset the first build left behind, and it is easy to overlook.

The 385 API tests are written **through HTTP**. They send requests and check responses.
They do not import the service functions; they do not know the server is written in
TypeScript. They are, in effect, an executable version of `docs/api-contract.md`.

So before porting a single test to xUnit, the lead would make one small change to the
existing test harness: let `client()` target a base URL instead of the in-process Express
app.

```
MERIDIAN_API_URL=http://localhost:5000  npx vitest run src/modules/countries
```

The *existing* TypeScript suite would then run against the *new* .NET API. A module is
"done" when its old tests pass against its new implementation. The definition of correct
is not re-derived, re-interpreted or re-typed; it is the same file that passed yesterday.

Two caveats, stated plainly so nobody is surprised:

- The factories insert rows directly through Drizzle. That still works — the schema is
  the same — but it means the old test suite keeps a Node toolchain in the repository
  until the migration is over.
- A few tests reach into internals (the login rate limiter's `reset()`, for instance, and
  tests that edit rows mid-test). Those need a test-only hook or a small rewrite. This
  has not been tried; expect the list to be longer than it looks from here.

The xUnit suite from chapter 12 is still written — the .NET team needs tests in its own
language to keep the system healthy afterwards. But it is written *alongside* an oracle,
not instead of one.

**Lesson — tests written against the public interface outlive the implementation.** The
build journal chose HTTP-level integration tests because they exercise the real stack. It
turns out they have a second property nobody was aiming for: they are
implementation-independent, so they can judge a replacement. Tests that call internal
functions would have been worthless here.

### 17.4 The order

Easiest and safest first, so the team learns the platform's sharp edges (chapter 16)
where a mistake is cheap.

| Step | Module | Why here |
| --- | --- | --- |
| 1 | Countries, quotes | Read-mostly reference data; exercises the domain maths against known answers |
| 2 | Audit log, dashboard | Read-only; proves the tenant filter on every table |
| 3 | Auth, organizations, team | Proves shared sessions and the password-hash bridge (chapter 10.4) |
| 4 | Workers, onboarding, documents | First real writes; the onboarding seam |
| 5 | Contracts, time off, expenses | The row locks and the lock-ordering rule |
| 6 | Invoices | Money, FX, the sequence |
| 7 | **Payroll — last** | The most consequential module moves only when every sharp edge has already been found somewhere less important |

Payroll going last is the whole point of the ordering. It is the module where N1
(rounding) would cost real money, so it is migrated by a team that already met N1 in
step 1, on a cost calculator, with a test that said "expected 167, got 166".

One complication the table hides: payroll approval issues the invoice *inside its own
transaction*, and document verification and contract signing both call the onboarding
seam. Modules that share a transaction cannot sit on opposite sides of the proxy. Steps 4
and 5 probably have to move together, and so do 6 and 7. The plan above is an order of
*attention*; the actual cut-over units are whatever commits together.

### 17.5 Two rules while both systems are live

**One writer per table at a time.** While a module is mid-migration, exactly one
implementation writes its tables. Both may read. Otherwise the two implementations'
slightly different assumptions will meet in the data.

**One owner of the schema.** During the migration, schema changes are made by exactly
one tool. Two migration systems each believing they own the database is how a column
gets dropped.

### 17.6 When it is finished

The migration is over when the proxy routes nothing to the Node API, that has been true
for long enough to include a complete payroll cycle, and the old service has been
*deleted* — not merely switched off. A system that is "kept around just in case"
continues to need security patches, continues to appear in every architecture diagram,
and one day gets switched back on by somebody who does not know why it was switched off.

---

## 18. The verdict

Three questions were separated in chapter 1. Here are the three answers.

### 18.1 Should the existing system be migrated?

**No — not on the evidence inside this repository.**

The costs are concrete: the shared contract package is replaced by a generation pipeline
that reaches *almost* the same guarantee (chapter 5); twenty new failure modes need
guards (chapter 16); the backend is rebuilt and re-verified. The benefits found by
replaying real defects are narrow: one bug prevented, two made less likely (chapter 15).

There is no technical problem here that the language is causing. A migration would be
justified only by something this repository cannot see — the people who will own it, the
systems around it, a requirement from outside. If such a reason exists, chapter 17 is how
to do it without betting the product on one night.

### 18.2 Starting from nothing, would .NET be a reasonable choice?

**Yes — and so would TypeScript.** This is the less dramatic answer and the true one.

| Choose .NET when… | Choose TypeScript when… |
| --- | --- |
| The team's depth is in C# | The team's depth is in TypeScript |
| The domain model is the hard part and will keep growing — money, lifecycles, many kinds of id | The product is mostly screens over data, and speed of change is the priority |
| The system must sit among other .NET services, with shared deployment and monitoring | One small team owns both the API and the web app |
| You want structural rules enforced by compiler, analyzers and architecture tests | You value one language, one toolchain and types shared by construction |
| Long-lived, regulated, many maintainers over many years | Early, exploratory, likely to change shape |

For *this* domain — payroll, multi-currency money, tenant isolation, records that have to
be right — the things .NET is good at line up unusually well with the things that matter:
`Money` as a type, tenant isolation as a mechanism (chapter 8), safeguards a compiler
checks. If the lead were starting Meridian again with a team equally fluent in both, the
choice of .NET for the backend would be easy to defend.

It would not be free. The contract problem (chapter 5) is a permanent tax: a pipeline to
maintain, a CI gate to keep green, and validation and domain logic that can no longer
simply run in the browser.

### 18.3 What did the thought experiment teach?

This is the answer that matters most, and it is the sorting promised in chapter 1.

**Decisions that did not move — they were about the problem:**

- Understand the domain before modelling it; write down what you will not build.
- Money as integer minor units with its currency; one rounding function.
- A tenant id on every tenant-owned table; a record in another tenant is a 404.
- Business rules as database constraints wherever possible.
- State machines as data.
- The audit record commits with the change it describes.
- Thin handlers; rules in services; never return a database row.
- A written contract precise enough to build against without meeting.
- Integration tests through the public interface against the real database.
- One test that crosses every seam.
- An independent review; looking at the running product; a written list of known gaps.

Every one of those appears in both journals with a different spelling and the same
meaning. They are what you actually learned, and they go with you to any stack.

**Decisions that moved — they were about the tools:**

- *How* tenant isolation is enforced: a convention in every query → a global filter.
- *How* the transaction is shared: a handle passed to every helper → a unit of work.
- *How* the client and server agree on types: shared source → generated from OpenAPI.
- *Where* domain logic can run: anywhere → on the server.
- *How* test data is reset: a hand-ordered list with a guard test → a library.
- *How* structural rules are enforced: a paragraph in `CLAUDE.md` → architecture tests.
- *How* parallel builders are isolated: disjoint files in one tree → a worktree each.

Knowing which list a lesson belongs on is the difference between experience and habit. A
habit says "we always thread the transaction through". Experience says "the audit row
must commit with the change — *here*, that means threading the transaction through".

### 18.4 One sentence

The language decides how a rule is *enforced*. It does not decide what the rules *are* —
and in this project, eleven bugs out of fifteen were about what the rules are.

---

# Appendices

## Appendix A — File-by-file map

Where each part of the TypeScript build would live in the .NET solution.

| TypeScript build | .NET proposal | Note |
| --- | --- | --- |
| `packages/shared/src/enums.ts` | C# enums in `Meridian.Domain` and module `Contracts.cs` | Serialised as snake_case strings (ch. 5.3) |
| `packages/shared/src/state-machines.ts` | `Meridian.Domain/Lifecycles/*` | Needs an exhaustiveness test (ch. 6.7) |
| `packages/shared/src/money.ts` | `Meridian.Domain/Money/*` | `Money`, `Currency`, `BasisPoints`, `Rounding` |
| `packages/shared/src/dates.ts` | `DateOnly` + `Meridian.Domain/Time/*` | Mostly replaced by the platform type |
| `packages/shared/src/calc.ts` | `Meridian.Domain/Payroll/*` | Still pure; now cannot reference I/O |
| `packages/shared/src/schemas.ts` | Request records + validators, per module | No longer shared with the browser (ch. 5.4) |
| `packages/shared/src/dto.ts` | Response records, per module → OpenAPI → generated TypeScript | ch. 5.2 |
| `apps/api/src/config.ts` | Options classes + `ValidateOnStart` | ch. 10.1 |
| `apps/api/src/db/schema.ts` | Entities + `IEntityTypeConfiguration` classes | ch. 7.1 |
| `apps/api/drizzle/*.sql` | EF Core migrations (C#), scripted to SQL for review | Must equal the original |
| `apps/api/src/db/reference-data.ts` | `Data/ReferenceData.cs` | Same data |
| `apps/api/src/db/seed.ts` | `Meridian.Seed` console app | Still drives the HTTP API |
| `apps/api/src/lib/errors.ts` | `Kernel/Errors/*` + `IExceptionHandler` | ch. 10.2 |
| `apps/api/src/lib/http.ts` | Mostly deleted — model binding, route constraints | `uuidParam` becomes `{id:guid}` |
| `apps/api/src/lib/crypto.ts` | `PasswordHasher<T>` + legacy scrypt verifier | ch. 10.4 |
| `apps/api/src/lib/sessions.ts` | `Kernel/Auth/SessionAuthenticationHandler.cs` | Same table |
| `apps/api/src/lib/actor.ts` | `Kernel/Actor.cs` + `ITenantContext` | Actor explicit, tenant ambient (ch. 10.5) |
| `apps/api/src/lib/audit.ts` | `Kernel/Audit.cs` | Adds to the unit of work (ch. 7.4) |
| `apps/api/src/lib/onboarding.ts` | `Kernel/Onboarding/*` | The cross-module seam, unchanged in role |
| `apps/api/src/lib/invoicing.ts` | `Kernel/Invoicing/*` | Called by payroll |
| `apps/api/src/lib/rate-limit.ts` | Built-in rate limiter | Same known gap |
| `apps/api/src/lib/logger.ts` | `ILogger` + OpenTelemetry | Built in |
| `apps/api/src/middleware/auth.ts` | Authentication handler + authorization policies | Fallback policy: secure by default |
| `apps/api/src/middleware/security.ts` | `Kernel/OriginCheckMiddleware.cs` | Ported as is |
| `apps/api/src/middleware/error-handler.ts` | `IExceptionHandler` | |
| `apps/api/src/app.ts`, `server.ts` | `Program.cs` | Shutdown, health, logging come built in |
| `apps/api/src/modules/<name>/routes.ts` | `Modules/<Name>/<Name>Endpoints.cs` | |
| `apps/api/src/modules/<name>/service.ts` | `Modules/<Name>/<Name>Service.cs` | |
| `apps/api/src/test/helpers.ts` | `tests/Meridian.Api.Tests/Support/*` | `WebApplicationFactory`, factories |
| `apps/api/src/test/cleanup.ts` (+ guard test) | A reset library | List and guard both disappear |
| `apps/api/src/test/journey.test.ts` | `JourneyTests.cs` + a browser journey | ch. 12.7 |
| `CLAUDE.md` rule 9 (modules do not import modules) | `Meridian.Architecture.Tests` | Convention → test |
| `apps/web/**` | **Unchanged**, except type imports and the cost preview | ch. 3.3, 5.5 |

## Appendix B — Vocabulary, for someone coming from TypeScript

| .NET term | Closest thing you already know |
| --- | --- |
| **Solution** (`.sln`) | The monorepo root: a list of projects that belong together |
| **Project** (`.csproj`) | A workspace package — but the compiler enforces what it may reference |
| **Assembly** | The compiled output of one project (a `.dll`) |
| **NuGet** | npm |
| **`record`** | An immutable object type with value equality; ideal for DTOs |
| **`record struct`** | The same, stored inline — good for tiny values like `Money` or an id |
| **Nullable reference types** | `strictNullChecks` |
| **Analyzer** | An ESLint rule that runs inside the compiler |
| **Minimal API** | An Express route: a path mapped to a function |
| **Middleware** | Express middleware; same idea, same ordering concerns |
| **Endpoint filter** | Middleware scoped to one route or group |
| **Dependency injection** | The framework constructs your classes and hands them what they ask for |
| **Scoped service** | One instance per HTTP request |
| **Singleton service** | One instance for the whole process |
| **`DbContext`** | The database client *and* a unit of work that tracks changes |
| **Change tracker** | EF Core's memory of what you loaded and what you changed since |
| **Migration** | Same meaning; here written in C# and scripted to SQL |
| **Global query filter** | A `WHERE` clause the ORM adds to every query for an entity type |
| **`ClaimsPrincipal`** | The framework's representation of "who is signed in" |
| **Policy** | A named authorization rule (`RequireRole(…)`) |
| **Problem Details** | A standard JSON shape for API errors |
| **`CancellationToken`** | A signal passed down a call chain meaning "the caller has given up" |
| **`TimeProvider`** | An injectable clock, so tests can choose the date |
| **xUnit `[Fact]` / `[Theory]`** | `it(…)` / `it.each(…)` |
| **`WebApplicationFactory`** | `supertest(createApp())` |
| **Architecture test** | A unit test whose subject is the dependency graph |

## Appendix C — Command cheat-sheet

Illustrative. Confirm flags against the installed SDK with `dotnet <command> --help`.

```bash
# what is installed
dotnet --list-sdks

# create the skeleton
dotnet new sln -n Meridian
dotnet new classlib -o src/Meridian.Domain
dotnet new web      -o src/Meridian.Api
dotnet new xunit    -o tests/Meridian.Domain.Tests
dotnet sln add src/Meridian.Domain src/Meridian.Api tests/Meridian.Domain.Tests

# everyday
dotnet build -warnaserror
dotnet test
dotnet test --filter "FullyQualifiedName~Modules.Payroll"
dotnet run --project src/Meridian.Api

# database (lead only)
dotnet ef migrations add <Name> --project src/Meridian.Api
dotnet ef migrations script --idempotent -o migration.sql      # read this before applying
dotnet ef database update --project src/Meridian.Api

# one isolated checkout per builder
git worktree add ../meridian-builder-a -b builder-a
```

## Appendix D — Claims to verify before acting on this document

This journal was written without building anything, by an author whose knowledge of
library versions and licences has an expiry date. Each item below is a claim the text
depends on. Check it with a command or the project's own documentation before relying on
it.

| ⚑ | Claim | How to check |
| --- | --- | --- |
| 1 | Which .NET release is the current long-term-support version | `dotnet --list-sdks`; the official support-policy page |
| 2 | Current stable versions of EF Core and the Npgsql EF Core provider, and that they match the chosen .NET version | NuGet |
| 3 | The current licence of every third-party library named or implied here — in particular the validation library, the mediator and mapping libraries the proposal avoids, the assertion library, and the test-database reset library | Each project's repository and NuGet page |
| 4 | How ASP.NET Core emits an OpenAPI document in the chosen version, and which generator produces TypeScript types from it | Official ASP.NET Core documentation |
| 5 | Whether minimal APIs have built-in request validation in the chosen version, and what it covers | Official documentation and release notes |
| 6 | The provider's current API for mapping Postgres enum types | Npgsql EF Core provider documentation |
| 7 | The provider's current API for using `xmin` (or another column) as a concurrency token | Npgsql EF Core provider documentation |
| 8 | The package and configuration for snake_case naming conventions in EF Core | NuGet; the package's readme |
| 9 | How the Postgres driver currently treats `DateTime` values of different kinds sent to `timestamptz` | Npgsql documentation on date and time handling |
| 10 | Exactly what the antiforgery feature covers for minimal APIs and JSON bodies | Official ASP.NET Core security documentation |
| 11 | The flag or property for redirecting build output to a separate artifacts directory | `dotnet build --help`; MSBuild documentation |
| 12 | `PasswordHasher<T>`'s current algorithm, iteration count and stored format | Official documentation; the source |
| 13 | Whether EF Core in the chosen version supports more than one query filter per entity, and how they are selectively disabled | EF Core release notes |
| 14 | The architecture-testing library's current API (the snippet in chapter 4.3 follows the general shape of such libraries, not a checked signature) | The library's readme |

Fourteen things to look up. The build journal's chapter 4 made the case for doing so:
*"an AI's library knowledge has an expiry date; check versions with a command, then
pin."* A design document is a plan, and a plan built on an unverified assumption fails at
the worst possible moment — after the work that depends on it has been done.

---

*This journal proposes; it does not record. If the rewrite is ever undertaken, the right
next document is a third journal — one that pastes real output again, and that says, for
each of the claims above, whether it turned out to be true.*
