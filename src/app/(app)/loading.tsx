/**
 * Shown while a route segment streams in.
 *
 * Without this, App Router keeps the previous page's content on screen during
 * a soft navigation, so the nav highlights the new tab while the old content
 * is still visible — which reads as a broken or frozen page.
 */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-6 w-40 rounded-app bg-surface-sunken" />
      <div className="h-24 rounded-app bg-surface-sunken" />
      <div className="h-24 rounded-app bg-surface-sunken" />
    </div>
  );
}
