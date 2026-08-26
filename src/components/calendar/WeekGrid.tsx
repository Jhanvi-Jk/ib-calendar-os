"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { cn, TIER_STYLES } from "@/lib/utils";
import { assignLanes } from "@/lib/calendar/lanes";
import {
  ZOOM_LEVELS,
  clampZoomIndex,
  gridStepMin,
  setZoomIndex,
  subscribeZoom,
  zoomServerSnapshot,
  zoomSnapshot,
} from "@/lib/calendar/zoom";
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
  /** Drives the body tint. Null for sleep, lunch, breaks and untagged events. */
  subjectId?: string | null;
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
  subjectColors,
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
  /** subjectId -> colour token ("subject-3"). Built once by the server. */
  subjectColors?: Record<string, string>;
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

  const zoomIndex = useSyncExternalStore(subscribeZoom, zoomSnapshot, zoomServerSnapshot);
  const hourRem = ZOOM_LEVELS[zoomIndex];
  const stepMin = gridStepMin(hourRem);

  // Rules every `stepMin`; only whole hours get a label, or the gutter turns
  // into a wall of numbers at the finest zoom.
  const rules = useMemo(() => {
    const out: Array<{ min: number; isHour: boolean }> = [];
    for (let m = windowStart; m <= windowEnd; m += stepMin) {
      out.push({ min: m, isHour: m % 60 === 0 });
    }
    return out;
  }, [windowStart, windowEnd, stepMin]);

  const hours = useMemo(() => rules.filter((r) => r.isHour), [rules]);

  /**
   * Items are placed per day rather than per week: an item crossing local
   * midnight is clipped into each day it touches, which is what makes sleep
   * and overnight events render correctly.
   */
  const byDay = useMemo(() => {
    const map = new Map<
      number,
      Array<CalendarItem & { topPct: number; heightPct: number; lane: number; lanes: number }>
    >();
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
          return { ...it, startMin, endMin, topPct: top, heightPct: height };
        })
        .filter((it) => it.heightPct > 0 && it.topPct < 100);
      // Anything simultaneous gets its own column. Drawn full-width they were
      // painted on top of each other, so a lesson could vanish behind a study
      // block and the hour looked free.
      map.set(day.index, assignLanes(inDay).sort((a, b) => a.topPct - b.topPct));
    }
    return map;
  }, [days, items, timezone, windowStart, visibleMinutes]);

  const todayKey = startOfLocalDay(nowMin, timezone);

  /**
   * Trackpad zoom, anchored to the pointer.
   *
   * A macOS pinch arrives as a wheel event with ctrlKey set, so the same
   * handler serves pinch and ctrl-scroll. Plain scrolling is left alone —
   * hijacking it would break the one gesture people expect to just work.
   *
   * The anchor is the point: zooming without it makes the grid lurch, because
   * the same scrollTop means a different time once an hour changes height.
   * The minute under the cursor is recorded before the change and restored
   * after layout, so the row you are pointing at stays put.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<{ min: number; clientY: number } | null>(null);
  const wheelAccum = useRef(0);

  useEffect(() => {
    // Bound to the grid, not the scroll container: the anchor is then derived
    // from the grid's own rect, which is scroll-independent. Reading
    // scrollTop here would make this effect a consumer of the scroll ref and
    // block the two effects below from writing it.
    const body = bodyRef.current;
    if (!body) return;

    const onWheel = (event: WheelEvent) => {
      // macOS pinch arrives as a wheel event with ctrlKey, so one handler
      // serves pinch and ctrl-scroll. Plain scrolling is left alone.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();

      wheelAccum.current += event.deltaY;
      // A trackpad emits many small deltas; stepping on each would race
      // through every level in one flick.
      if (Math.abs(wheelAccum.current) < 40) return;
      const direction = wheelAccum.current > 0 ? -1 : 1;
      wheelAccum.current = 0;

      const current = zoomSnapshot();
      const next = clampZoomIndex(current + direction);
      if (next === current) return;

      // Measured, not derived from rem — a rem is not a fixed pixel count.
      const rect = body.getBoundingClientRect();
      const fraction = (event.clientY - rect.top) / (rect.height || 1);
      pendingAnchor.current = {
        min: windowStart + fraction * visibleMinutes,
        clientY: event.clientY,
      };
      setZoomIndex(next);
    };

    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [windowStart, visibleMinutes]);

  /**
   * The one place that moves the scroll position.
   *
   * Two effects both writing scrollTop fight each other and, in a React
   * Compiler build, are rejected outright. There are only two reasons to move
   * it — restore the pinch anchor, or open near the current hour on first
   * paint — so they live together and the anchor wins.
   */
  const hasOpened = useRef(false);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const body = bodyRef.current;
    if (!scroller || !body) return;

    const bodyH = body.offsetHeight || 1;
    const headerH = headerRef.current?.offsetHeight ?? 0;
    const anchor = pendingAnchor.current;

    // Zoom: put the minute that was under the cursor back under the cursor.
    // Without this the grid lurches, because the same scrollTop means a
    // different time once an hour changes height.
    if (anchor) {
      pendingAnchor.current = null;
      const fraction = (anchor.min - windowStart) / visibleMinutes;
      const cursorOffset = anchor.clientY - scroller.getBoundingClientRect().top;
      scroller.scrollTop = fraction * bodyH + headerH - cursorOffset;
      return;
    }

    // First paint: the grid is taller than the viewport, so without this every
    // visit starts at 06:50 and scrolls past hours already gone.
    if (hasOpened.current) return;
    hasOpened.current = true;
    const nowInDay = minutesIntoLocalDay(nowMin, timezone);
    const target = Math.min(
      Math.max(nowInDay - 60, windowStart),
      Math.max(windowStart, windowEnd - 60),
    );
    scroller.scrollTop = ((target - windowStart) / visibleMinutes) * bodyH;
  }, [hourRem, nowMin, timezone, windowStart, windowEnd, visibleMinutes]);

  return (
    // No forced minimum width: a fixed 52rem meant a narrow window clipped
    // two days off the week and made the user scroll sideways to find them.
    // Columns compress instead, and the day labels shorten rather than the
    // week losing days.
    <div className="overflow-x-auto">
      <div className="min-w-0">
        {/*
          The week scrolls inside its own box rather than taking the page with
          it, so the day headings stay put while you move through the hours —
          the thing every calendar does and the reason you can tell which
          column you are looking at halfway down a Thursday.
        */}
        <div
          ref={scrollRef}
          className="max-h-[min(70vh,44rem)] overflow-y-auto overscroll-contain"
        >
        {/* header */}
        <div ref={headerRef} className="sticky top-0 z-40 grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] border-b border-border bg-surface sm:grid-cols-[3.5rem_repeat(7,1fr)]">
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
          ref={bodyRef}
          className="relative grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] sm:grid-cols-[3.5rem_repeat(7,1fr)]"
          style={{ height: `calc(${visibleMinutes / 60} * ${hourRem}rem)` }}
        >
          {/* hour rules */}
          <div className="relative">
            {hours.map(({ min: m }) => (
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
              {rules.map(({ min: m, isHour }) => (
                <div
                  key={m}
                  className={cn(
                    "pointer-events-none absolute inset-x-0 border-t",
                    // Sub-hour rules are fainter so the hour still reads as
                    // the anchor rather than every line shouting equally.
                    isHour ? "border-border/60" : "border-border/25",
                  )}
                  style={{ top: `${((m - windowStart) / visibleMinutes) * 100}%` }}
                />
              ))}

              {(byDay.get(d.index) ?? []).map((it) => {
                const tier = TIER_STYLES[it.tier];
                // Two questions, two channels: the left border says how
                // immovable this is, the body tint says what subject it is.
                // A Maths lesson and a Maths revision block share a hue while
                // still reading as Tier 1 and Tier 3.
                const token = it.subjectId ? subjectColors?.[it.subjectId] : null;
                // A 10-minute registration slot is ~0.6rem tall at default
                // zoom. Forcing it to a readable 1.15rem made it TALLER than
                // the ten minutes it represents, so it bled up behind the
                // lesson above and showed as a clipped rounded corner. Below
                // the readable threshold it becomes a plain bar at its true
                // height; the title stays in the tooltip, and zooming in gives
                // it room to become a card again.
                const renderedRem = (it.heightPct / 100) * (visibleMinutes / 60) * hourRem;
                const isSliver = renderedRem < 1.15;
                return (
                  <button
                    key={`${it.id}-${d.index}`}
                    onClick={() => onSelect?.(it)}
                    className={cn(
                      "absolute overflow-hidden text-left text-xs",
                      "border-l-4 transition-shadow hover:shadow-md hover:brightness-110",
                      isSliver ? "rounded-sm px-1 py-0" : "rounded-lg px-1.5 py-1 sm:px-2",
                      // Only fall back to the flat tier fill when there is no
                      // subject to colour by.
                      token
                        ? "backdrop-blur-[1px]"
                        : it.variant === "event"
                          ? "bg-surface-raised"
                          : "bg-tier-3-soft/70 backdrop-blur-[1px]",
                    )}
                    style={{
                      top: `${it.topPct}%`,
                      // No artificial minimum for slivers: the whole bug was a
                      // block drawn taller than its own duration.
                      height: isSliver ? `${it.heightPct}%` : `max(1.15rem, ${it.heightPct}%)`,
                      // Columns within the overlap cluster. The 2px gutter is
                      // what makes two adjacent blocks read as two things.
                      left: `calc(${(it.lane / it.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / it.lanes}% - 4px)`,
                      // The accent bar carries the SUBJECT, not the tier. Tier was
                      // fighting the body tint for the same two square
                      // centimetres and turning every block into two unrelated
                      // colours; immovability is already carried by the padlock,
                      // which is a label rather than a hue and so survives a
                      // colour-vision deficiency.
                      borderLeftColor: token
                        ? `var(--${token})`
                        : `var(--tier-${it.tier})`,
                      ...(token ? { backgroundColor: `var(--${token}-soft)` } : {}),
                      // Later items sit above earlier ones so a short block
                      // inside a long lesson stays clickable.
                      zIndex: it.lane + 1,
                    }}
                    title={`${it.title} · ${formatRange(it.startsAt, it.endsAt, timezone)}`}
                  >
                    {!isSliver && (
                      <div className="flex items-center gap-1 font-medium text-text">
                        {it.isLocked && (
                          <span aria-label="Fixed — cannot be moved" className="opacity-50">
                            🔒
                          </span>
                        )}
                        <span className="truncate">{it.title}</span>
                      </div>
                    )}
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
    </div>
  );
}
