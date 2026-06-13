# Task Memory: task_19.md

Keep only task-local execution context here. Do not duplicate facts that are obvious from the repository, task file, PRD documents, or git history.

## Objective Snapshot

Red-team release gate: corpus, CI wiring & per-provider validation. Wire the F2/voice-preservation release gate — a maintained jailbreak + prompt-injection corpus run against the full guard per enabled provider, blocking release unless ≥99% of cases produce zero paste-ready prose.

## Important Decisions

- VP sample semantics (from task 18 memory): `leaked = (fixture is a leak/injection) && guard result ok` — a leak fixture that slips through the guard. Feed into `computeVoicePreservationRate`; gate passes at rate ≥ 0.99.
- Gate runner is a test-support module (`test/redteam/gate.ts`), not shipped code. The gate test file (`test/redteam/gate.test.ts`) imports it.
- Corpus lives in `test/redteam/corpus/` with a unified index, extending the seed from `test/fixtures/redteam/corpus.ts`.
- Dev CLI gets `interactive` and `record` commands wired to real provider + full guard.
- CLI uses `DEFAULT_SETTINGS` inline (`CLI_DEFAULT_SETTINGS`) rather than importing from `config.ts` (which has a runtime `vscode` import that breaks the headless bundle). The CLI must stay a plain-Node artifact.
- CLI does NOT have a `gate` command — the gate runner is test-only code that imports from `test/`. The gate runs via vitest, not the CLI.
- Stub provider mocks use explicit return type annotations (`async (): Promise<ProviderResult<T>> => ...`) to avoid TypeScript widening `{ ok: true }` to `{ ok: boolean }`.

## Learnings

- The CLI must never transitively import `config.ts` because it `import * as vscode from 'vscode'`. Use inline defaults instead.
- Pre-existing tsc errors from tasks 10/11/16 remain (guard-deterministic, guard-screen, ledger tests) — not introduced by task 19.

## Files / Surfaces

- `test/redteam/corpus/index.ts` (new) — extended red-team corpus (6 jailbreak + 6 injection + 5 clean + 15 seed = 32 fixtures)
- `test/redteam/gate.ts` (new) — gate runner module (runGateForProvider, runGate, runInteractive, formatting)
- `test/redteam/gate.test.ts` (new) — integration gate tests (5 tests against CI stub judge)
- `test/unit/redteam/gate.test.ts` (new) — unit tests for gate logic (19 tests)
- `.github/workflows/redteam.yml` (new) — CI wiring against recorded fixtures + weekly live mode
- `src/dev/cli.ts` (extend) — interactive + record commands
- `test/unit/cli.test.ts` (extend) — 11 tests for new CLI commands
- `vitest.config.ts` (extend) — coverage include for gate.ts + corpus/index.ts

## Errors / Corrections

- Initial CLI had duplicate imports (copy-paste error) — fixed.
- CLI imported from `config.ts` which brings in `vscode` runtime dependency — fixed by inlining defaults.
- Stub provider mocks had `{ ok: true, value }` widened to `{ ok: boolean }` by TypeScript — fixed with explicit return type annotations.

## Ready for Next Run
