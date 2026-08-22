-- ============================================================================
-- Remove a stray migration 009 that was applied to the WRONG project.
--
-- Migration 009 creates day_write_offs and the write_off_reason type. If it
-- was run against another project (a different app's database), those two
-- objects are sitting there doing nothing. This removes exactly those and
-- nothing else.
--
-- SAFE TO RUN. It refuses rather than destroys if it looks like it is
-- pointed at the real IB Calendar OS database, and it refuses if the table
-- holds any data. Worst case it tells you it did nothing.
--
-- Run this in the project where 009 landed by mistake.
-- ============================================================================

do $cleanup$
declare
  v_rows bigint := 0;
begin
  ------------------------------------------------------------------
  -- Refusal 1: is this actually the IB Calendar OS database?
  --
  -- study_quotas and timetable_entries exist only in this app. If either is
  -- present, day_write_offs is a real feature here and must not be dropped.
  ------------------------------------------------------------------
  if to_regclass('public.study_quotas') is not null
     or to_regclass('public.timetable_entries') is not null
     or to_regclass('public.academic_dates') is not null then
    raise notice 'REFUSED: this looks like the real IB Calendar OS database (found study_quotas / timetable_entries / academic_dates). Nothing was changed.';
    return;
  end if;

  ------------------------------------------------------------------
  -- Nothing to do?
  ------------------------------------------------------------------
  if to_regclass('public.day_write_offs') is null then
    raise notice 'Nothing to clean up: day_write_offs does not exist in this database.';
    -- The type can still be orphaned if the table was dropped by hand.
    if exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                where t.typname = 'write_off_reason' and n.nspname = 'public') then
      drop type public.write_off_reason;
      raise notice 'Dropped the orphaned write_off_reason type.';
    end if;
    return;
  end if;

  ------------------------------------------------------------------
  -- Refusal 2: never destroy data.
  --
  -- An empty table is junk. A table with rows is somebody's records, and
  -- this script has no business deciding they are disposable.
  ------------------------------------------------------------------
  execute 'select count(*) from public.day_write_offs' into v_rows;
  if v_rows > 0 then
    raise notice 'REFUSED: day_write_offs contains % row(s), so it is not an empty stray. Nothing was changed. Inspect it before removing it by hand.', v_rows;
    return;
  end if;

  ------------------------------------------------------------------
  -- Safe to remove. Table first (the policy and index go with it), then the
  -- type — which will itself fail loudly if anything else came to depend on
  -- it, rather than cascading through someone else's schema.
  ------------------------------------------------------------------
  drop table public.day_write_offs;
  raise notice 'Dropped table day_write_offs.';

  if exists (select 1 from pg_type t
               join pg_namespace n on n.oid = t.typnamespace
              where t.typname = 'write_off_reason' and n.nspname = 'public') then
    drop type public.write_off_reason;
    raise notice 'Dropped type write_off_reason.';
  end if;

  raise notice 'Cleanup complete. This database is back to how it was before migration 009 was run against it.';
end
$cleanup$;
