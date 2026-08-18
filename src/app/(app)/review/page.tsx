import { EmptyState } from "@/components/ui";

/** Filled in at roadmap steps 14–16 (analytics, momentum, retrospective). */
export default function ReviewPage() {
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold tracking-tight">Review</h1>
      <EmptyState title="Nothing to review yet">
        Momentum, estimate accuracy and your end-of-day retrospective appear here
        once you have tracked some work.
      </EmptyState>
    </div>
  );
}
