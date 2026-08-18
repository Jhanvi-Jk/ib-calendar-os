import type { SolverSnapshot } from "@/lib/domain/types";

/**
 * Deterministic hash of a solver input.
 *
 * Stored as schedule_runs.input_hash. A re-solve whose hash and seed match the
 * active run can short-circuit — which is what stops the app reshuffling a
 * student's week every time a page revalidates.
 *
 * FNV-1a over canonical JSON rather than a crypto hash: the engine must stay
 * dependency-free and runnable in any environment, and this is not a security
 * boundary.
 */

/** JSON with object keys sorted at every depth, so key order cannot leak in. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function fnv1a(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function hashSnapshot(snapshot: SolverSnapshot): string {
  // Only the fields that can change the output. Deliberately excludes userId,
  // so an identical plan is recognised as identical regardless of who asked.
  return fnv1a(
    canonicalize({
      timezone: snapshot.timezone,
      horizonStart: snapshot.horizonStart,
      horizonEnd: snapshot.horizonEnd,
      settings: snapshot.settings,
      energy: snapshot.energy,
      subjects: snapshot.subjects,
      events: snapshot.events,
      tasks: snapshot.tasks,
      dependencies: snapshot.dependencies,
      lockedBlocks: snapshot.lockedBlocks,
      seed: snapshot.seed,
    }),
  );
}
