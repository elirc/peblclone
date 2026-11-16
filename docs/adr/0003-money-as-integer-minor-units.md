# ADR 0003 — Money as integer minor units

**Status:** accepted

## Context
Payroll and invoicing arithmetic must be exact and reproducible. Binary floating point
cannot represent most decimal fractions (`0.1 + 0.2 !== 0.3`).

## Decision
- Amounts are integers in minor units (cents), always paired with an ISO 4217 currency.
- Postgres type `bigint`; JavaScript type `number`.
- Percentages are integer basis points.
- All rounding goes through one function, `roundHalfUp`, in `packages/shared/src/money.ts`.
- Monthly amounts derived from annual ones are rounded per month; the sub-cent drift over
  twelve months is accepted rather than "trued up" in month twelve.
- FX rates are Postgres `numeric` (decimal strings in JS); conversion multiplies as
  `number` and rounds once at the end.

## Consequences
- JavaScript integers are exact to 2^53−1. Request validation caps any single amount at
  10^12 minor units, keeping realistic sums far inside that range. If the product ever
  handles larger magnitudes, switch to `bigint` end to end.
- Zero-decimal currencies (JPY) are handled by `minorUnitDigits` when formatting/parsing.
- A real payroll product would need per-country rounding rules and a year-end true-up.
  Out of scope, and the seam is `calc.ts`.
