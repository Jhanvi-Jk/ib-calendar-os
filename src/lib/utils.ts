import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ConstraintTier } from "@/lib/domain/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Tier -> semantic classes. Components never name a raw color; they name a
 * tier and let the active theme resolve it.
 */
export const TIER_STYLES: Record<
  ConstraintTier,
  { bar: string; chip: string; label: string }
> = {
  1: { bar: "bg-tier-1", chip: "bg-tier-1-soft text-tier-1", label: "Immutable" },
  2: { bar: "bg-tier-2", chip: "bg-tier-2-soft text-tier-2", label: "Committed" },
  3: { bar: "bg-tier-3", chip: "bg-tier-3-soft text-tier-3", label: "Planned" },
  4: { bar: "bg-tier-4", chip: "bg-tier-4-soft text-tier-4", label: "Elastic" },
  5: { bar: "bg-tier-5", chip: "bg-tier-5-soft text-tier-5", label: "Recovery" },
};

export const COGNITIVE_LOAD_LABELS: Record<number, string> = {
  1: "Admin",
  2: "Light",
  3: "Moderate",
  4: "Demanding",
  5: "Deep",
};
