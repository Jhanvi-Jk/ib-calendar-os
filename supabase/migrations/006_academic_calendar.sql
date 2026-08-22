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
