"use client";

import { useMemo } from "react";
import { cn, TIER_STYLES } from "@/lib/utils";
import {
  MIN_PER_DAY,
  addLocalDays,
  formatRange,
  localParts,
  minutesIntoLocalDay,
  startOfLocalDay,
} from "@/lib/time";
import type { ConstraintTier, EpochMinute } from "@/lib/domain/types";

export interface CalendarItem {
  id: string;
  title: string;
  startsAt: EpochMinute;
  endsAt: EpochMinute;
  /** Study blocks produced by the solver render differently from fixed reality. */
  variant: "event" | "block";
  tier: ConstraintTier;
  isLocked: boolean;
  subtitle?: string;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WeekGrid({
  weekStart,
  items,
  timezone,
  dayStartMin,
  dayEndMin,
  nowMin,
  onSelect,
}: {
  /** Epoch minute of local midnight on the first rendered day. */
  weekStart: EpochMinute;
  items: CalendarItem[];
  timezone: string;
  dayStartMin: number;
  dayEndMin: number;
  /** Passed in rather than read here: reading the clock during render is
   *  impure, so the "today" highlight could shift on an unrelated re-render. */
  nowMin: EpochMinute;
  onSelect?: (item: CalendarItem) => void;
}) {
  // Render an hour beyond the working window on each side so events that spill
  // outside it (a late appointment, an early exam) are still visible.
  const windowStart = Math.max(0, Math.floor(dayStartMin / 60) * 60 - 60);
  const windowEnd = Math.min(MIN_PER_DAY, Math.ceil(dayEndMin / 60) * 60 + 60);
  const visibleMinutes = windowEnd - windowStart;

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const dayStart = addLocalDays(weekStart, i, timezone);
        return { index: i, startsAt: dayStart, parts: localParts(dayStart, timezone) };
      }),
    [weekStart, timezone],
  );

  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = windowStart; m <= windowEnd; m += 60) out.push(m);
    return out;
  }, [windowStart, windowEnd]);

  /**
   * Items are placed per day rather than per week: an item crossing local
   * midnight is clipped into each day it touches, which is what makes sleep
   * and overnight events render correctly.
   */
  const byDay = useMemo(() => {
    const map = new Map<number, Array<CalendarItem & { topPct: number; heightPct: number }>>();
    for (const day of days) {
      const dayEnd = addLocalDays(day.startsAt, 1, timezone);
      const inDay = items
        .filter((it) => it.startsAt < dayEnd && it.endsAt > day.startsAt)
        .map((it) => {
          const clippedStart = Math.max(it.startsAt, day.startsAt);
          const clippedEnd = Math.min(it.endsAt, dayEnd);
          const startMin = minutesIntoLocalDay(clippedStart, timezone);
          // A clip landing exactly on midnight reads as 0, which would be wrong
          // for the *end* of a segment — treat it as the full day instead.
          const rawEnd = minutesIntoLocalDay(clippedEnd, timezone);
          const endMin = rawEnd === 0 && clippedEnd > clippedStart ? MIN_PER_DAY : rawEnd;

          const top = ((startMin - windowStart) / visibleMinutes) * 100;
          const height = ((endMin - startMin) / visibleMinutes) * 100;
          return { ...it, topPct: top, heightPct: height };
        })
        .filter((it) => it.heightPct > 0 && it.topPct < 100)
        .sort((a, b) => a.topPct - b.topPct);
      map.set(day.index, inDay);
    }
    return map;
  }, [days, items, timezone, windowStart, visibleMinutes]);

  const todayKey = startOfLocalDay(nowMin, timezone);

  return (
    // No forced minimum width: a fixed 52rem meant a narrow window clipped
    // two days off the week and made the user scroll sideways to find them.
    // Columns compress instead, and the day labels shorten rather than the
    // week losing days.
    <div className="overflow-x-auto">
      <div className="min-w-0">
        {/* header */}
        <div className="grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] border-b border-border sm:grid-cols-[3.5rem_repeat(7,1fr)]">
          <div />
          {days.map((d) => {
            const isToday = d.startsAt === todayKey;
            return (
              <div key={d.index} className="px-0.5 py-2 text-center sm:px-2">
                <div className="text-xs uppercase tracking-wide text-subtle">
                  <span className="hidden sm:inline">{DAY_LABELS[d.parts.dow]}</span>
                  <span className="sm:hidden">{DAY_LABELS[d.parts.dow][0]}</span>
                </div>
                <div
                  className={cn(
                    "mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm",
                    isToday ? "bg-primary font-semibold text-inverse" : "text-text",
                  )}
                >
                  {d.parts.day}
                </div>
              </div>
            );
          })}
        </div>

        {/* body */}
        <div
          className="relative grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] sm:grid-cols-[3.5rem_repeat(7,1fr)]"
          style={{ height: `calc(${visibleMinutes / 60} * var(--hour-height))` }}
        >
          {/* hour rules */}
          <div className="relative">
            {hours.map((m) => (
              <div
                key={m}
                className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-subtle sm:right-2 sm:text-xs"
                style={{ top: `${((m - windowStart) / visibleMinutes) * 100}%` }}
              >
                {String(Math.floor(m / 60)).padStart(2, "0")}
              </div>
            ))}
          </div>

          {days.map((d) => (
            <div key={d.index} className="relative border-l border-border">
              {hours.map((m) => (
                <div
                  key={m}
                  className="pointer-events-none absolute inset-x-0 border-t border-border/60"
                  style={{ top: `${((m - windowStart) / visibleMinutes) * 100}%` }}
                />
              ))}

              {(byDay.get(d.index) ?? []).map((it) => {
                const tier = TIER_STYLES[it.tier];
                return (
                  <button
                    key={`${it.id}-${d.index}`}
                    onClick={() => onSelect?.(it)}
                    className={cn(
                      "absolute inset-x-0.5 overflow-hidden rounded-md px-1 py-1 text-left text-xs sm:inset-x-1 sm:px-2",
                      "border-l-[3px] transition-shadow hover:shadow-md",
                      it.variant === "event"
                        ? "bg-surface-raised"
                        : "bg-tier-3-soft/70 backdrop-blur-[1px]",
                    )}
                    style={{
                      top: `${it.topPct}%`,
                      height: `max(1.15rem, ${it.heightPct}%)`,
                      borderLeftColor: `var(--tier-${it.tier})`,
                    }}
                    title={`${it.title} · ${formatRange(it.startsAt, it.endsAt, timezone)}`}
                  >
                    <div className="flex items-center gap-1 font-medium text-text">
                      {it.isLocked && <span aria-label="locked">🔒</span>}
                      <span className="truncate">{it.title}</span>
                    </div>
                    {it.heightPct > 6 && (
                      <div className={cn("truncate", tier.chip, "bg-transparent px-0")}>
                        {it.subtitle ?? formatRange(it.startsAt, it.endsAt, timezone)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
