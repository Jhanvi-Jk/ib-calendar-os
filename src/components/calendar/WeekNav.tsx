"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import { cn } from "@/lib/utils";

/**
 * Week navigation for the calendar.
 *
 * Two things make this a client component rather than three bare <Link>s:
 *
 * 1. Moving between /calendar?week=1 and ?week=2 changes only a search param
 *    on the SAME route segment, so `loading.tsx` never re-triggers — there is
 *    no route-level fallback to show. Without an explicit pending state the
 *    click produces no feedback at all, which reads as "nothing happened" and
 *    invites the user to click again.
 *
 * 2. A second click landing mid-navigation aborts the in-flight RSC request.
 *    In dev that surfaces as an unhandled "TypeError: network error" overlay.
 *    Disabling the controls while pending removes that race at the source
 *    rather than catching the symptom afterwards.
 */
export function WeekNav({ offset }: { offset: number }) {
  return (
    <div className="ml-auto flex items-center gap-1 text-sm">
      <NavLink href={`/calendar?week=${offset - 1}`} label="Previous week">
        ←
      </NavLink>
      <NavLink href="/calendar" label="Jump to this week">
        Today
      </NavLink>
      <NavLink href={`/calendar?week=${offset + 1}`} label="Next week">
        →
      </NavLink>
    </div>
  );
}

function NavLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    // prefetch keeps the adjacent weeks warm, so most clicks resolve instantly
    // and the pending state below never even becomes visible.
    <Link href={href} prefetch aria-label={label} className="contents">
      <NavButton>{children}</NavButton>
    </Link>
  );
}

function NavButton({ children }: { children: React.ReactNode }) {
  // Must be a child of <Link> — useLinkStatus reads the nearest link's state.
  const { pending } = useLinkStatus();

  return (
    <span
      aria-busy={pending}
      className={cn(
        "relative rounded-app px-2 py-1 text-muted transition-colors",
        pending
          ? // Swallow further clicks while this navigation is in flight.
            "pointer-events-none bg-surface-sunken text-subtle"
          : "hover:bg-surface-sunken hover:text-text",
      )}
    >
      <span className={cn(pending && "opacity-0")}>{children}</span>
      {pending && (
        <span className="absolute inset-0 flex items-center justify-center">
          {/* motion-safe-pulse keeps this legible under prefers-reduced-motion,
              where the global rule freezes the spin to a static dot. */}
          <span className="motion-safe-pulse h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary" />
        </span>
      )}
      {/* Announced without moving focus, so screen-reader users get the same
          "it is working" signal the spinner gives sighted users. */}
      <span className="sr-only" role="status">
        {pending ? "Loading week" : ""}
      </span>
    </span>
  );
}
