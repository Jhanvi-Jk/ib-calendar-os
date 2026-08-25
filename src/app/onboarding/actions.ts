"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { subjectColorToken } from "@/lib/domain/colors";
import { energyRowsForUser } from "@/lib/domain/energy";
import { parseClock } from "@/lib/time";

const SubjectInput = z.object({
  name: z.string().min(1).max(80),
  level: z.enum(["HL", "SL", "CORE"]),
  ibGroup: z.number().int().min(1).max(6).nullable(),
});

const OnboardingInput = z.object({
  displayName: z.string().max(80).optional().default(""),
  timezone: z.string().min(1),
  chronotype: z.enum(["lark", "neutral", "owl"]),
  sleepStart: z.string().regex(/^\d{2}:\d{2}$/),
  sleepEnd: z.string().regex(/^\d{2}:\d{2}$/),
  dayStart: z.string().regex(/^\d{2}:\d{2}$/),
  dayEnd: z.string().regex(/^\d{2}:\d{2}$/),
  maxDailyFocusMin: z.number().int().min(30).max(960),
  subjects: z.array(SubjectInput).min(1).max(12),
});

export type OnboardingPayload = z.infer<typeof OnboardingInput>;

export async function completeOnboarding(raw: unknown) {
  const parsed = OnboardingInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  // A timezone the runtime cannot resolve would silently corrupt every local
  // day boundary the solver computes, so reject it here rather than storing it.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    return { ok: false as const, error: `Unknown timezone: ${input.timezone}` };
  }

  if (parseClock(input.dayEnd) <= parseClock(input.dayStart)) {
    return { ok: false as const, error: "Day end must be after day start." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      display_name: input.displayName,
      timezone: input.timezone,
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (profileError) return { ok: false as const, error: profileError.message };

  const { error: settingsError } = await supabase
    .from("user_settings")
    .update({
      sleep_start: input.sleepStart,
      sleep_end: input.sleepEnd,
      day_start: input.dayStart,
      day_end: input.dayEnd,
      max_daily_focus_min: input.maxDailyFocusMin,
    })
    .eq("user_id", user.id);
  if (settingsError) return { ok: false as const, error: settingsError.message };

  const { error: energyError } = await supabase
    .from("energy_profile")
    .upsert(energyRowsForUser(user.id, input.chronotype), {
      onConflict: "user_id,dow,hour",
    });
  if (energyError) return { ok: false as const, error: energyError.message };

  const { error: subjectError } = await supabase.from("subjects").upsert(
    input.subjects.map((s, i) => ({
      user_id: user.id,
      name: s.name,
      level: s.level,
      ib_group: s.level === "CORE" ? null : s.ibGroup,
      color_token: subjectColorToken(i),
    })),
    { onConflict: "user_id,name" },
  );
  if (subjectError) return { ok: false as const, error: subjectError.message };

  redirect("/calendar");
}
