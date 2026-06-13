/**
 * `telemetry/redact.ts` — Prose/key redaction applied to every telemetry
 * event payload (task 18.1, ADR-004: "redaction in all telemetry").
 *
 * Telemetry is on-device and opt-out, but the brand-defining invariant is
 * stronger than that: **no prose or key ever appears in a telemetry event**,
 * even if a caller hands one in. This module is the single chokepoint that
 * enforces it — `TelemetrySink.record()` runs every payload through `redact()`
 * before storing it.
 *
 * Two things are stripped, recursively:
 *
 *   - **Prose** — any free-form string long enough to carry user writing.
 *     Mirrors the ledger's metadata-only cap (`MAX_PAYLOAD_STRING_LENGTH` in
 *     `ledger/index.ts`): strings longer than `PROSE_REDACTION_THRESHOLD` are
 *     replaced with `[REDACTED:prose]`. Short metadata strings (enum-like
 *     values such as `'pass'`, `'judge'`, `'coaching'`) survive.
 *
 *   - **Keys** — API keys, signing keys, tokens, passwords. Caught two ways:
 *     (a) by field name — any property whose name matches the secret pattern
 *     (`apiKey`, `secret`, `token`, …) is replaced wholesale; and
 *     (b) by content — any string that looks like an opaque credential
 *     (a known provider prefix, or a long no-space token) is replaced,
 *     regardless of the field it sits in.
 *
 * The function is total: it never throws (a throwing redactor could let a
 * raw payload escape unredacted), and it tolerates cycles defensively.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Strings longer than this are treated as prose and redacted. Matches the
 * ledger's metadata-only cap — telemetry, like the ledger, is metadata-only.
 */
export const PROSE_REDACTION_THRESHOLD = 280;

/** Replacement token for a redacted prose string. */
export const REDACTED_PROSE = '[REDACTED:prose]';

/** Replacement token for a redacted key/secret string. */
export const REDACTED_KEY = '[REDACTED:key]';

/**
 * Field-name heuristic for secrets. Any property whose name contains one of
 * these substrings (case-insensitive) is replaced wholesale. Over-redaction
 * is safe and intentional — we err toward privacy. Matches `apiKey`,
 * `api_key`, `secretKey`, `authToken`, `password`, `signingKey`, etc.
 */
export const SECRET_KEY_PATTERN = /key|secret|token|password|credential/i;

/**
 * Content pattern for common provider key prefixes. A string starting with
 * one of these is treated as a key no matter which field holds it.
 */
export const KEY_PREFIX_PATTERN = /^(sk-|Bearer\s|gl-|xai-|AKIA|ghp_|sk_ant_)/i;

/**
 * Minimum length for an opaque, no-whitespace token to be treated as a key by
 * the content heuristic. Real API keys / signing tokens are well above this;
 * ordinary metadata strings are well below.
 */
export const OPAQUE_TOKEN_MIN_LENGTH = 32;

// ---------------------------------------------------------------------------
// Content heuristics
// ---------------------------------------------------------------------------

/**
 * Whether a bare string value looks like an opaque credential, independent of
 * the field it sits in. True for known provider prefixes and for long,
 * no-whitespace tokens that mix letters and digits.
 */
export function isLikelyKey(value: string): boolean {
  if (KEY_PREFIX_PATTERN.test(value)) {
    return true;
  }
  // Long, no-whitespace, mixed alphanumeric → almost certainly a secret, not
  // prose (prose has spaces) and not short metadata.
  if (
    value.length >= OPAQUE_TOKEN_MIN_LENGTH &&
    !/\s/.test(value) &&
    /^[A-Za-z0-9._\-+/=]+$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recursive redaction
// ---------------------------------------------------------------------------

/**
 * Redact prose and keys from any value, recursively. Returns a structurally
 * equivalent value with prose/key strings replaced by redaction markers.
 *
 * - Object properties whose name matches the secret pattern → `[REDACTED:key]`.
 * - Strings that look like keys (by content) → `[REDACTED:key]`.
 * - Other strings longer than the prose threshold → `[REDACTED:prose]`.
 * - Everything else (short metadata, numbers, booleans) is preserved.
 *
 * Never throws; cycles are tolerated (a revisited object is replaced with
 * `[REDACTED:cycle]` rather than recursing forever).
 */
export function redact(value: unknown): unknown {
  return redactNode(value, undefined, new WeakSet<object>());
}

/** Sentinel returned for cyclic structures (defensive — payloads are acyclic). */
const REDACTED_CYCLE = '[REDACTED:cycle]';

function redactNode(value: unknown, field: string | undefined, seen: WeakSet<object>): unknown {
  // Field-name heuristic: a property named like a secret is redacted whole,
  // without recursing into it (so a key nested in an object field is caught).
  if (field !== undefined && SECRET_KEY_PATTERN.test(field)) {
    return REDACTED_KEY;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, undefined, seen));
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) {
      return REDACTED_CYCLE;
    }
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redactNode(v, k, seen);
    }
    return out;
  }

  if (typeof value === 'string') {
    if (isLikelyKey(value)) {
      return REDACTED_KEY;
    }
    if (value.length > PROSE_REDACTION_THRESHOLD) {
      return REDACTED_PROSE;
    }
    return value;
  }

  return value;
}
