-- ============================================================
-- IB Calendar OS — full schema, migrations 001-005 combined.
-- Paste this whole file into the Supabase SQL editor and Run.
-- Safe to run once on a fresh project.
-- ============================================================

-- ─────────── 001_foundation.sql ───────────
-- ============================================================================
-- 001_foundation.sql
-- Identity, preferences, the energy model, calendars and IB subjects.
--
-- Conventions used across every migration in this project:
--   * All instants are timestamptz. Wall-clock preferences (sleep, day start)
--     are `time` and are interpreted in profiles.timezone.
--   * All durations are integer MINUTES. Never floats — the scheduling engine
--     must be bit-for-bit deterministic and float minutes destroy that.
--   * Every user-owned table carries user_id and has RLS forcing auth.uid().
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  -- IANA zone. Validated in the app via Intl.supportedValuesOf('timeZone');
  -- a CHECK cannot call the tz database from an IMMUTABLE context.
  timezone     text        not null default 'UTC',
  ib_session   text,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- user_settings — the capacity envelope the solver is allowed to fill
-- ---------------------------------------------------------------------------

create table user_settings (
  user_id                    uuid primary key references auth.users (id) on delete cascade,

  -- Sleep is Tier 1 by default. Directive: protect sleep.
  sleep_start                time    not null default '23:00',
  sleep_end                  time    not null default '07:00',
  sleep_protected            boolean not null default true,

  -- The window the solver may place work in (further narrowed by events).
  day_start                  time    not null default '07:30',
  day_end                    time    not null default '22:30',

  max_daily_focus_min        int     not null default 300
                               check (max_daily_focus_min between 0 and 1440),
  min_block_min              int     not null default 25  check (min_block_min >= 5),
  max_block_min              int     not null default 120,
  context_switch_penalty_min int     not null default 10  check (context_switch_penalty_min >= 0),
  planning_horizon_days      int     not null default 21
                               check (planning_horizon_days between 1 and 120),

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint block_bounds_ordered check (max_block_min >= min_block_min)
);

create trigger user_settings_updated_at
  before update on user_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- energy_profile — 168 rows per user (day-of-week x hour).
-- Seeded from onboarding, then learned from time_entries (migration 003).
-- multiplier 1.00 = baseline; 1.30 = peak cognition; 0.40 = post-lunch trough.
-- ---------------------------------------------------------------------------

create table energy_profile (
  user_id    uuid     not null references auth.users (id) on delete cascade,
  dow        smallint not null check (dow between 0 and 6),   -- 0 = Sunday
  hour       smallint not null check (hour between 0 and 23),
  multiplier numeric(3, 2) not null default 1.00
               check (multiplier >= 0 and multiplier <= 2),
  samples    int      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, dow, hour)
);

-- ---------------------------------------------------------------------------
-- calendars
-- ---------------------------------------------------------------------------

create type calendar_provider as enum ('local', 'google', 'notion');

create table calendars (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  name                 text not null,
  provider             calendar_provider not null default 'local',
  provider_calendar_id text,
  color_token          text    not null default 'neutral',
  is_visible           boolean not null default true,

  -- Read/write posture toward the remote provider.
  is_writable          boolean not null default true,
  -- Exactly one calendar per user is app-managed. The Google sync layer is
  -- only ever permitted to CREATE/UPDATE/DELETE events on that calendar;
  -- every other calendar is strictly read-only unless the user opts in.
  is_app_managed       boolean not null default false,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (user_id, provider, provider_calendar_id)
);

create unique index calendars_one_app_managed
  on calendars (user_id)
  where is_app_managed;

create trigger calendars_updated_at
  before update on calendars
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- subjects — IB subjects plus the core (EE / TOK / CAS)
-- ---------------------------------------------------------------------------

create type ib_level as enum ('HL', 'SL', 'CORE');

create table subjects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  -- Null for core components (EE, TOK, CAS), which have no IB group.
  ib_group     smallint check (ib_group between 1 and 6),
  level        ib_level not null,
  teacher      text,
  color_token  text not null default 'neutral',
  -- Relative weight toward the final grade; feeds the solver's priority term.
  grade_weight numeric(4, 2) not null default 1.00 check (grade_weight >= 0),
  is_archived  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (user_id, name),
  constraint core_has_no_group check (
    (level = 'CORE' and ib_group is null) or (level <> 'CORE' and ib_group is not null)
  )
);

