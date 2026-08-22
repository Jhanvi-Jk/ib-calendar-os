-- ============================================================
-- IB Calendar OS — migrations 006-009 only.
-- Run this on a project that ALREADY has 001-005 applied.
-- Refuses to run otherwise, with an explanatory error.
-- ============================================================

-- ─────────── 006_academic_calendar.sql ───────────
-- ============================================================================
-- 006_academic_calendar.sql
--
-- The school year's fixed landmarks: exam sessions, terms, half terms.
--
-- These are deliberately NOT rows in `events`. An event occupies time on the
-- grid and the solver schedules around it; a term boundary is a *date*, has no
-- clock time, often spans weeks, and exists to give the student orientation
-- rather than to block out hours. Modelling them as events would put a
-- three-week holiday on the calendar as an all-day blocker and quietly delete
-- half the study capacity in the horizon.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Prerequisite check.
--
-- Without this, running out of order (or against the wrong project) fails
-- with a bare "relation \"subjects\" does not exist", which says nothing about
-- the actual cause. Fail loudly and usefully instead.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.subjects') is null
     or to_regproc('public.set_updated_at') is null then
    raise exception
      'Migration 006 cannot run: migrations 001-005 are not present in this database. Either run supabase/FULL_SCHEMA.sql on a fresh project, or check you are connected to the right Supabase project (this app expects the one holding your existing subjects and tasks).';
  end if;
end
$guard$;


create type academic_date_kind as enum (
  'exam_session',   -- the IB session itself — the year's anchor
  'mock_exams',
  'term_start',
  'term_end',
  'half_term',      -- the break, start..end
  'holiday',
  'coursework_deadline'
);

create table academic_dates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,

  kind       academic_date_kind not null,
  label      text not null,

  -- Dates, not timestamps. A term does not start at 09:00 in a timezone; it
  -- starts on a day. Keeping this a `date` avoids an entire class of
  -- off-by-one-at-midnight bugs when counting days remaining.
  starts_on  date not null,
  -- Null for single-day landmarks; set for ranges (half terms, exam windows).
  ends_on    date,

  -- Exactly one landmark per user is the year's anchor — the countdown that
  -- gets top billing. Usually the IB exam session.
  is_primary boolean not null default false,

  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint academic_range_ordered check (ends_on is null or ends_on >= starts_on)
);

create unique index academic_dates_one_primary
  on academic_dates (user_id)
  where is_primary;

create index academic_dates_user_start_idx on academic_dates (user_id, starts_on);

create trigger academic_dates_updated_at
  before update on academic_dates
  for each row execute function set_updated_at();

alter table academic_dates enable row level security;

create policy academic_dates_owner on academic_dates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Subject weighting becomes meaningful.
--
-- subjects.grade_weight already feeds the solver's priority term, but nothing
-- ever set it: onboarding left every subject at 1.0, so the weighting was
-- inert. Recording the intent here so the UI can expose it.
-- ---------------------------------------------------------------------------

comment on column subjects.grade_weight is
  'Relative importance of this subject, 0.5 = coasting, 1.0 = normal, 2.0 = the one that decides the offer. Feeds the solver priority weight.';

-- ─────────── 007_timetable.sql ───────────
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

-- ---------------------------------------------------------------------------
-- Prerequisite check.
--
-- Without this, running out of order (or against the wrong project) fails
-- with a bare "relation \"subjects\" does not exist", which says nothing about
-- the actual cause. Fail loudly and usefully instead.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.subjects') is null
     or to_regproc('public.set_updated_at') is null then
    raise exception
      'Migration 007 cannot run: migrations 001-005 are not present in this database. Either run supabase/FULL_SCHEMA.sql on a fresh project, or check you are connected to the right Supabase project (this app expects the one holding your existing subjects and tasks).';
  end if;
end
$guard$;


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

