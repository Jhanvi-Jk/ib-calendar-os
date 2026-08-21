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
