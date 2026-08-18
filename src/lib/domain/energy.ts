import type { EnergyCurve } from "@/lib/domain/types";

/**
 * Seeds the 168-slot cognitive capacity curve from a self-reported chronotype.
 *
 * This is only a starting point. Once ~20 time entries land for a slot, the
 * calibration job replaces these guesses with the user's observed throughput —
 * a night owl who actually produces nothing after 22:00 should stop being
 * scheduled there regardless of what they told us during onboarding.
 */
export type Chronotype = "lark" | "neutral" | "owl";

/** Relative capacity by hour, 0–23. 1.0 = baseline hour. */
const HOURLY: Record<Chronotype, number[]> = {
  //     0    1    2    3    4    5    6    7    8    9   10   11
  //    12   13   14   15   16   17   18   19   20   21   22   23
  lark: [
    0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.8, 1.15, 1.3, 1.3, 1.25, 1.1,
    0.85, 0.7, 0.85, 0.95, 1.0, 0.95, 0.8, 0.75, 0.65, 0.5, 0.3, 0.1,
  ],
  neutral: [
    0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.5, 0.85, 1.05, 1.2, 1.25, 1.15,
    0.9, 0.7, 0.85, 1.0, 1.1, 1.05, 0.9, 0.9, 0.85, 0.7, 0.45, 0.2,
  ],
  owl: [
    0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.4, 0.6, 0.8, 0.95, 1.0,
    0.9, 0.8, 0.9, 1.0, 1.1, 1.15, 1.1, 1.15, 1.25, 1.25, 1.05, 0.6,
  ],
};

/** Weekends carry slightly lower structure but more available hours. */
const DOW_SCALE = [0.9, 1.0, 1.0, 1.0, 1.0, 0.95, 0.85];

export function seedEnergyCurve(chronotype: Chronotype): EnergyCurve {
  const hourly = HOURLY[chronotype];
  return Array.from({ length: 7 }, (_, dow) =>
    hourly.map((v) => Math.round(v * DOW_SCALE[dow] * 100) / 100),
  );
}

/** Flat curve — used by tests that want capacity effects isolated. */
export function flatEnergyCurve(value = 1): EnergyCurve {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => value));
}

export function energyRowsForUser(userId: string, chronotype: Chronotype) {
  const curve = seedEnergyCurve(chronotype);
  const rows: { user_id: string; dow: number; hour: number; multiplier: number }[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      rows.push({ user_id: userId, dow, hour, multiplier: curve[dow][hour] });
    }
  }
  return rows;
}
