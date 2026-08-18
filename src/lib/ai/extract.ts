import { fenceUntrusted, requestStructured, type AiResult } from "./client";
import {
  ClassificationProposal,
  DependencyProposal,
  EstimateProposal,
  RescheduleIntent,
  TaskExtraction,
} from "./schemas";
import type { SchedulableTask, Subject } from "@/lib/domain/types";

/**
 * Patterns that look like an instruction aimed at an AI rather than at a
 * student. This is a cheap pre-filter that runs BEFORE any model call, so a
 * hostile document is flagged even if the model itself is talked out of
 * reporting it. Deliberately pure so it can be tested without an API key.
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, "override attempt"],
  [/disregard\s+(the\s+)?(system|above|previous)/i, "override attempt"],
  [/you\s+are\s+(now|actually)\s+a/i, "role reassignment"],
  [/\bnew\s+(system\s+)?(prompt|instructions?)\b/i, "prompt replacement"],
  [/mark\s+(all|everything)\s+(as\s+)?(complete|done)/i, "state mutation"],
  [/delete\s+(all|every)\b/i, "destructive instruction"],
  [/\bAPI[_\s-]?key\b|\bservice[_\s-]?role\b|\bsecret\b/i, "credential probe"],
  [/<\/?(system|assistant)>/i, "role-tag injection"],
  [/\bdo\s+not\s+(tell|show|inform)\s+the\s+user\b/i, "concealment instruction"],
];

export interface InjectionFinding {
  pattern: string;
  quote: string;
}

export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const [pattern, label] of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 40);
      findings.push({
        pattern: label,
        quote: text.slice(start, match.index + match[0].length + 60).trim(),
      });
    }
  }
  return findings;
}

/**
 * Parses a syllabus, assignment sheet or pasted deadline list into candidate
 * tasks. The result is a PROPOSAL — nothing is written here.
 */
export async function extractTasksFromDocument(input: {
  text: string;
  label: string;
  subjects: Subject[];
  todayIso: string;
}): Promise<AiResult<TaskExtraction> & { heuristicFindings: InjectionFinding[] }> {
  const heuristicFindings = scanForInjection(input.text);

  const subjectList = input.subjects.map((s) => `${s.name} (${s.level})`).join(", ");

  const result = await requestStructured({
    schema: TaskExtraction,
    system: `You extract IB coursework from documents.

Rules:
- Extract only work the student must actually DO. Skip syllabus prose, learning
  objectives, and administrative notes.
- estimateMin is your honest guess at focused working minutes for a competent
  IB student, not the elapsed calendar time available.
- cognitiveLoad: 1 admin, 2 light, 3 moderate, 4 demanding, 5 deep analytical.
- deadlineIso must be a full ISO 8601 instant or null. Never invent a deadline
  that is not stated or clearly implied.
- subjectHint must be one of the student's subjects, or null.
- sourceQuote must be copied verbatim from the document so the student can
  verify the extraction.`,
    prompt: `Today is ${input.todayIso}.
The student's subjects: ${subjectList || "(none recorded)"}.

Extract the coursework from this document.

${fenceUntrusted(input.text, input.label)}`,
  });

  return { ...result, heuristicFindings };
}

/** Suggests a duration and difficulty for a task the student typed. */
export async function estimateTask(input: {
  task: SchedulableTask;
  subject: Subject | undefined;
  /** Observed estimate:actual ratio for similar past work, if we have one. */
  calibration: { ratioP50: number; samples: number } | null;
}): Promise<AiResult<EstimateProposal>> {
  const calibrationNote = input.calibration
    ? `This student historically takes ${input.calibration.ratioP50}x their estimate on similar work (${input.calibration.samples} samples). Account for that.`
    : "No historical data for this student yet.";

  return requestStructured({
    schema: EstimateProposal,
    maxTokens: 4000,
    system: `You estimate how long IB coursework takes. Be realistic rather than
optimistic — an under-estimate produces an over-stuffed plan, which is the main
reason students abandon planners.`,
    prompt: `Task: "${input.task.title}"
Subject: ${input.subject ? `${input.subject.name} (${input.subject.level})` : "none"}
Student's own estimate: ${input.task.estimateMin} minutes
${calibrationNote}

Return the taskId "${input.task.id}" with your estimate.`,
  });
}

/** Assigns subject, cognitive load and splittability to an unclassified task. */
export async function classifyTask(input: {
  task: SchedulableTask;
  subjects: Subject[];
}): Promise<AiResult<ClassificationProposal>> {
  return requestStructured({
    schema: ClassificationProposal,
    maxTokens: 4000,
    system: `You classify IB coursework. splittable is false only when the work
genuinely must happen in one sitting (a timed past paper, a rehearsal); most
written work is splittable.`,
    prompt: `Task: "${input.task.title}"
Available subjects: ${input.subjects.map((s) => s.name).join(", ") || "(none)"}

Return the taskId "${input.task.id}" with your classification.`,
  });
}

/** Proposes dependency edges between tasks. Never auto-applied. */
export async function suggestDependencies(input: {
  tasks: SchedulableTask[];
}): Promise<AiResult<DependencyProposal>> {
  return requestStructured({
    schema: DependencyProposal,
    system: `You identify genuine prerequisites between pieces of IB coursework —
work that CANNOT start until other work is finished. Do not invent edges for
tasks that are merely related or in the same subject; a false dependency
silently delays real work.`,
    prompt: `Tasks:
${input.tasks.map((t) => `- ${t.title}`).join("\n")}

Return only real finish-to-start prerequisites, matching titles exactly.`,
  });
}

/**
 * Turns a natural-language request into a structured solver invocation.
 * The model chooses WHICH deterministic action runs; it never chooses when
 * individual work is scheduled.
 */
export async function parseRescheduleIntent(input: {
  utterance: string;
  todayIso: string;
  timezone: string;
}): Promise<AiResult<RescheduleIntent>> {
  return requestStructured({
    schema: RescheduleIntent,
    maxTokens: 2000,
    system: `You map a student's request onto exactly one of these actions:
- generate: rebuild the whole plan
- reset_day: rebuild a single day, leaving the rest untouched
- what_if: build a preview branch without changing the active plan
- none: the request is not a scheduling request

If the request cannot be served by these, use "none" and explain in
unsupportedReason. Never guess at an action that discards the student's plan.`,
    prompt: `Today is ${input.todayIso} in ${input.timezone}.
Student said: ${JSON.stringify(input.utterance)}`,
  });
}
