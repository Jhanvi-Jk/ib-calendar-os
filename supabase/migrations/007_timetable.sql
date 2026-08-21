-- ============================================================================
-- 007_timetable.sql
--
-- The recurring school timetable.
--
-- Until now nothing in the app could create a class. `events` had exactly two
-- writers — Google sync and nothing else — so a student without Google
-- credentials had a solver that believed every weekday was completely free
-- and would happily schedule revision on top of a double Physics lesson.
--
-- Stored as a weekly PATTERN, not as expanded rows. Materialising a year of
-- lessons into `events` would mean thousands of rows to keep in step every
-- time a period moves, and a "delete this lesson" that silently diverges from
-- the pattern. The pattern is expanded on read instead (see
-- src/lib/scheduling/timetable.ts), so there is one source of truth.
-- ============================================================================

-- Many IB schools run a two-week cycle. Modelling only 'every' would force
-- students on a fortnightly timetable to enter the wrong schedule.
create type week_parity as enum ('every', 'A', 'B');

create table timetable_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  subject_id  uuid references subjects (id) on delete set null,

  -- Free text so non-teaching fixtures (registration, games, orchestra) can
  -- live in the timetable without pretending to be an IB subject.
  label       text not null,
  room        text,

  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0 = Sunday
  -- Minutes from local midnight. Same integer-minute convention as the solver.
  starts_min  smallint not null check (starts_min between 0 and 1439),
  ends_min    smallint not null check (ends_min between 1 and 1440),

  parity      week_parity not null default 'every',

  -- A timetable changes between terms. Null active_to means "still current".
  active_from date,
  active_to   date,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint timetable_times_ordered check (ends_min > starts_min),
  constraint timetable_dates_ordered check (
    active_from is null or active_to is null or active_to >= active_from
  )
);

create index timetable_entries_user_day_idx
  on timetable_entries (user_id, day_of_week, starts_min);

create trigger timetable_entries_updated_at
  before update on timetable_entries
  for each row execute function set_updated_at();

alter table timetable_entries enable row level security;

create policy timetable_entries_owner on timetable_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Which real-world week counts as "Week A".
--
-- Parity is meaningless without an anchor: 'A' only identifies a week
-- relative to a known starting Monday. Null means the student is on a simple
-- one-week timetable and every entry applies.
-- ---------------------------------------------------------------------------

alter table user_settings
  add column timetable_anchor_monday date;

comment on column user_settings.timetable_anchor_monday is
  'Monday of a known Week A. Null = single-week timetable, parity ignored.';
