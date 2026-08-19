import { WeekGrid, type CalendarItem } from "@/components/calendar/WeekGrid";
import { WeekNav } from "@/components/calendar/WeekNav";
import { PlanBar } from "@/components/calendar/PlanBar";
import { EmptyState } from "@/components/ui";
import {
  getActiveRun,
  getEvents,
  getOpenTasks,
  getUserContext,
} from "@/lib/data/queries";
import type { Infeasibility } from "@/lib/domain/types";
import {
  addLocalDays,
  fromEpochMinute,
  localParts,
  startOfLocalDay,
  toEpochMinute,
} from "@/lib/time";
import type { ConstraintTier } from "@/lib/domain/types";

export default async function CalendarPage({
  searchParams,
}: {
  // Async in Next 16.
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const offset = Number.isFinite(Number(week)) ? Number(week) : 0;

  const ctx = await getUserContext();
  if (!ctx) return null;
  const { timezone, settings } = ctx;

  // Server component: rendered once per request, so reading the clock here
  // is correct. Uses the shared helper for consistency with the rest of the app.
  const nowMin = toEpochMinute(new Date());
  const today = startOfLocalDay(nowMin, timezone);
  // Weeks start on Sunday, matching energy_profile.dow.
  const thisWeekStart = addLocalDays(today, -localParts(today, timezone).dow, timezone);
  const weekStart = addLocalDays(thisWeekStart, offset * 7, timezone);
  const weekEnd = addLocalDays(weekStart, 7, timezone);

  const [events, run, tasks] = await Promise.all([
    getEvents(
      fromEpochMinute(weekStart).toISOString(),
      fromEpochMinute(weekEnd).toISOString(),
    ),
    getActiveRun(),
    getOpenTasks(),
  ]);

  const taskTitles = Object.fromEntries(tasks.map((t) => [t.id, t.title]));

  // The header stats and the empty state must be derived from the SAME blocks,
  // or they contradict each other: the solver's stats cover the whole ~21-day
  // horizon, so a plan with everything scheduled next week reported
  // "1h scheduled" above a body saying "Nothing scheduled this week".
  const blocksThisWeek = (run?.blocks ?? []).filter(
    (b) => b.startsAt < weekEnd && b.endsAt > weekStart,
  );
  const weekScheduledMin = blocksThisWeek.reduce(
    (sum, b) => sum + (b.endsAt - b.startsAt),
    0,
  );
  const horizonScheduledMin = (run?.blocks ?? []).reduce(
    (sum, b) => sum + (b.endsAt - b.startsAt),
    0,
  );

  const items: CalendarItem[] = [
    ...events.map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      variant: "event" as const,
      tier: e.tier,
      isLocked: e.isLocked,
    })),
    ...blocksThisWeek.map((b) => ({
      id: b.id,
      title: b.taskTitle,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      variant: "block" as const,
      tier: 3 as ConstraintTier,
      isLocked: b.isLocked,
    })),
  ];

  const label = `${localParts(weekStart, timezone).day} – ${
    localParts(addLocalDays(weekStart, 6, timezone), timezone).day
  }`;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Week of {label}</h1>
        <WeekNav offset={offset} />
      </div>

      <PlanBar
        infeasibility={(run?.infeasibility ?? []) as Infeasibility[]}
        weekScheduledMin={weekScheduledMin}
        horizonScheduledMin={horizonScheduledMin}
        taskTitles={taskTitles}
        hasPlan={Boolean(run)}
      />

      {items.length === 0 ? (
        <EmptyState title="Nothing scheduled this week">
          Add your classes and deadlines, then generate a plan.
        </EmptyState>
      ) : (
        <div className="rounded-app border border-border bg-surface">
          <WeekGrid
            weekStart={weekStart}
            items={items}
            timezone={timezone}
            dayStartMin={settings.dayStartMin}
            dayEndMin={settings.dayEndMin}
            nowMin={nowMin}
          />
        </div>
      )}
    </div>
  );
}
