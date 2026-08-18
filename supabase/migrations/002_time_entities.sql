-- ============================================================================
-- 002_time_entities.sql
--
-- The central modelling decision of this system lives here:
--
--   events            fixed in time. The solver reads them, never writes them.
--   tasks             have duration + deadline but NO position. Flexible.
--   scheduled_blocks  the solver's output. The join between task and timeline.
--   schedule_runs     an immutable ledger of solver generations.
--
-- Because solver output is versioned rather than mutated in place, three
-- product features collapse into one mechanism:
--   "Reset Day"        -> a new run scoped to a single day
--   "What-If branch"   -> a run with parent_run_id and is_active = false
--   "Undo"             -> flip is_active back to the previous run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- events — Tier 1 & 2 reality. Classes, exams, appointments, sleep.
-- ---------------------------------------------------------------------------

create type event_kind as enum (
  'class', 'exam', 'appointment', 'sleep', 'commitment', 'travel', 'general'
);

create table events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  calendar_id uuid references calendars (id) on delete cascade,
  subject_id  uuid references subjects (id) on delete set null,

  title       text not null,
  description text,
  location    text,

  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  span        tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,

  -- Constraint hierarchy. 1 = immutable, 5 = recovery (first to be sacrificed).
  tier        smallint not null default 2 check (tier between 1 and 5),
  kind        event_kind not null default 'general',

  -- User-pinned. Never moved regardless of tier.
  is_locked   boolean not null default false,
  all_day     boolean not null default false,
  rrule       text,

  source      text not null default 'local',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint events_ordered check (ends_at > starts_at)
);

-- Directive #3, enforced at the storage layer rather than trusted to
-- application code: two immutable commitments can never occupy the same
-- instant. An exam colliding with a class is a data error, not a UI warning.
alter table events add constraint events_no_tier1_overlap
  exclude using gist (user_id with =, span with &&)
  where (tier = 1 and not all_day);

create index events_user_starts_idx on events (user_id, starts_at);
create index events_span_idx        on events using gist (user_id, span);
create index events_calendar_idx    on events (calendar_id);

create trigger events_updated_at
  before update on events
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- assessments — the IB artefacts that generate most of the workload
-- ---------------------------------------------------------------------------

create type assessment_kind as enum (
  'ia_draft', 'ia_final', 'ee_draft', 'ee_final',
  'tok_essay', 'tok_exhibition', 'cas_reflection',
  'mock', 'paper', 'oral', 'test', 'other'
);

create table assessments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  subject_id   uuid references subjects (id) on delete cascade,

  kind         assessment_kind not null,
  title        text not null,
  due_at       timestamptz,
  -- Percentage of the subject's final grade. Feeds the solver priority term.
  grade_weight numeric(5, 2) not null default 0 check (grade_weight >= 0),
  -- External = IB-submitted. These deadlines are never negotiable.
  is_external  boolean not null default false,
  status       text not null default 'open'
                 check (status in ('open', 'submitted', 'graded', 'cancelled')),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index assessments_user_due_idx on assessments (user_id, due_at)
  where status = 'open';

create trigger assessments_updated_at
  before update on assessments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks — the schedulable unit. Duration without position.
-- ---------------------------------------------------------------------------

create type task_status as enum ('todo', 'in_progress', 'blocked', 'done', 'dropped');

create table tasks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  subject_id        uuid references subjects (id) on delete set null,
  assessment_id     uuid references assessments (id) on delete set null,
  parent_task_id    uuid references tasks (id) on delete cascade,

  title             text not null,
  notes             text,

  estimate_min      int not null default 60 check (estimate_min > 0),
  -- Set from estimate_min on insert by the trigger below; decremented as
  -- time_entries land. The solver schedules remaining_min, never estimate_min.
  remaining_min     int not null default 0 check (remaining_min >= 0),
  actual_min        int not null default 0 check (actual_min >= 0),

  deadline_at       timestamptz,
  earliest_start_at timestamptz,

  cognitive_load    smallint not null default 3 check (cognitive_load between 1 and 5),

  -- Splittable tasks may be chunked across blocks; an exam rehearsal may not.
  splittable        boolean not null default true,
  min_chunk_min     int not null default 25 check (min_chunk_min >= 5),
  max_chunk_min     int not null default 120,

  status            task_status not null default 'todo',
  -- User override. 0 = none, 3 = "this is the only thing that matters today".
  priority_pin      smallint not null default 0 check (priority_pin between 0 and 3),
  completed_at      timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chunk_bounds_ordered check (max_chunk_min >= min_chunk_min),
  constraint remaining_within_estimate check (remaining_min <= estimate_min),
  constraint window_ordered check (
    earliest_start_at is null or deadline_at is null or earliest_start_at < deadline_at
  ),
  constraint no_self_parent check (parent_task_id is null or parent_task_id <> id)
);

create or replace function tasks_seed_remaining()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' and new.remaining_min = 0 and new.status <> 'done' then
    new.remaining_min = new.estimate_min;
  end if;
  if new.status = 'done' then
    new.remaining_min = 0;
    new.completed_at = coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

create trigger tasks_seed_remaining_trg
  before insert or update on tasks
  for each row execute function tasks_seed_remaining();

create trigger tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

-- Partial index: the solver only ever loads unfinished work.
create index tasks_open_deadline_idx on tasks (user_id, deadline_at)
  where status in ('todo', 'in_progress', 'blocked');
create index tasks_subject_idx    on tasks (subject_id);
create index tasks_assessment_idx on tasks (assessment_id);

