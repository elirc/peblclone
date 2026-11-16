# User stories, part 2 — thirty mid-level design tasks

Stories **US-21 to US-50**. None is implemented.

Part 1 ([US-01 to US-20](../README.md)) told you which lines to change. These do not.
A mid-level engineer is rarely handed the lines — they are handed a problem and expected
to work out the design. So each story here gives you:

- the **story** and **acceptance criteria**;
- **the concept** — the piece of system design the story is really about, explained from
  first principles;
- **the design decision** — the realistic options, what each costs, and a recommendation;
- **where it touches this codebase** — files and existing patterns to build on;
- **hints** — ordered nudges, a schema sketch or a SQL fragment where the idea needs one,
  but not a finished implementation;
- **how to test it**, **what goes wrong**, and **questions to be able to answer** before
  you call it done.

## How to work a story

1. Read **the concept** until you could explain it to someone else. If you cannot, read
   the linked chapter of the [build journal](../../JOURNAL.md) it refers to.
2. Write down your design in five lines **before** opening an editor: tables, endpoints,
   the invariant you are protecting, and how you will test it. Compare with "the design
   decision". Disagreeing is fine — being able to say *why* is the skill.
3. Follow the same loop as part 1: contract first, then schema, then service, then tests,
   then UI. Update `docs/api-contract.md` in the same commit as any endpoint change.
4. Answer the **questions** at the end in your pull-request description. They are the
   questions a reviewer would ask.

## A warning about these documents

They were written by reading the code at commit `32922c7`, not by building the stories.
The designs are sound in general, but nobody has implemented them here, so details may
not fit as neatly as the text implies. Where a hint names a library feature or a Postgres
behaviour, **check it against the documentation** — that habit is part of the job
(build journal, chapter 4).

Some hints sketch SQL or a table definition. Treat a sketch as the *shape* of an answer.

## The stories

| # | Theme | Story | Core idea |
| --- | --- | --- | --- |
| **Data and domain** | | | [21–26](21-26-data-and-domain.md) |
| US-21 | data | Salary history | effective-dated records |
| US-22 | data | Off-cycle payroll adjustments | corrections as new entries, never edits |
| US-23 | data | Public holidays in time off | reference data and derived values |
| US-24 | data | Half-day time off | changing a unit without corrupting old rows |
| US-25 | data | Notes that cannot overwrite each other | optimistic concurrency, `ETag` / `If-Match` |
| US-26 | data | Exchange-rate history | "as of" lookups and snapshots |
| **API design** | | | [27–32](27-32-api-design.md) |
| US-27 | api | Safe retries for payments | idempotency keys |
| US-28 | api | Cursor pagination for the audit log | keyset pagination |
| US-29 | api | Rename a field without breaking clients | expand / contract |
| US-30 | api | Bulk hire from a spreadsheet | batch validation, all-or-nothing |
| US-31 | api | Notify other systems when payroll is paid | the transactional outbox |
| US-32 | api | API keys for integrations | machine credentials, scopes |
| **Security** | | | [33–38](33-38-security.md) |
| US-33 | security | A second lock on tenant data | Postgres row-level security |
| US-34 | security | Two-factor sign-in | TOTP, recovery codes |
| US-35 | security | Forgotten password | reset tokens, enumeration |
| US-36 | security | Custom roles | permissions vs roles |
| US-37 | security | See and end my sessions | session lifecycle, idle timeout |
| US-38 | security | An audit log that shows tampering | hash chains |
| **Reliability and operations** | | | [39–44](39-44-reliability.md) |
| US-39 | ops | Payroll processing in the background | a job queue on Postgres, `SKIP LOCKED` |
| US-40 | ops | Reminders for overdue invoices | scheduled work, exactly-once effects |
| US-41 | ops | Documents in object storage | ports and adapters, signed URLs |
| US-42 | ops | Nothing hangs forever | timeouts, cancellation, backpressure |
| US-43 | ops | Know what the system is doing | metrics, the four golden signals |
| US-44 | ops | Live payroll status | server-sent events |
| **Frontend and quality** | | | [45–50](45-50-frontend-and-quality.md) |
| US-45 | web | Approvals that feel instant | optimistic updates and rollback |
| US-46 | web | Every list remembers its filters | URL as state |
| US-47 | web | One broken page does not break the app | error boundaries per route |
| US-48 | web | Usable with a keyboard and a screen reader | focus management |
| US-49 | web | A smaller first download | bundle analysis, code splitting |
| US-50 | quality | End-to-end tests that run on every change | a committed browser suite |

## Suggested order

They are independent, with a few natural pairs:

- **US-21 → US-22**: salary history makes back-pay calculable.
- **US-31 → US-39 → US-40**: outbox, then a queue, then scheduled work — each reuses the
  previous one's machinery.
- **US-36 → US-32**: a permission model first makes API-key scopes almost free.
- **US-28 → US-46**: cursor pagination changes what a list's URL must hold.
- **US-50 early**: an end-to-end suite makes every later story safer.
