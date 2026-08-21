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
