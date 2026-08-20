import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/data/queries";
import { getRunningTimer } from "@/lib/data/analytics";
import { RunningTimerBar } from "@/components/RunningTimerBar";
import { CommandPalette } from "@/components/CommandPalette";

const NAV = [
  { href: "/calendar", label: "Calendar" },
  { href: "/tasks", label: "Tasks" },
  { href: "/focus", label: "Focus" },
  { href: "/review", label: "Review" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [ctx, timer] = await Promise.all([getUserContext(), getRunningTimer()]);
  // proxy.ts already blocks anonymous requests; this catches the narrower case
  // of a signed-in user who never finished onboarding.
  if (!ctx) redirect("/onboarding");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-5">
          <Link href="/calendar" className="text-sm font-semibold tracking-tight">
            IB Calendar OS
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-app px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-sunken hover:text-text"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-subtle">
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-xs sm:inline">
              ⌘ Space
            </kbd>
            <span>{ctx.displayName || ctx.timezone}</span>
          </div>
        </div>
      </header>
      {/*
        A timer running unnoticed silently inflates every statistic downstream.
        It gets a persistent bar so it can never be invisible.
      */}
      {timer && <RunningTimerBar title={timer.title} startedAt={timer.startedAt} />}
      <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>
      <CommandPalette />
    </div>
  );
}
