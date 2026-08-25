-- ============================================================================
-- 011_timetable_exceptions.sql
--
-- Cancelling ONE occurrence of a recurring commitment.
--
-- A timetable entry is a weekly pattern with a start and end date. That covers
-- "this lesson runs all term" and "this lesson stopped in December", but not
-- the ordinary case of a single week being off: a teaching session that does
-- not happen on the 27th, a cancelled club, a lesson lost to a school trip.
--
-- Without this the only options were both wrong. Delete the entry and you lose
-- every future week. Leave it and the solver keeps three hours blocked for
-- something that is not happening, so the plan quietly under-uses a day the
-- student actually had free.
--
-- An exception is a subtraction, never an edit: the pattern stays the single
-- source of truth and the exception records that one date is exempt from it.
-- Removing the exception restores the occurrence exactly, which is what makes
-- "I cancelled that by mistake" a one-click fix rather than a re-entry job.
-- ============================================================================

do $guard$
begin
  if to_regclass('public.timetable_entries') is null then
    raise exception
      'Migration 011 cannot run: migration 007 (timetable) is not present in this database. Either run supabase/FULL_SCHEMA.sql on a fresh project, or check you are connected to the right Supabase project.';
  end if;
end
$guard$;

create table if not exists timetable_exceptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  entry_id   uuid not null references timetable_entries (id) on delete cascade,

  -- The local date this occurrence is skipped. Dates, not timestamps: "the
  -- 27th is off" is a calendar fact and must not shift with a timezone.
  on_date    date not null,

  -- Free text, shown back to the student so a cancellation made weeks ago is
  -- explicable rather than mysterious.
  reason     text,

  created_at timestamptz not null default now(),

  -- Cancelling twice is the same as cancelling once. This is what lets the
  -- command be re-run safely.
  unique (entry_id, on_date)
);

create index if not exists timetable_exceptions_lookup_idx
  on timetable_exceptions (user_id, on_date);

alter table timetable_exceptions enable row level security;

drop policy if exists timetable_exceptions_owner on timetable_exceptions;
create policy timetable_exceptions_owner on timetable_exceptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table timetable_exceptions is
  'One skipped occurrence of a recurring timetable entry. Subtractive: deleting the row restores the lesson.';
