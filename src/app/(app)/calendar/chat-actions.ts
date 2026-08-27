"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/data/queries";
import { generatePlan } from "@/app/(app)/calendar/actions";
import { setOccurrenceCancelled } from "@/app/(app)/settings/timetable-actions";
import { writeOffDay } from "@/app/(app)/actions";
import { fromEpochMinute, startOfLocalDay, toEpochMinute } from "@/lib/time";

/**
 * Applying a parsed chat intent.
 *
 * The parsing happens in lib/commands/chat.ts and is a pure function over a
 * closed grammar — no model is involved, so nothing here can be handed a date
 * or an id that was invented. This still re-validates everything it receives,
 * because a server action is a public endpoint whatever the intended caller.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const Intent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("block_time"),
    dateKey: z.string().regex(DATE_KEY),
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(1).max(1440),
    label: z.string().min(1).max(120),
  }),
  z.object({
    kind: z.literal("lesson"),
    command: z.object({
      kind: z.enum(["cancel", "restore"]),
      entryId: z.string().uuid(),
      label: z.string(),
      dateKey: z.string().regex(DATE_KEY),
    }),
  }),
  z.object({ kind: z.literal("finished_early") }),
  z.object({ kind: z.literal("write_off_today") }),
  z.object({ kind: z.literal("replan") }),
]);

export async function applyChatIntent(raw: unknown) {
  const parsed = Intent.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: "I could not act on that." };
  }
  const intent = parsed.data;
  const ctx = await getUserContext();
  if (!ctx) return { ok: false as const, error: "Not signed in." };

  switch (intent.kind) {
    case "block_time": {
      if (intent.endMin <= intent.startMin) {
        return { ok: false as const, error: "That range ends before it starts." };
      }
      const supabase = await createClient();
      // Local wall-clock minutes, converted through the user's timezone rather
      // than assumed to be UTC — "7pm" means 7pm where they are.
      const dayStart = startOfLocalDay(
        toEpochMinute(new Date(`${intent.dateKey}T12:00:00Z`)),
        ctx.timezone,
      );
      // startOfLocalDay already lands on local midnight as an epoch minute, so
      // wall-clock minutes are a plain offset from it.
      const startsAt = dayStart + intent.startMin;
      const endsAt = dayStart + intent.endMin;

      const { error } = await supabase.from("events").insert({
        user_id: ctx.userId,
        title: intent.label,
        starts_at: fromEpochMinute(startsAt).toISOString(),
        ends_at: fromEpochMinute(endsAt).toISOString(),
        // Tier 1 and locked: the whole point of saying "I am busy" is that the
        // planner treats it as a wall, not a preference.
        tier: 1,
        kind: "commitment",
        is_locked: true,
        source: "chat",
      });
      if (error) return { ok: false as const, error: error.message };

      const replan = await generatePlan();
      revalidatePath("/calendar");
      return {
        ok: true as const,
        message: replan.ok
          ? `Held, and the plan moved around it.`
          : `Held, but the re-plan failed: ${replan.error}`,
      };
    }

    case "lesson": {
      const res = await setOccurrenceCancelled(intent.command);
      return res.ok
        ? { ok: true as const, message: `Done — ${intent.command.label} on ${intent.command.dateKey}.` }
        : { ok: false as const, error: res.error };
    }

    case "write_off_today": {
      const todayKey = new Date().toISOString().slice(0, 10);
      const res = await writeOffDay({ day: todayKey, reason: "other" });
      return res.ok
        ? { ok: true as const, message: "Today is written off. It will not count against you." }
        : { ok: false as const, error: res.error ?? "Could not write off today." };
    }

    case "finished_early":
    case "replan": {
      const res = await generatePlan();
      return res.ok
        ? { ok: true as const, message: res.unchanged ? "Nothing needed moving." : "Re-planned." }
        : { ok: false as const, error: res.error };
    }
  }
}
