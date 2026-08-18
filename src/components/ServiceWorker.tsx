"use client";

import { useEffect } from "react";

/** Registers the offline read cache. No-op in development. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // A failed registration only costs offline support; never surface it.
    });
  }, []);

  return null;
}
