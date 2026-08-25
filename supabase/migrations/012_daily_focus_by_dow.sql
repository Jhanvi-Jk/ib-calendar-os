-- ============================================================================
-- 012_daily_focus_by_dow.sql
--
-- A per-weekday ceiling on focused study.
--
-- max_daily_focus_min is one number applied to all seven days, which models a
-- week nobody actually has. This student's Thursday is a school-sanctioned
-- self-study day with 685 free minutes; their Monday has seven hours of
-- lessons and 510. Both were rationed at 270, so Thursday discarded 415
-- minutes of capacity while the plan reported work it could not fit.
--
-- Stored as jsonb keyed by day of week ("0" = Sunday, matching
-- energy_profile.dow and timetable_entries.day_of_week) so adding a day costs
-- no migration. Null, or a missing key, falls back to max_daily_focus_min —
-- the flat number remains the default for anyone who has not set this.
-- ============================================================================

do $guard$
begin
  if to_regclass('public.user_settings') is null then
    raise exception
      'Migration 012 cannot run: migration 001 (foundation) is not present in this database.';
  end if;
end
$guard$;

alter table user_settings
  add column if not exists max_daily_focus_by_dow jsonb;

-- Postgres forbids a subquery inside CHECK, so the shape test lives in an
-- immutable function. Without it a typo becomes a day the solver believes has
-- forty hours in it.
create or replace function is_valid_focus_by_dow(v jsonb)
returns boolean
language sql
immutable
as $fn$
  select v is null or (
    jsonb_typeof(v) = 'object'
    and coalesce(
      (select bool_and(
                e.key in ('0','1','2','3','4','5','6')
                and jsonb_typeof(e.value) = 'number'
                and (e.value #>> '{}')::numeric between 0 and 960)
       from jsonb_each(v) as e),
      true)  -- an empty object is valid; it simply overrides nothing
  );
$fn$;

alter table user_settings drop constraint if exists focus_by_dow_shape;
alter table user_settings
  add constraint focus_by_dow_shape check (is_valid_focus_by_dow(max_daily_focus_by_dow));

comment on column user_settings.max_daily_focus_by_dow is
  'Per-weekday focus ceiling in minutes, keyed "0"-"6" with 0 = Sunday. Null or missing key falls back to max_daily_focus_min.';
