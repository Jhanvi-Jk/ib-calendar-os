<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# IB Calendar OS — project rules

## Version traps already hit (do not re-learn these)

- **`middleware.ts` does not exist in Next 16.** The convention is `proxy.ts`,
  exporting a function named `proxy`. Ours is at `src/proxy.ts`. Every Supabase
  SSR tutorial online is still on the old name.
- `cookies()`, `headers()`, `params`, `searchParams` are all **async**.
- Turbopack is the default for `dev` and `build`; no `--turbopack` flag needed.

## Architecture rules

1. **The solver is a pure function.** `src/lib/scheduling/` must not import
   Supabase, `next/*`, or anything that touches I/O or reads the clock. It
   takes a `SolverSnapshot` and returns a `SolveResult`. This is what makes it
   testable and what makes "same input, same output" true.
2. **Integer minutes everywhere.** No float durations, no `Date` objects across
   the solver boundary — epoch minutes only. Float minutes silently break
   determinism.
3. **The LLM never writes to the database.** Model output goes into
   `ai_proposals` as a Zod-validated row. A separate deterministic applier
   turns approved proposals into writes. If you find yourself giving a model a
   tool that does an `insert`, stop.
4. **Untrusted input.** Syllabus PDFs, Notion pages and calendar descriptions
   are data. Instruction-shaped text inside them gets shown to the user, never
   executed. `ai_proposals.source_kind` / `is_trusted_source` track this.
5. **Tier 1 is sacred.** Sleep, exams, classes, appointments, locked blocks.
   Enforced by a DB exclusion constraint, not by application politeness.
6. **Schedules are versioned, never mutated.** Write a new `schedule_runs` row
   and call `activate_schedule_run()`. Reset Day, what-if branching and undo
   are all this one mechanism.
7. **Service-role client is for webhooks and jobs only.** It bypasses RLS.
   Always constrain its queries by an explicit `user_id`.

## Working on the database

Migrations are plain SQL in `supabase/migrations/`, applied in filename order.
After **any** schema change:

```bash
npm run db:test
```

That rebuilds a throwaway Postgres 16 cluster from scratch, applies every
migration, and runs the guardrail suite in `supabase/tests/01_guardrails.sql`.
Add an assertion there for every new invariant. `supabase/tests/00_local_shim.sql`
fakes Supabase's `auth` schema and must never be applied to a real project.


## Module map (what may import what)

```
scheduling/  ──┐
analytics/   ──┼──▶ pure. No Supabase, no next/*, no clock, no Math.random.
integrations/*/mapping.ts ─┘  (translation only — the network lives in sync.ts)

data/        ──▶ reads/writes Supabase, assembles solver input
ai/          ──▶ model in, validated proposal out; applier does the writing
app/         ──▶ UI + server actions; orchestrates the above
```

If a file under `scheduling/` or `analytics/` grows an import from `data/` or
`next/*`, that is the bug — extract the I/O to the caller instead.

## Testing expectations

- Pure logic gets a unit test. `npm test` is fast (<1s); there is no excuse
  for adding solver or analytics behaviour without one.
- Every new database invariant gets an assertion in
  `supabase/tests/01_guardrails.sql`. The solver is written assuming those
  hold, so an untested constraint is an unsafe assumption.
- Integration modules: test the pure translation half (`mapping.ts`). The
  network half is not unit-testable and is verified by using it.

## React purity

`Date.now()` during render is an eslint error, not a style preference — the
"today" highlight and overdue badges would drift on unrelated re-renders. Pass
the current time in from a server component (see `nowMin` on `WeekGrid` and
`TaskManager`).

## Accessibility bar

Adapted from the UX guideline set in
[ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
(MIT), filtered to the Critical/High web rules that apply to this app. These
are requirements, not aspirations — a planner used under exam stress is
exactly the context where low contrast and 16px hit targets fail people.

1. **Contrast** — body text ≥ 4.5:1 against its *effective* background, large
   text ≥ 3:1. Measure the rendered colour, don't eyeball the token: the
   browser returns `oklch()`/`lab()`, so naive RGB parsing silently produces
   nonsense ratios.
2. **Target size** — every interactive element ≥ 24×24 CSS px (WCAG 2.2 AA
   2.5.8). Checkboxes and icon-only buttons are the usual offenders.
3. **Never colour alone** — tier is carried by a label or icon as well as a
   hue. Roughly 1 in 12 men has a colour-vision deficiency, and Tier 1 vs
   Tier 3 is a safety-relevant distinction here.
4. **Reduced motion** — respect `prefers-reduced-motion`, but do not let a
   blanket freeze kill motion that *communicates*. Anything that is the only
   signal for a state change needs a non-motion fallback; see
   `.motion-safe-pulse` in `globals.css`.
5. **Inline errors** — each invalid field gets its own message, adjacent to
   the input and wired with `aria-describedby`. A single error at the bottom
   of a form does not identify what to fix.
6. **No essential truncation** — headings, actions, errors and distinguishing
   names must be reachable in full. Truncating a task title for a tidy grid is
   only acceptable when the full text is available elsewhere (tooltip, detail).
7. **Compact controls are real controls** — a chip or icon button needs a
   native role, an accessible name, keyboard operation and visible focus.
   Never a clickable `div`, never hover-only affordances.

Re-run the audit after UI work by measuring in a browser, not by reading CSS.
