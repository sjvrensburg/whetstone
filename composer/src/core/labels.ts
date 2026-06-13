/**
 * Forbidden-label guard — ported from V1 `src/friction/mirror.ts` and
 * promoted to a shared concern (ADR-009): applied to every user-facing
 * artifact so no string implies "verified human" / proof-of-personhood.
 */

/** Words/phrases that MUST NOT appear in any user-facing artifact. */
export const FORBIDDEN_PHRASES = [
  'human score',
  'proof of personhood',
  'proof of human',
  'verified human',
  'humanness',
  'humanity score',
  'ai score',
  'authenticity score',
  'authorship score',
] as const;

/** `true` if the text is clean of proof-of-personhood language. */
export function hasNoForbiddenLabels(text: string): boolean {
  const lower = text.toLowerCase();
  return !FORBIDDEN_PHRASES.some((phrase) => lower.includes(phrase));
}

/** Return the forbidden phrases present in `text` (empty when clean). */
export function findForbiddenLabels(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_PHRASES.filter((phrase) => lower.includes(phrase));
}

/**
 * Guard a user-facing artifact: throws if it contains forbidden language.
 * Used at generation boundaries (e.g. disclosure export) so an over-claiming
 * string can never reach the user.
 */
export function assertNoForbiddenLabels(text: string, context: string): void {
  const found = findForbiddenLabels(text);
  if (found.length > 0) {
    throw new Error(`Forbidden label(s) in ${context}: ${found.join(', ')}`);
  }
}
