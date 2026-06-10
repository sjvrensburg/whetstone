/**
 * `coaching/` — Builds coaching requests, enforces structured output,
 * orchestrates a coaching turn. Calls `providers` + `guard`; emits ledger
 * events (Component Overview).
 *
 * Task 02 adds the forced-output schema + validator; task 12 adds the request
 * build + turn pipeline.
 */
export * from './schema';
