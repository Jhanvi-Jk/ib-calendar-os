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
