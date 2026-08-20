# IB Calendar OS

An AI-assisted planning system for IB Diploma students. The calendar is the
canvas; the product is the constraint solver behind it.

## Status

All 20 roadmap steps are implemented. What that means concretely:

| Verified locally | Built, not live-verified |
|---|---|
| Schema + 28 DB guardrail assertions | Google Calendar sync (needs OAuth credentials) |
| Scheduling engine, 149 unit tests | Notion import (needs a Notion token) |
| Momentum, calibration, DAG, diffing | AI parsing (needs `ANTHROPIC_API_KEY`) |
| `next build`, `tsc --noEmit`, `eslint` clean | Anything requiring a live Supabase project |

The pure logic — the solver, the analytics, the sync translation layers, the AI
safety boundary — is tested. The network integrations are written and typed but
have never spoken to a real API from this machine.

## Design in one paragraph

`events` are fixed in time. `tasks` have a duration and a deadline but no
position. `scheduled_blocks` are the solver's output and the join between the
two. Solver output is *versioned* into `schedule_runs` rather than mutated in
place, which means "Reset Day", "what-if branching" and "undo" are one
mechanism rather than three features. A DAG over tasks propagates effective
deadlines backward from dependents. Sleep, exams and classes are Tier 1 and are
protected by a Postgres exclusion constraint, not by application politeness.

## The four directives, and where they live in the code

1. **Intelligence over aesthetics** — `src/lib/scheduling/` is a pure,
   dependency-free module. It never imports Supabase, `next/*`, or anything
   that reads a clock.
2. **Deterministic engine, AI at the edges** — the model has no database tool.
   It emits Zod-validated proposals into `ai_proposals`; a separate applier
   turns approved ones into writes (`src/lib/ai/`).
3. **Ironclad guardrails** — Tier 1 non-overlap, dependency acyclicity,
   single-active-run and one-open-timer are all database constraints. The
   solver is allowed to assume them because they cannot be violated.
4. **Zero anxiety** — momentum is a rolling 7-day ratio with no counter that
   can reset to zero. Rest days are excluded, not penalised. Unplaceable work
   is surfaced as a decision with ranked remedies, never as a failure notice.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase URL + keys
npm run dev
```

Apply `supabase/migrations/` to your Supabase project in filename order (SQL
editor, or `supabase db push` once linked). Never apply anything from
`supabase/tests/` — that directory contains a local shim for the managed `auth`
schema.

Google, Notion and AI features stay dormant until their keys are set; the app
reports which one is missing rather than failing opaquely.

## Testing

```bash
npm test
```

```bash
npm run db:test
```

```bash
npm run db:types
```

`npm test` runs 149 unit tests covering the solver, analytics, sync mapping and
the AI safety boundary. `db:test` needs `brew install postgresql@16` but **not**
Docker: it rebuilds a throwaway cluster, applies every migration from scratch,
and asserts the invariants the solver depends on — Tier 1 events cannot
overlap, dependency cycles are rejected at write time, only one run can be
active, blocks cannot collide within a run but may across runs, closing a timer
decrements the task, and `javascript:` context URIs are rejected before they
can reach an `href`. `db:types` regenerates `src/lib/types/database.ts`.

## Layout

```
supabase/migrations/          schema, applied in filename order
supabase/tests/               local auth shim + guardrail assertions
src/lib/scheduling/           the engine — pure, no I/O, integer minutes only
src/lib/analytics/            momentum + estimate calibration (pure)
src/lib/ai/                   proposal schemas, model client, applier
src/lib/integrations/         Google Calendar (two-way), Notion (one-way in)
src/lib/data/                 queries, snapshot assembly, run persistence
src/proxy.ts                  session refresh (NOT middleware.ts — Next 16)
scripts/                      throwaway-cluster test runner + type generator
```

See `AGENTS.md` for architecture rules and the Next 16 version traps.

## Known gaps

- No live verification of the Google, Notion or AI paths — no credentials here.
- Re-planning is user-triggered; the solver does not re-run automatically when
  a task is edited.
- Retrospectives are stored but have no dedicated UI beyond the review page.
- PWA offline support is read-only by design — no queued offline mutations,
  because a write replayed hours later could reshuffle a schedule the student
  has already acted on.
