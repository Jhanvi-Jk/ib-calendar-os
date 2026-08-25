/**
 * How many subject hues `globals.css` defines.
 *
 * Kept here so the two places that assign a colour cannot drift from the
 * stylesheet. Onboarding previously wrapped at 8 while a full IB diploma is
 * nine rows — six subjects plus TOK, CAS and the Extended Essay — so the ninth
 * subject silently shared a colour with the first.
 */
export const SUBJECT_COLOR_COUNT = 10;

export const subjectColorToken = (index: number): string =>
  `subject-${((index % SUBJECT_COLOR_COUNT) + SUBJECT_COLOR_COUNT) % SUBJECT_COLOR_COUNT}`;

/** The lowest-numbered hue not already spoken for. */
export function nextFreeSubjectColor(taken: readonly string[]): string {
  const used = new Set(taken);
  for (let i = 0; i < SUBJECT_COLOR_COUNT; i++) {
    const token = subjectColorToken(i);
    if (!used.has(token)) return token;
  }
  return subjectColorToken(taken.length);
}
