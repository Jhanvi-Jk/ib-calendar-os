-- ============================================================================
-- 010_revision.sql
--
-- Spaced revision.
--
-- The solver schedules WORK. Revision is a different shape: the same topic
-- revisited at widening intervals, where the value is in the spacing, not the
-- hours. Forgetting is a curve, and a topic reviewed at day 2, 7 and 13 sticks
-- far better than the same minutes spent in one block.
--
-- Two triggers:
--   * a bad test — "I did badly in circular motion" — starts a cycle now
--   * a topic covered in class can start one on the same schedule
--
-- Each pass materialises as a real `tasks` row with a WINDOW (earliest_start
-- .. deadline) rather than a fixed date, so the existing solver places it
-- where there is genuinely room. No new scheduling machinery, and revision
-- automatically respects sleep, lessons, quotas and written-off days.
-- ============================================================================

do $guard$
begin
  if to_regclass('public.subjects') is null
     or to_regproc('public.set_updated_at') is null then
    raise exception
      'Migration 010 cannot run: migrations 001-009 are not present in this database. Check you are connected to the right Supabase project.';
  end if;
end
$guard$;

-- Re-runnable. Postgres has no `create type if not exists`, and re-running a
-- migration is a normal thing to do when you are unsure whether it took: the
-- bare form aborts the whole script on its first statement with "type
-- revision_origin already exists", which reads like damage when nothing has
-- happened at all.
do $revision_origin$
begin
  create type revision_origin as enum (
    'weak_spot',   -- flagged after a bad test or a lesson that did not land
    'syllabus',    -- routine coverage of a syllabus topic
    'manual'
  );
exception
  when duplicate_object then null;
end
$revision_origin$;

create table if not exists revision_topics (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  subject_id   uuid references public.subjects (id) on delete cascade,

  label        text not null,
  origin       revision_origin not null default 'weak_spot',

  -- How shaky it feels, 1 = no idea .. 5 = solid. Drives how much time each
  -- pass gets, and whether the cycle restarts after a bad pass.
  confidence   smallint not null default 2 check (confidence between 1 and 5),

  -- The day the cycle was triggered. All pass offsets count from here.
  triggered_on date not null,
  is_active    boolean not null default true,

  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists revision_topics_user_active_idx
  on revision_topics (user_id, subject_id) where is_active;

drop trigger if exists revision_topics_updated_at on revision_topics;
create trigger revision_topics_updated_at
  before update on revision_topics
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- One row per scheduled pass.
--
-- pass_index 0,1,2.. are the spaced passes; the final pre-exam pass is marked
-- separately because it is anchored to the exam session rather than to the
-- trigger date.
-- ---------------------------------------------------------------------------
create table if not exists revision_passes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  topic_id       uuid not null references revision_topics (id) on delete cascade,

  pass_index     smallint not null check (pass_index >= 0),
  is_pre_exam    boolean not null default false,

  -- The window the solver may place this pass in.
  earliest_on    date not null,
  due_on         date not null,

  estimate_min   int not null default 30 check (estimate_min > 0),
  -- Set once materialised, so generation stays idempotent.
  task_id        uuid references public.tasks (id) on delete set null,

  created_at     timestamptz not null default now(),

  constraint revision_window_ordered check (due_on >= earliest_on),
  -- A topic has exactly one pass per index: re-running generation cannot
  -- duplicate a cycle.
  unique (topic_id, pass_index)
);

create index if not exists revision_passes_due_idx on revision_passes (user_id, due_on);

alter table revision_topics  enable row level security;
alter table revision_passes  enable row level security;

drop policy if exists revision_topics_owner on revision_topics;
create policy revision_topics_owner on revision_topics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists revision_passes_owner on revision_passes;
create policy revision_passes_owner on revision_passes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