create trigger subjects_updated_at
  before update on subjects
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table profiles       enable row level security;
alter table user_settings  enable row level security;
alter table energy_profile enable row level security;
alter table calendars      enable row level security;
alter table subjects       enable row level security;

create policy profiles_owner on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy user_settings_owner on user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy energy_profile_owner on energy_profile
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy calendars_owner on calendars
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy subjects_owner on subjects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- New-user bootstrap: profile + settings + a flat 168-slot energy curve.
-- The curve is deliberately flat here; onboarding shapes it, then the
-- calibration job in migration 003 learns the real one from tracked time.
-- ---------------------------------------------------------------------------

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
    on conflict (id) do nothing;

  insert into user_settings (user_id) values (new.id)
    on conflict (user_id) do nothing;

  insert into energy_profile (user_id, dow, hour)
    select new.id, d, h
    from generate_series(0, 6) as d, generate_series(0, 23) as h
    on conflict do nothing;

  insert into calendars (user_id, name, provider, is_app_managed, color_token)
    values (new.id, 'IB Calendar OS', 'local', true, 'primary');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─────────── 002_time_entities.sql ───────────
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

-- ─────────── 003_telemetry_sync_ai.sql ───────────
-- ============================================================================
-- 003_telemetry_sync_ai.sql
--
-- Three concerns that are cheap now and near-impossible to retrofit later:
--   1. time_entries / estimation_calibration — the loop that makes estimates
--      true instead of hopeful.
--   2. sync_mappings / sync_state — without stored (local, remote, etag, hash)
--      triples, two-way Google sync duplicates events and echoes forever.
--   3. ai_proposals — the physical boundary that makes "the LLM never writes
--      to the database" an architectural fact rather than a good intention.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- time_entries — ground truth for how long things actually take
-- ---------------------------------------------------------------------------

create table time_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  task_id    uuid references tasks (id) on delete cascade,
  block_id   uuid references scheduled_blocks (id) on delete set null,

  started_at timestamptz not null,
  ended_at   timestamptz,
  -- Denormalised on close so analytics never re-derive it from timestamps.
  duration_min int,

  source     text not null default 'timer'
               check (source in ('timer', 'manual', 'inferred')),
  note       text,
  created_at timestamptz not null default now(),

  constraint entry_ordered check (ended_at is null or ended_at > started_at)
);

create index time_entries_task_idx      on time_entries (task_id);
create index time_entries_user_date_idx on time_entries (user_id, started_at desc);
-- At most one running timer per user.
create unique index time_entries_one_open on time_entries (user_id)
  where ended_at is null;

-- Closing an entry rolls the minutes into the task. Doing this in a trigger
-- keeps tasks.actual_min consistent no matter which client wrote the entry.
create or replace function time_entries_apply()
returns trigger
language plpgsql
as $$
declare
  v_minutes int;
begin
  if new.ended_at is null then
    return new;
  end if;

  v_minutes := greatest(0, floor(extract(epoch from (new.ended_at - new.started_at)) / 60)::int);
  new.duration_min := v_minutes;

  if new.task_id is not null and (tg_op = 'INSERT' or old.ended_at is null) then
    update tasks
       set actual_min    = actual_min + v_minutes,
           remaining_min = greatest(0, remaining_min - v_minutes)
     where id = new.task_id;
  end if;

  return new;
end;
$$;

create trigger time_entries_apply_trg
  before insert or update on time_entries
  for each row execute function time_entries_apply();

-- ---------------------------------------------------------------------------
-- estimation_calibration — learned estimate:actual ratios.
-- After ~20 samples the empirical p80 outranks the model's guess.
-- ---------------------------------------------------------------------------

create table estimation_calibration (
  user_id        uuid not null references auth.users (id) on delete cascade,
  subject_id     uuid references subjects (id) on delete cascade,
  cognitive_load smallint not null check (cognitive_load between 1 and 5),

  ratio_p50      numeric(5, 2) not null default 1.00,
  ratio_p80      numeric(5, 2) not null default 1.00,
  n_samples      int not null default 0,
  updated_at     timestamptz not null default now(),

  primary key (user_id, subject_id, cognitive_load)
);