-- ─────────── 008_study_quotas.sql ───────────
-- ============================================================================
-- 008_study_quotas.sql
--
-- Recurring weekly study commitments: "3h of SAT Maths every week, forever."
--
-- The app could previously only express one-off work with a deadline, which
-- is the wrong shape for SAT, TOPIK or language drilling. Those have no due
-- date and never finish — they are a rate, not a task.
--
-- DESIGN: a quota is a TEMPLATE that materialises one real `tasks` row per
-- week, rather than a synthetic item the solver invents on the fly. Real rows
-- mean timers, completion, estimate calibration and the DAG all work on quota
-- work exactly as they do on everything else, with no parallel code path.
--
-- Deliberately NOT topic-planned. The quota protects the hours; what gets
-- studied inside them is decided at the desk. Pre-planning "Week 7: quadratic
-- inequalities" in September is a fiction that survives contact with reality
-- for about a fortnight.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Prerequisite check.
--
-- Without this, running out of order (or against the wrong project) fails
-- with a bare "relation \"subjects\" does not exist", which says nothing about
-- the actual cause. Fail loudly and usefully instead.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.subjects') is null
     or to_regproc('public.set_updated_at') is null then
    raise exception
      'Migration 008 cannot run: migrations 001-005 are not present in this database. Either run supabase/FULL_SCHEMA.sql on a fresh project, or check you are connected to the right Supabase project (this app expects the one holding your existing subjects and tasks).';
  end if;
end
$guard$;


create table study_quotas (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  subject_id      uuid references subjects (id) on delete set null,

  label           text not null,
  target_min_week int  not null check (target_min_week between 15 and 3000),

  -- Chunking preferences. Weak areas want frequency over duration, so the
  -- default session is short enough to schedule several times a week.
  min_session_min int not null default 30 check (min_session_min >= 10),
  max_session_min int not null default 90,

  cognitive_load  smallint not null default 3 check (cognitive_load between 1 and 5),
  -- Same 0-3 scale as tasks.priority_pin.
  priority_pin    smallint not null default 0 check (priority_pin between 0 and 3),

  is_active       boolean not null default true,
  active_from     date,
  active_to       date,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint quota_session_bounds check (max_session_min >= min_session_min),
  constraint quota_dates_ordered check (
    active_from is null or active_to is null or active_to >= active_from
  )
);

create index study_quotas_user_active_idx on study_quotas (user_id) where is_active;

create trigger study_quotas_updated_at
  before update on study_quotas
  for each row execute function set_updated_at();

alter table study_quotas enable row level security;

create policy study_quotas_owner on study_quotas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Link generated tasks back to their quota.
--
-- quota_week is the Monday of the week the task covers. The unique index is
-- what makes generation idempotent: running the generator twice, or from two
-- devices at once, cannot produce duplicate SAT Maths blocks for one week.
-- ---------------------------------------------------------------------------

alter table tasks
  add column quota_id   uuid references study_quotas (id) on delete cascade,
  add column quota_week date;

create unique index tasks_one_per_quota_week
  on tasks (quota_id, quota_week)
  where quota_id is not null;

alter table tasks add constraint quota_week_present check (
  (quota_id is null and quota_week is null) or
  (quota_id is not null and quota_week is not null)
);

comment on column tasks.quota_week is
  'Monday of the week this quota task covers. Null for ordinary one-off tasks.';

-- ─────────── 009_day_write_offs.sql ───────────
-- ============================================================================
-- 009_day_write_offs.sql
--
-- "I was ill on Tuesday."
--
-- Without this a lost day silently becomes an overdue pile: the plan still
-- says work happened, the momentum ratio counts the miss, and the student
-- opens the app to a backlog and a number telling them they are failing.
-- Illness is not a discipline problem and the app should not score it as one.
--
-- Writing a day off does three things, all of them consequences of this one
-- row: the solver treats the day as zero capacity, momentum treats it as a
-- rest day rather than a miss, and the work is redistributed on the next
-- solve.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Prerequisite check.
--
-- Without this, running out of order (or against the wrong project) fails
-- with a bare "relation \"subjects\" does not exist", which says nothing about
-- the actual cause. Fail loudly and usefully instead.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.subjects') is null
     or to_regproc('public.set_updated_at') is null then
    raise exception
      'Migration 009 cannot run: migrations 001-005 are not present in this database. Either run supabase/FULL_SCHEMA.sql on a fresh project, or check you are connected to the right Supabase project (this app expects the one holding your existing subjects and tasks).';
  end if;
end
$guard$;


create type write_off_reason as enum ('illness', 'family', 'travel', 'burnout', 'other');

create table day_write_offs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,

  -- A local calendar date, not an instant. "Tuesday" is a day in the
  -- student's timezone, not a 24-hour window from some UTC moment.
  day        date not null,
  reason     write_off_reason not null default 'illness',
  note       text,

  created_at timestamptz not null default now(),

  -- Writing a day off twice is a no-op, not two write-offs.
  unique (user_id, day)
);

create index day_write_offs_user_day_idx on day_write_offs (user_id, day desc);

alter table day_write_offs enable row level security;

create policy day_write_offs_owner on day_write_offs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

