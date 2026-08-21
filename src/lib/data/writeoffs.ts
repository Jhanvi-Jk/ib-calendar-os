import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { localDateKey } from "@/lib/time";
import type { EpochMinute } from "@/lib/domain/types";

/** Written-off local dates inside a range. Empty if migration 009 is absent. */
export const getWrittenOffDaysForRange = cache(
  async (fromMin: EpochMinute, toMin: EpochMinute, timezone: string): Promise<string[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("day_write_offs")
      .select("day")
      .gte("day", localDateKey(fromMin, timezone))
      .lte("day", localDateKey(toMin, timezone));

    if (error) return [];
    return (data ?? []).map((r) => r.day as string);
  },
);