-- ---------------------------------------------------------------------------
-- momentum_snapshots — rolling 7-day health. Explicitly NOT a streak:
-- there is no counter that can reset to zero and no all-or-nothing day.
-- ---------------------------------------------------------------------------

create type momentum_state as enum ('thriving', 'steady', 'strained', 'recovering');

create table momentum_snapshots (
  user_id        uuid not null references auth.users (id) on delete cascade,
  day            date not null,
  planned_min    int  not null default 0,
  completed_min  int  not null default 0,
  rolling7_ratio numeric(4, 3) not null default 0,
  state          momentum_state not null default 'steady',
  created_at     timestamptz not null default now(),
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- retrospectives — end-of-day review
-- ---------------------------------------------------------------------------

create table retrospectives (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  day        date not null,
  wins       jsonb not null default '[]'::jsonb,
  friction   jsonb not null default '[]'::jsonb,
  carryover  jsonb not null default '[]'::jsonb,
  energy_rating smallint check (energy_rating between 1 and 5),
  note       text,
  created_at timestamptz not null default now(),
  unique (user_id, day)
);

-- ---------------------------------------------------------------------------
-- themes — Pinterest-inspired theme engine.
-- Tokens are semantic (studying, exam, rest), never raw hex at the call site:
-- the solver marks a block by MEANING and the theme decides pixels.
-- ---------------------------------------------------------------------------

create table themes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  name             text not null,
  tokens           jsonb not null default '{}'::jsonb,
  source_image_url text,
  is_active        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, name)
);

create unique index themes_one_active on themes (user_id) where is_active;

-- ---------------------------------------------------------------------------
-- Integration sync state
-- ---------------------------------------------------------------------------

create table sync_state (
  user_id             uuid not null references auth.users (id) on delete cascade,
  provider            calendar_provider not null,
  -- Google incremental syncToken / Notion cursor.
  sync_token          text,
  cursor              text,
  -- Push-notification channel; renewed proactively before expiry.
  channel_id          text,
  channel_resource_id text,
  channel_expires_at  timestamptz,
  last_full_sync_at   timestamptz,
  last_error          text,
  updated_at          timestamptz not null default now(),
  primary key (user_id, provider)
);

create index sync_state_channel_expiry_idx on sync_state (channel_expires_at)
  where channel_expires_at is not null;

create table sync_mappings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  provider      calendar_provider not null,
  local_table   text not null,
  local_id      uuid not null,
  remote_id     text not null,
  remote_etag   text,
  -- Hash of the canonical local payload. Inbound change with a matching hash
  -- is our own write echoing back and must be dropped, or the two systems
  -- will ping-pong updates at each other indefinitely.
  content_hash  text,
  last_synced_at timestamptz not null default now(),

  unique (user_id, provider, remote_id),
  unique (user_id, provider, local_table, local_id)
);

create index sync_mappings_local_idx on sync_mappings (local_table, local_id);

-- ---------------------------------------------------------------------------
-- ai_proposals — the AI safety boundary.
--
-- Directive #2: an opaque model never mutates database state. Every model
-- output lands HERE as a typed, Zod-validated proposal. A separate
-- deterministic applier turns approved proposals into real writes.
-- There is no code path from model output to a table write that skips this.
-- ---------------------------------------------------------------------------

create type proposal_kind as enum (
  'task_extract',      -- parse a syllabus/page into candidate tasks
  'estimate',          -- suggest estimate_min
  'classify',          -- subject / cognitive_load / tier
  'dependency',        -- suggest DAG edges
  'reschedule_intent', -- NL request -> structured solver invocation
  'summarize'
);

create type proposal_status as enum (
  'pending', 'auto_approved', 'approved', 'rejected', 'applied', 'invalid'
);

create table ai_proposals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,

  kind              proposal_kind   not null,
  status            proposal_status not null default 'pending',
  payload           jsonb           not null,

  model             text,
  confidence        numeric(4, 3) check (confidence between 0 and 1),

  -- Provenance of the INPUT. Content arriving from a syllabus PDF, a Notion
  -- page or a calendar description is untrusted: instruction-shaped text
  -- inside it is data to be shown to the user, never commands to execute.
  source_kind       text not null default 'user'
                      check (source_kind in ('user', 'pdf', 'notion', 'google', 'system')),
  source_ref        text,
  is_trusted_source boolean not null default false,

  -- Populated when the Zod schema rejects the model output. A proposal that
  -- fails validation is marked 'invalid' and is never partially applied.
  validation_errors jsonb,

  -- Destructive or Tier-1-touching proposals require explicit confirmation
  -- regardless of confidence.
  requires_confirmation boolean not null default true,

  applied_run_id    uuid references schedule_runs (id) on delete set null,
  applied_at        timestamptz,
  created_at        timestamptz not null default now()
);

