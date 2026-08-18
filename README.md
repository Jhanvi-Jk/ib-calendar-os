# IB Calendar OS

An AI-assisted planning system for IB Diploma students. The calendar is the
canvas; the product is the constraint solver behind it.

## Current status

Roadmap steps 1–7 of 20 are complete.

- ✅ Next.js 16 (App Router) + TypeScript + Tailwind v4
- ✅ Supabase clients (browser / request-scoped / service-role) and `proxy.ts` auth
- ✅ Migrations 001–003 — 19 tables, RLS on every one, verified against real Postgres
- ✅ 25-assertion guardrail suite (`npm run db:test`)
- ✅ Semantic theme engine, magic-link auth, onboarding, week calendar, task manager
- ⬜ The scheduling engine

## Design in one paragraph

`events` are fixed in time. `tasks` have a duration and a deadline but no
position. `scheduled_blocks` are the solver's output and the join between the
two. Solver output is *versioned* into `schedule_runs` rather than mutated in
place, which means "Reset Day", "what-if branching" and "undo" are one
mechanism rather than three features. A DAG over tasks propagates effective
deadlines backward from dependents. Sleep, exams and classes are Tier 1 and are
protected by a Postgres exclusion constraint, not by application politeness.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase URL + keys
npm run dev
```

Apply the migrations to your Supabase project in filename order (SQL editor, or
`supabase db push` once linked). Do **not** apply anything from `supabase/tests/`.

## Testing the schema

No Docker needed — requires `brew install postgresql@16`:

```bash
npm run db:test
```

Builds a throwaway cluster, applies every migration from scratch, and asserts
the invariants the solver depends on: Tier 1 events cannot overlap, dependency
cycles are rejected at write time, only one schedule run can be active, blocks
cannot collide within a run (but may across runs, which is what makes what-if
branching work), and closing a timer correctly decrements the task.

## Layout

```
supabase/migrations/   schema, applied in filename order
supabase/tests/        local auth shim + guardrail assertions
src/lib/domain/        the DB ↔ solver contract
src/lib/supabase/      client factories
src/proxy.ts           session refresh + route protection (NOT middleware.ts — Next 16)
scripts/db-test.sh     throwaway-cluster test runner
```

See `AGENTS.md` for the architecture rules and the Next 16 version traps.
