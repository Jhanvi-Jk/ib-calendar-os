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