-- ---------------------------------------------------------------------------
-- task_dependencies — the DAG
-- ---------------------------------------------------------------------------

create type dependency_type as enum ('FS', 'SS', 'FF');  -- finish-start, start-start, finish-finish

create table task_dependencies (
  user_id        uuid not null references auth.users (id) on delete cascade,
  predecessor_id uuid not null references tasks (id) on delete cascade,
  successor_id   uuid not null references tasks (id) on delete cascade,
  dep_type       dependency_type not null default 'FS',
  lag_min        int not null default 0,
  created_at     timestamptz not null default now(),

  primary key (predecessor_id, successor_id),
  constraint no_self_dependency check (predecessor_id <> successor_id)
);

create index task_dependencies_successor_idx on task_dependencies (successor_id);
create index task_dependencies_user_idx      on task_dependencies (user_id);

-- Acyclicity is enforced here rather than in the solver. A cycle that reaches
-- the topological sort is an infinite loop or a silently dropped edge; a cycle
-- rejected at write time is an error message pointing at one bad edge.
-- The graph is small (hundreds of nodes), so the reachability probe is cheap.
create or replace function assert_task_dag_acyclic()
returns trigger
language plpgsql
as $$
declare
  closes_cycle boolean;
begin
  with recursive reachable (id) as (
    select new.successor_id
    union
    select d.successor_id
      from task_dependencies d
      join reachable r on d.predecessor_id = r.id
  )
  select exists (select 1 from reachable where id = new.predecessor_id)
    into closes_cycle;

  if closes_cycle then
    raise exception
      'Dependency cycle: task % cannot depend on % (it is already downstream)',
      new.successor_id, new.predecessor_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create constraint trigger task_dependencies_acyclic
  after insert or update on task_dependencies
  deferrable initially immediate
  for each row execute function assert_task_dag_acyclic();

-- ---------------------------------------------------------------------------
-- schedule_runs — the immutable solver ledger
-- ---------------------------------------------------------------------------

create table schedule_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  -- Non-null => this run is a what-if branch off another run.
  parent_run_id  uuid references schedule_runs (id) on delete set null,

  horizon_start  timestamptz not null,
  horizon_end    timestamptz not null,

  -- Hash of the frozen solver input. Identical hash + identical seed must
  -- produce identical output; re-solving a matching hash short-circuits.
  input_hash     text   not null,
  strategy       text   not null default 'default',
  seed           bigint not null default 0,

  status         text not null default 'draft'
                   check (status in ('draft', 'active', 'superseded', 'discarded')),
  is_active      boolean not null default false,

  -- Tasks that could NOT be placed, with shortfall + blocking constraint +
  -- ranked remedies. Never empty-and-silent: unplaceable work is surfaced.
  infeasibility  jsonb not null default '[]'::jsonb,
  stats          jsonb not null default '{}'::jsonb,
  label          text,

  created_at     timestamptz not null default now(),

  constraint horizon_ordered check (horizon_end > horizon_start)
);

-- At most one active schedule per user. This is what makes "undo" safe.
create unique index schedule_runs_single_active
  on schedule_runs (user_id)
  where is_active;

create index schedule_runs_user_created_idx on schedule_runs (user_id, created_at desc);
create index schedule_runs_parent_idx       on schedule_runs (parent_run_id);

-- ---------------------------------------------------------------------------
-- scheduled_blocks — solver output
-- ---------------------------------------------------------------------------

create table scheduled_blocks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  run_id         uuid not null references schedule_runs (id) on delete cascade,
  task_id        uuid not null references tasks (id) on delete cascade,

  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  span           tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,

  sequence_index int not null default 0,
  -- A locked block survives re-solves untouched and is carried into new runs.
  is_locked      boolean not null default false,
  -- energy_profile.multiplier at placement time; powers the "why here?" UI.
  energy_score   numeric(5, 2),

  created_at     timestamptz not null default now(),

  constraint blocks_ordered check (ends_at > starts_at)
);

-- Blocks may overlap ACROSS runs — that is the whole point of what-if
-- branching — but never WITHIN a run. Scoping the exclusion to run_id gets
-- both properties from one constraint.
alter table scheduled_blocks add constraint blocks_no_overlap_within_run
  exclude using gist (run_id with =, span with &&);

create index blocks_run_starts_idx on scheduled_blocks (run_id, starts_at);
create index blocks_task_idx       on scheduled_blocks (task_id);
create index blocks_span_idx       on scheduled_blocks using gist (user_id, span);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table events            enable row level security;
alter table assessments       enable row level security;
alter table tasks             enable row level security;
alter table task_dependencies enable row level security;
alter table schedule_runs     enable row level security;
alter table scheduled_blocks  enable row level security;

create policy events_owner on events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy assessments_owner on assessments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy tasks_owner on tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy task_dependencies_owner on task_dependencies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy schedule_runs_owner on schedule_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy scheduled_blocks_owner on scheduled_blocks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Atomic run activation. Flipping the active generation must be all-or-nothing
-- or the unique partial index above will reject the second write and leave the
-- user with no active schedule at all.
-- ---------------------------------------------------------------------------

create or replace function activate_schedule_run(p_run_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from schedule_runs where id = p_run_id;
  if v_user is null then
    raise exception 'schedule run % not found', p_run_id;
  end if;

  update schedule_runs
     set is_active = false, status = 'superseded'
   where user_id = v_user and is_active and id <> p_run_id;

  update schedule_runs
     set is_active = true, status = 'active'
   where id = p_run_id;
end;
$$;
