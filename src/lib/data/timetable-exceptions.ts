import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Cancelled occurrences of recurring timetable entries.
 *
 * Returned as a `Set` of `entryId:YYYY-MM-DD` because that is exactly the
 * shape `expandTimetable` needs, and building it here keeps the expansion
 * itself pure.
 *
 * Degrades to an empty set if migration 011 has not been applied — an app that
 * shows an uncancelled lesson is wrong in a small way; one that 500s on the
 * calendar is wrong in a way that matters.
 */
export const getCancelledOccurrences = cache(
  async (): Promise<ReadonlySet<string>> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("timetable_exceptions")
      .select("entry_id, on_date");

    if (error) return new Set();
    return new Set((data ?? []).map((r) => `${r.entry_id}:${r.on_date}`));
  },
);
