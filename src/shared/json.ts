/**
 * Canonical (deterministic) JSON serialization.
 *
 * The provenance ledger's hash chain (ADR-006) hashes each entry over its
 * serialized form, so two structurally-equal entries MUST serialize to
 * byte-identical strings — otherwise `verify()` reports false breakage.
 * `JSON.stringify` does not guarantee this: object key order follows insertion
 * order, which varies with how an entry happened to be built.
 *
 * `canonicalize` removes the one degree of freedom that matters — object key
 * order — by sorting keys recursively, and otherwise mirrors `JSON.stringify`
 * semantics (its string escaping and number formatting are already
 * deterministic in ECMAScript). The result is always valid JSON that
 * `JSON.parse` round-trips modulo key order. The function is pure and depends
 * on nothing outside this module.
 *
 * Semantics, matching `JSON.stringify` except for key ordering:
 * - Object keys are sorted by UTF-16 code unit (stable, locale-independent).
 * - Array element order is preserved (order is meaningful in arrays).
 * - `toJSON()` is honored (e.g. `Date` → ISO string) before serialization.
 * - Object properties whose value is `undefined`, a function, or a symbol are
 *   omitted; the same values inside an array become `null`.
 * - Non-finite numbers (`NaN`, `Infinity`) become `null`.
 * - `bigint` is unsupported and throws a `TypeError`, as in `JSON.stringify`.
 */
export function canonicalize(value: unknown): string {
  const serialized = serialize(value);
  if (serialized === undefined) {
    throw new TypeError('canonicalize: top-level value is not serializable to JSON');
  }
  return serialized;
}

/**
 * Serialize a single value to its canonical form, or `undefined` when the
 * value has no JSON representation (`undefined`, functions, symbols) so callers
 * can drop it from an object or coerce it to `null` inside an array.
 */
function serialize(value: unknown): string | undefined {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    // Honor toJSON() exactly as JSON.stringify does (e.g. Date → ISO string).
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      return serialize(toJson.call(value));
    }
    return Array.isArray(value)
      ? serializeArray(value)
      : serializeObject(value as Record<string, unknown>);
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalize: BigInt values cannot be serialized to JSON');
    default:
      // undefined, function, symbol — no JSON representation.
      return undefined;
  }
}

function serializeArray(value: readonly unknown[]): string {
  // undefined / function / symbol elements become null, as in JSON.stringify.
  const items = value.map((element) => serialize(element) ?? 'null');
  return `[${items.join(',')}]`;
}

function serializeObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const members: string[] = [];
  for (const key of keys) {
    const serialized = serialize(value[key]);
    if (serialized === undefined) {
      continue; // omit undefined / function / symbol valued keys, as JSON does
    }
    members.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${members.join(',')}}`;
}
