-- ============================================================================
-- 01_guardrails.sql — behavioural tests for the schema's safety properties.
--
-- These assert the guarantees the scheduling engine is allowed to ASSUME.
-- If any of these fail, the solver is unsafe to run.
-- Usage: psql <db> -v ON_ERROR_STOP=1 -f 01_guardrails.sql
-- ============================================================================

create or replace function assert_rejects(p_sql text, p_label text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'PASS  %  (rejected: %)', p_label, left(sqlerrm, 70);
    return;
  end;
  raise exception 'FAIL  % — statement was ACCEPTED but should have been rejected', p_label;
end;
$$;

create or replace function assert_true(p_cond boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_cond then
    raise notice 'PASS  %', p_label;
  else
    raise exception 'FAIL  %', p_label;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
do $$
declare
  u        uuid := '11111111-1111-1111-1111-111111111111';
  s_math   uuid;
  t_outline uuid; t_draft uuid; t_final uuid;
  run_a    uuid; run_b    uuid;
  te       uuid;
  n        int;
begin
  -- ===== bootstrap ========================================================
  insert into auth.users (id, email) values (u, 'ib@example.com');

  perform assert_true(
    (select count(*) from profiles where id = u) = 1,
    'new user gets a profile');
  perform assert_true(
    (select count(*) from user_settings where user_id = u) = 1,
    'new user gets settings');
  perform assert_true(
    (select count(*) from energy_profile where user_id = u) = 168,
    'new user gets a full 168-slot energy curve');
  perform assert_true(
    (select count(*) from calendars where user_id = u and is_app_managed) = 1,
    'new user gets exactly one app-managed calendar');

  perform assert_rejects(format(
    $q$insert into calendars (user_id, name, is_app_managed)
       values (%L, 'Second app calendar', true)$q$, u),
    'a second app-managed calendar is rejected');

  -- ===== subjects =========================================================
  insert into subjects (user_id, name, ib_group, level, grade_weight)
    values (u, 'Mathematics AA', 5, 'HL', 1.0) returning id into s_math;

  perform assert_rejects(format(
    $q$insert into subjects (user_id, name, ib_group, level)
       values (%L, 'Extended Essay', 3, 'CORE')$q$, u),
    'a CORE subject with an IB group is rejected');

  -- ===== Tier 1 immutability ==============================================
  insert into events (user_id, title, starts_at, ends_at, tier, kind)
    values (u, 'Maths HL Paper 1', '2026-05-04 09:00Z', '2026-05-04 11:00Z', 1, 'exam');

  perform assert_rejects(format(
    $q$insert into events (user_id, title, starts_at, ends_at, tier, kind)
       values (%L, 'Dentist', '2026-05-04 10:00Z', '2026-05-04 10:30Z', 1, 'appointment')$q$, u),
    'Tier 1 events cannot overlap (exam vs appointment)');

  -- Tier 3 is movable work; overlap there is the solver's business, not the DB's.
  insert into events (user_id, title, starts_at, ends_at, tier)
    values (u, 'Flexible study', '2026-05-04 09:30Z', '2026-05-04 10:00Z', 3);
  perform assert_true(true, 'Tier 3 events may overlap Tier 1 (solver resolves)');

  perform assert_rejects(format(
    $q$insert into events (user_id, title, starts_at, ends_at)
       values (%L, 'Backwards', '2026-05-04 11:00Z', '2026-05-04 09:00Z')$q$, u),
    'an event ending before it starts is rejected');

  -- ===== tasks ============================================================
  insert into tasks (user_id, subject_id, title, estimate_min, cognitive_load)
    values (u, s_math, 'IA: outline', 120, 4) returning id into t_outline;
  insert into tasks (user_id, subject_id, title, estimate_min)
    values (u, s_math, 'IA: first draft', 300) returning id into t_draft;
  insert into tasks (user_id, subject_id, title, estimate_min)
    values (u, s_math, 'IA: final', 180) returning id into t_final;

  perform assert_true(
    (select remaining_min from tasks where id = t_outline) = 120,
    'remaining_min is seeded from estimate_min on insert');

  perform assert_rejects(format(
    $q$insert into tasks (user_id, title, estimate_min, remaining_min)
       values (%L, 'Impossible', 60, 90)$q$, u),
    'remaining_min greater than estimate_min is rejected');

  perform assert_rejects(format(
    $q$insert into tasks (user_id, title, earliest_start_at, deadline_at)
       values (%L, 'Inverted window', '2026-06-01Z', '2026-05-01Z')$q$, u),
    'a task whose window ends before it opens is rejected');

  -- ===== the DAG ==========================================================
  insert into task_dependencies (user_id, predecessor_id, successor_id)
    values (u, t_outline, t_draft), (u, t_draft, t_final);

  perform assert_rejects(format(
    $q$insert into task_dependencies (user_id, predecessor_id, successor_id)
       values (%L, %L, %L)$q$, u, t_final, t_outline),
    'a dependency closing a cycle is rejected (final -> outline)');

  perform assert_rejects(format(
    $q$insert into task_dependencies (user_id, predecessor_id, successor_id)
       values (%L, %L, %L)$q$, u, t_draft, t_draft),
    'a self-dependency is rejected');

  perform assert_true(
    (select count(*) from task_dependencies where user_id = u) = 2,
    'the valid dependency chain survived the rejected cycles');

  -- ===== schedule runs ====================================================
  insert into schedule_runs (user_id, horizon_start, horizon_end, input_hash, is_active, status)
    values (u, '2026-04-01Z', '2026-04-22Z', 'hash-a', true, 'active') returning id into run_a;
  insert into schedule_runs (user_id, horizon_start, horizon_end, input_hash, parent_run_id)
    values (u, '2026-04-01Z', '2026-04-22Z', 'hash-b', run_a) returning id into run_b;

  perform assert_rejects(format(
    $q$update schedule_runs set is_active = true where id = %L$q$, run_b),
    'two simultaneously active runs are rejected');

  perform activate_schedule_run(run_b);
  perform assert_true(
    (select count(*) from schedule_runs where user_id = u and is_active) = 1
    and (select is_active from schedule_runs where id = run_b),
    'activate_schedule_run() swaps the active generation atomically');
  perform assert_true(
    (select status from schedule_runs where id = run_a) = 'superseded',
    'the previous run is marked superseded, not deleted (undo stays possible)');

  -- ===== blocks ===========================================================
  insert into scheduled_blocks (user_id, run_id, task_id, starts_at, ends_at)
    values (u, run_b, t_outline, '2026-04-02 16:00Z', '2026-04-02 17:00Z');

  perform assert_rejects(format(
    $q$insert into scheduled_blocks (user_id, run_id, task_id, starts_at, ends_at)
       values (%L, %L, %L, '2026-04-02 16:30Z', '2026-04-02 17:30Z')$q$, u, run_b, t_draft),
    'overlapping blocks within one run are rejected');

  -- The same slot in a different run is exactly what what-if branching needs.
  insert into scheduled_blocks (user_id, run_id, task_id, starts_at, ends_at)
    values (u, run_a, t_draft, '2026-04-02 16:30Z', '2026-04-02 17:30Z');
  perform assert_true(true, 'blocks may overlap ACROSS runs (what-if branching works)');

  -- ===== time tracking feedback loop ======================================
  insert into time_entries (user_id, task_id, started_at, ended_at)
    values (u, t_outline, '2026-04-02 16:00Z', '2026-04-02 16:45Z') returning id into te;

  perform assert_true(
    (select duration_min from time_entries where id = te) = 45,
    'closing a time entry computes duration_min');
  perform assert_true(
    (select actual_min from tasks where id = t_outline) = 45,
    'closed time rolls into tasks.actual_min');
  perform assert_true(
    (select remaining_min from tasks where id = t_outline) = 75,
    'closed time decrements tasks.remaining_min (120 - 45)');

  insert into time_entries (user_id, task_id, started_at) values (u, t_draft, '2026-04-02 18:00Z');
  perform assert_rejects(format(
    $q$insert into time_entries (user_id, task_id, started_at)
       values (%L, %L, '2026-04-02 19:00Z')$q$, u, t_final),
    'a second concurrently running timer is rejected');

  -- ===== completion =======================================================
  update tasks set status = 'done' where id = t_final;
  perform assert_true(
    (select remaining_min = 0 and completed_at is not null from tasks where id = t_final),
    'completing a task zeroes remaining_min and stamps completed_at');

  -- ===== context hydration ================================================
  perform assert_rejects(format(
    $q$update tasks set context_uri = 'javascript:alert(1)' where id = %L$q$, t_draft),
    'a javascript: context URI is rejected before it can reach an href');

  perform assert_rejects(format(
    $q$update tasks set context_uri = 'data:text/html,<script>x</script>' where id = %L$q$, t_draft),
    'a data: context URI is rejected');

  update tasks set context_uri = 'obsidian://open?file=Physics%20IA' where id = t_draft;
  perform assert_true(
    (select context_uri is not null from tasks where id = t_draft),
    'an obsidian:// context URI is accepted');

  -- ===== academic calendar ================================================
  insert into academic_dates (user_id, kind, label, starts_on, ends_on, is_primary)
    values (u, 'exam_session', 'IB May 2027', '2027-05-01', '2027-05-19', true);

  perform assert_rejects(format(
    $q$insert into academic_dates (user_id, kind, label, starts_on, is_primary)
       values (%L, 'mock_exams', 'Mocks', '2027-01-12', true)$q$, u),
    'a second primary academic date is rejected');

  perform assert_rejects(format(
    $q$insert into academic_dates (user_id, kind, label, starts_on, ends_on)
       values (%L, 'half_term', 'Backwards break', '2026-11-01', '2026-10-24')$q$, u),
    'an academic range ending before it starts is rejected');

  insert into academic_dates (user_id, kind, label, starts_on, ends_on)
    values (u, 'half_term', 'October half term', '2026-10-24', '2026-11-01');
  perform assert_true(
    (select count(*) from academic_dates where user_id = u) = 2,
    'non-primary academic dates coexist freely');

  -- ===== timetable ========================================================
  insert into timetable_entries (user_id, label, day_of_week, starts_min, ends_min)
    values (u, 'Physics HL', 1, 540, 600);

  perform assert_rejects(format(
    $q$insert into timetable_entries (user_id, label, day_of_week, starts_min, ends_min)
       values (%L, 'Backwards period', 1, 600, 540)$q$, u),
    'a lesson ending before it starts is rejected');

  perform assert_rejects(format(
    $q$insert into timetable_entries (user_id, label, day_of_week, starts_min, ends_min)
       values (%L, 'Day 9', 9, 540, 600)$q$, u),
    'an out-of-range day_of_week is rejected');

  perform assert_rejects(format(
    $q$insert into timetable_entries (user_id, label, day_of_week, starts_min, ends_min, active_from, active_to)
       values (%L, 'Inverted term', 1, 540, 600, '2027-01-01', '2026-01-01')$q$, u),
    'a timetable entry whose active range is inverted is rejected');

  -- Two lessons at the same time is a real timetable clash the student must
  -- see, not a database error, so the schema deliberately allows it.
  insert into timetable_entries (user_id, label, day_of_week, starts_min, ends_min, parity)
    values (u, 'Chemistry HL', 1, 540, 600, 'B');
  perform assert_true(
    (select count(*) from timetable_entries where user_id = u) = 2,
    'overlapping timetable entries are allowed (parity resolves them)');

  -- ===== study quotas =====================================================
  declare q uuid;
  begin
    insert into study_quotas (user_id, label, target_min_week, min_session_min, max_session_min)
      values (u, 'SAT Maths', 180, 30, 60) returning id into q;

    perform assert_rejects(format(
      $q$insert into study_quotas (user_id, label, target_min_week, min_session_min, max_session_min)
         values (%L, 'Backwards sessions', 180, 90, 30)$q$, u),
      'a quota whose max session is below its min is rejected');

    insert into tasks (user_id, title, estimate_min, quota_id, quota_week)
      values (u, 'SAT Maths w/c', 180, q, '2026-08-17');

    perform assert_rejects(format(
      $q$insert into tasks (user_id, title, estimate_min, quota_id, quota_week)
         values (%L, 'SAT Maths dupe', 180, %L, '2026-08-17')$q$, u, q),
      'a second task for the same quota-week is rejected (generation is idempotent)');

    perform assert_rejects(format(
      $q$insert into tasks (user_id, title, estimate_min, quota_id)
         values (%L, 'Quota without a week', 180, %L)$q$, u, q),
      'a quota task without a quota_week is rejected');

    insert into tasks (user_id, title, estimate_min, quota_id, quota_week)
      values (u, 'SAT Maths next week', 180, q, '2026-08-24');
    perform assert_true(
      (select count(*) from tasks where quota_id = q) = 2,
      'different quota-weeks coexist');
  end;

  -- ===== sick days ========================================================
  insert into day_write_offs (user_id, day, reason) values (u, '2026-09-15', 'illness');

  perform assert_rejects(format(
    $q$insert into day_write_offs (user_id, day, reason)
       values (%L, '2026-09-15', 'burnout')$q$, u),
    'writing off the same day twice is rejected (one write-off, not two)');

  insert into day_write_offs (user_id, day, reason) values (u, '2026-09-16', 'family');
  perform assert_true(
    (select count(*) from day_write_offs where user_id = u) = 2,
    'different days can each be written off');

  -- ===== revision =========================================================
  declare rt uuid;
  begin
    insert into revision_topics (user_id, subject_id, label, confidence, triggered_on)
      values (u, s_math, 'Geometric progressions', 2, '2026-09-07') returning id into rt;

    insert into revision_passes (user_id, topic_id, pass_index, earliest_on, due_on, estimate_min)
      values (u, rt, 0, '2026-09-08', '2026-09-10', 45);

    perform assert_rejects(format(
      $q$insert into revision_passes (user_id, topic_id, pass_index, earliest_on, due_on, estimate_min)
         values (%L, %L, 0, '2026-09-08', '2026-09-10', 45)$q$, u, rt),
      'a duplicate revision pass index is rejected (cycles are idempotent)');

    perform assert_rejects(format(
      $q$insert into revision_passes (user_id, topic_id, pass_index, earliest_on, due_on, estimate_min)
         values (%L, %L, 1, '2026-09-20', '2026-09-13', 30)$q$, u, rt),
      'a revision window ending before it opens is rejected');

    perform assert_rejects(format(
      $q$insert into revision_topics (user_id, label, confidence, triggered_on)
         values (%L, 'Impossible confidence', 9, '2026-09-07')$q$, u),
      'a confidence outside 1-5 is rejected');

    insert into revision_passes (user_id, topic_id, pass_index, is_pre_exam, earliest_on, due_on, estimate_min)
      values (u, rt, 3, true, '2028-04-06', '2028-04-20', 35);
    perform assert_true(
      (select count(*) from revision_passes where topic_id = rt) = 2,
      'spaced and pre-exam passes coexist on one topic');
  end;

  -- ===== timetable exceptions =============================================
  declare tte uuid;
  begin
    insert into timetable_entries (user_id, label, day_of_week, starts_min, ends_min)
      values (u, 'Teaching', 4, 600, 780) returning id into tte;

    insert into timetable_exceptions (user_id, entry_id, on_date, reason)
      values (u, tte, '2026-08-27', 'not on this week');

    -- Cancelling twice is the same as cancelling once. This is what lets the
    -- command be re-run, and two devices race, without a spurious failure.
    perform assert_rejects(format(
      $q$insert into timetable_exceptions (user_id, entry_id, on_date)
         values (%L, %L, '2026-08-27')$q$, u, tte),
      'cancelling the same occurrence twice is rejected (the command is idempotent)');

    insert into timetable_exceptions (user_id, entry_id, on_date)
      values (u, tte, '2026-09-03');
    perform assert_true(
      (select count(*) from timetable_exceptions where entry_id = tte) = 2,
      'different dates can each be cancelled on one entry');

    -- Subtractive, not destructive: removing the exception must bring the
    -- lesson back rather than leave a hole in the pattern.
    delete from timetable_exceptions where entry_id = tte and on_date = '2026-08-27';
    perform assert_true(
      (select count(*) from timetable_exceptions where entry_id = tte) = 1
      and (select count(*) from timetable_entries where id = tte) = 1,
      'restoring an occurrence leaves the timetable entry intact');

    -- The exception belongs to the lesson; dropping the lesson must not leave
    -- an orphan pointing at nothing.
    delete from timetable_entries where id = tte;
    perform assert_true(
      (select count(*) from timetable_exceptions where entry_id = tte) = 0,
      'deleting a lesson cascades to its cancellations');
  end;

  -- ===== per-weekday focus caps ===========================================
  update user_settings set max_daily_focus_by_dow = '{"4":420,"6":360}'::jsonb
    where user_id = u;
  perform assert_true(
    (select (max_daily_focus_by_dow->>'4')::int from user_settings where user_id = u) = 420,
    'a per-weekday focus cap is stored');

  perform assert_rejects(format(
    $q$update user_settings set max_daily_focus_by_dow = '{"9":300}'::jsonb where user_id = %L$q$, u),
    'a day of week outside 0-6 is rejected');

  perform assert_rejects(format(
    $q$update user_settings set max_daily_focus_by_dow = '{"4":5000}'::jsonb where user_id = %L$q$, u),
    'a focus cap longer than a day is rejected');

  perform assert_rejects(format(
    $q$update user_settings set max_daily_focus_by_dow = '{"4":"lots"}'::jsonb where user_id = %L$q$, u),
    'a non-numeric focus cap is rejected');

  update user_settings set max_daily_focus_by_dow = null where user_id = u;
  perform assert_true(
    (select max_daily_focus_by_dow is null from user_settings where user_id = u),
    'clearing the override falls back to the flat cap');

  raise notice '────────────────────────────────────────────';
  raise notice 'ALL GUARDRAIL TESTS PASSED';
end;
$$;
