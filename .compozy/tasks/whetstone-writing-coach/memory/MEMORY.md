# Workflow Memory

Keep only durable, cross-task context here. Do not duplicate facts that are obvious from the repository, task file, PRD documents, or git history.

## Current State

- Tasks 01–22 complete. 869 tests passing. Coverage: 95% stmts / 93% branches / 98% funcs.
- Tasks 23–25 remaining.
- Default friction level = 1 (Coach). Floor = 0. Settings: `whetstone.friction.level`, `whetstone.friction.floor`, `whetstone.friction.overrides`.

## Shared Decisions

- Stack: TS strict, `module: commonjs`/`moduleResolution: node`; esbuild bundles `src/extension.ts`→`dist/extension.js` and `src/dev/main.ts`→`dist/dev/cli.js`. ESLint v8 + Prettier.
- Module boundary: domain logic in `src/<module>/`; `src/extension.ts` is wiring only (DI seam `createContainer`).
- Domain types single-sourced (`src/shared/types.ts`, `src/shared/constants.ts`). Coverage gate uses explicit allow-list in `vitest.config.ts`.
- `LedgerEventType` union in `src/shared/types.ts` — adding new members requires updating `zeroedCounts()` in `src/ledger/report.ts` and test fixtures with inline `countsByType` objects.

## Shared Learnings

- Two harnesses: vitest runs `test/unit/**` (never imports `vscode`); integration runs `src/test/**` via `@vscode/test-electron`.
- Unit-testing `vscode`-coupled modules: vitest aliases `vscode`→`test/support/vscode-stub.ts`.
- `ProviderResult<T>` (`{ok:true,value}|{ok:false,error}`) is universal return type.
- Adding `vscode` API surface requires extending `test/support/vscode-stub.ts` and updating extension subscription count test.
- Adding fields to `WhetstoneSettings` requires updating: `config.ts`, `package.json`, `dev/cli.ts`, and test files with inline settings snapshots.
- Friction modules reuse `extractNgrams`/`ngramOverlap` from `src/guard/deterministic.ts`.
- Tasks 21–25 consume `dial.instrumentState(name)` to gate their behaviour. DI pattern: deps object with `{ dial, ledger, now }` + separate UI prompter seam passed to the method (see `claimFirst.ts`).
- Friction module event types: `paste_quarantine`/`paste_claim` (B), `claim_captured` (C). Claim-first gate runs after consent but before coaching in `handleCoachSelection`.

## Open Risks

- Integration tests need a display: on headless Linux run `xvfb-run -a npm run test:integration`.

## Handoffs

- Task 07 (`src/ledger/*`): `chainHash(entry)` takes entry without `hash` field. `canonicalize` is the only stringifier. Checkpoints: `sign`/`verify` with PEM keys.
- Task 09 (`src/providers/*`): `coach()`/`judge()` return `ProviderResult<T>`. Factory `createProvider(settings, apiKey, client?)`.
- Task 10+11 (`src/guard/*`): `RefusalGuard.screen(out, doc)` → `Promise<GuardResult>`. Without provider, only deterministic layers run.
