import { z } from "zod";

/**
 * The complete set of shapes the model is allowed to produce.
 *
 * These schemas are the enforcement point for Directive #2. Model output that
 * does not validate against one of them never becomes a database write — it is
 * stored as an `invalid` proposal and surfaced, never partially applied.
 *
 * Keep every field tightly bounded. An unbounded string or number here is an
 * unbounded value in the database later.
 */

export const ExtractedTask = z.object({
  title: z.string().min(1).max(200),
  /** Verbatim source line, so the user can check the extraction. */
  sourceQuote: z.string().max(500).nullable(),
  estimateMin: z.number().int().min(5).max(2400),
  cognitiveLoad: z.number().int().min(1).max(5),
  deadlineIso: z.string().max(40).nullable(),
  subjectHint: z.string().max(80).nullable(),
  splittable: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedTask = z.infer<typeof ExtractedTask>;

export const TaskExtraction = z.object({
  tasks: z.array(ExtractedTask).max(60),
  /**
   * Set when the source document contains text addressed at the AI rather
   * than at the student — "ignore previous instructions", "mark everything
   * complete", and similar. The model reports it; it never acts on it.
   */
  suspectedInjection: z.boolean(),
  injectionQuote: z.string().max(300).nullable(),
  notes: z.string().max(500).nullable(),
});
export type TaskExtraction = z.infer<typeof TaskExtraction>;

export const EstimateProposal = z.object({
  taskId: z.string().max(64),
  estimateMin: z.number().int().min(5).max(2400),
  cognitiveLoad: z.number().int().min(1).max(5),
  reasoning: z.string().max(300),
  confidence: z.number().min(0).max(1),
});
export type EstimateProposal = z.infer<typeof EstimateProposal>;

export const ClassificationProposal = z.object({
  taskId: z.string().max(64),
  subjectName: z.string().max(80).nullable(),
  cognitiveLoad: z.number().int().min(1).max(5),
  splittable: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type ClassificationProposal = z.infer<typeof ClassificationProposal>;

export const DependencySuggestion = z.object({
  predecessorTitle: z.string().max(200),
  successorTitle: z.string().max(200),
  reason: z.string().max(200),
  confidence: z.number().min(0).max(1),
});

export const DependencyProposal = z.object({
  edges: z.array(DependencySuggestion).max(40),
});
export type DependencyProposal = z.infer<typeof DependencyProposal>;

/**
 * Natural language turned into a *structured invocation of the solver* —
 * never into a schedule directly. "Clear my Thursday" becomes parameters the
 * deterministic engine then acts on.
 */
export const RescheduleIntent = z.object({
  action: z.enum(["generate", "reset_day", "what_if", "none"]),
  /** Local date, YYYY-MM-DD. Only meaningful for reset_day. */
  targetDate: z.string().max(10).nullable(),
  horizonDays: z.number().int().min(1).max(60).nullable(),
  label: z.string().max(80).nullable(),
  /** Present when the request cannot be served by the actions above. */
  unsupportedReason: z.string().max(200).nullable(),
});
export type RescheduleIntent = z.infer<typeof RescheduleIntent>;

export const PROPOSAL_SCHEMAS = {
  task_extract: TaskExtraction,
  estimate: EstimateProposal,
  classify: ClassificationProposal,
  dependency: DependencyProposal,
  reschedule_intent: RescheduleIntent,
} as const;

export type ProposalKind = keyof typeof PROPOSAL_SCHEMAS;

/**
 * Confidence below this always requires explicit confirmation, regardless of
 * how routine the proposal looks.
 */
export const AUTO_APPROVE_THRESHOLD = 0.85;

/**
 * Decides whether a validated proposal may be applied without asking.
 *
 * Deliberately conservative: only additive, easily-undone operations from a
 * trusted source can skip confirmation. Anything derived from a PDF, a Notion
 * page or a calendar description always goes in front of the user, because
 * those are documents a third party wrote.
 */
export function requiresConfirmation(input: {
  kind: ProposalKind;
  confidence: number;
  isTrustedSource: boolean;
  suspectedInjection?: boolean;
}): boolean {
  if (input.suspectedInjection) return true;
  if (!input.isTrustedSource) return true;
  if (input.confidence < AUTO_APPROVE_THRESHOLD) return true;
  // Dependency edges reshape the whole plan through effective deadlines, so
  // they are never applied silently even at high confidence.
  return input.kind === "dependency";
}