create index ai_proposals_pending_idx on ai_proposals (user_id, created_at desc)
  where status in ('pending', 'auto_approved');

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table time_entries           enable row level security;
alter table estimation_calibration enable row level security;
alter table momentum_snapshots     enable row level security;
alter table retrospectives         enable row level security;
alter table themes                 enable row level security;
alter table sync_state             enable row level security;
alter table sync_mappings          enable row level security;
alter table ai_proposals           enable row level security;

create policy time_entries_owner on time_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy estimation_calibration_owner on estimation_calibration
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy momentum_snapshots_owner on momentum_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy retrospectives_owner on retrospectives
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy themes_owner on themes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Sync internals are service-role only: they hold provider cursors and
-- channel identifiers that no browser session has any reason to read.
create policy sync_state_owner_read on sync_state
  for select using (auth.uid() = user_id);

create policy sync_mappings_owner_read on sync_mappings
  for select using (auth.uid() = user_id);

create policy ai_proposals_owner on ai_proposals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────── 004_integration_accounts.sql ───────────
-- ============================================================================
-- 004_integration_accounts.sql
--
-- OAuth credentials for connected providers.
--
-- SECURITY POSTURE: this table has RLS enabled and NO policy granting access.
-- That is deliberate, not an oversight — with RLS on and no policy, every
-- browser session (anon and authenticated alike) reads zero rows. Only the
-- service-role client, used exclusively by server-side sync jobs and webhook
-- handlers, can touch it. A refresh token is a long-lived key to the user's
-- entire calendar; it should never be reachable from a page.
-- ============================================================================

create table integration_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  provider         calendar_provider not null,

  provider_user_id text,
  provider_email   text,

  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  scopes           text[] not null default '{}',

  -- Set when the provider rejects our refresh token (revoked access, password
  -- change). The UI prompts a reconnect instead of retrying forever.
  needs_reauth     boolean not null default false,
  last_error       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (user_id, provider)
);

create trigger integration_accounts_updated_at
  before update on integration_accounts
  for each row execute function set_updated_at();

alter table integration_accounts enable row level security;
-- Intentionally no policies. See the note at the top of this file.

-- ---------------------------------------------------------------------------
-- Sync bookkeeping the pull loop needs but 003 did not anticipate.
-- ---------------------------------------------------------------------------

alter table sync_state
  add column if not exists sync_in_progress boolean not null default false,
  add column if not exists consecutive_failures int not null default 0;

-- A Google event we deleted locally must be remembered long enough for the
-- next incremental pull to not resurrect it. Deleting the mapping outright
-- would make the event look brand new on the following sync.
alter table sync_mappings
  add column if not exists deleted_locally boolean not null default false;

create index if not exists sync_mappings_pending_delete_idx
  on sync_mappings (user_id, provider)
  where deleted_locally;

-- ─────────── 005_context_hydration.sql ───────────
-- ============================================================================
-- 005_context_hydration.sql
--
-- Roadmap step 20. Lets a task carry a pointer to wherever the work actually
-- lives — an Obsidian note, a Google Doc, a repository path — so entering
-- focus mode opens the context instead of making the student go find it.
--
-- Stored as a URI rather than a file path so obsidian://, vscode:// and
-- https:// are all expressible without a separate type column.
-- ============================================================================

alter table tasks
  add column if not exists context_uri text,
  add column if not exists context_label text;

-- Reject anything that isn't a URI we are prepared to hand to the browser.
-- javascript: and data: URIs in particular must never reach an href.
alter table tasks add constraint tasks_context_uri_scheme check (
  context_uri is null
  or context_uri ~* '^(https?|obsidian|vscode|file|notion|zotero)://'
);

alter table user_settings
  add column if not exists focus_hides_navigation boolean not null default true,
  add column if not exists focus_autostart_timer boolean not null default true;

