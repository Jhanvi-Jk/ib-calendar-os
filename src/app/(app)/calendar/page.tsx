import Link from "next/link";
import { WeekGrid, type CalendarItem } from "@/components/calendar/WeekGrid";
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

  const nowMin = Math.floor(Date.now() / 60_000);
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
    ...(run?.blocks ?? [])
      .filter((b) => b.startsAt < weekEnd && b.endsAt > weekStart)
      .map((b) => ({
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
        <div className="ml-auto flex items-center gap-1 text-sm">
          <Link
            href={`/calendar?week=${offset - 1}`}
            className="rounded-app px-2 py-1 text-muted hover:bg-surface-sunken"
          >
            ←
          </Link>
          <Link
            href="/calendar"
            className="rounded-app px-2 py-1 text-muted hover:bg-surface-sunken"
          >
            Today
          </Link>
          <Link
            href={`/calendar?week=${offset + 1}`}
            className="rounded-app px-2 py-1 text-muted hover:bg-surface-sunken"
          >
            →
          </Link>
        </div>
      </div>

      <PlanBar
        infeasibility={(run?.infeasibility ?? []) as Infeasibility[]}
        stats={run?.stats ?? {}}
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
          />
        </div>
      )}
    </div>
  );
}
