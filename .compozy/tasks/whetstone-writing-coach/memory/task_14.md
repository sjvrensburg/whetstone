# Task Memory: task_14.md

Keep only task-local execution context here. Do not duplicate facts that are obvious from the repository, task file, PRD documents, or git history.

## Objective Snapshot

Implement the optional ~3-field writing brief (F5) via multi-step QuickInput, persisted per workspace to `brief.json`, fully skippable, editable anytime, with read access for coaching.

## Important Decisions

- **DI seams (no vscode import):** `BriefPrompter` (UI) and `BriefStore` (persistence) are injected interfaces — same pattern as `ConsentGate` (task 13). The module imports only `../shared/types` and Node.js `fs`/`path`.
- **Cancel vs skip distinction:** `undefined` from prompter = user pressed Escape (cancel entire flow, nothing persisted); `''` = user pressed Enter on empty (skip field). An all-skipped brief IS persisted (valid empty brief).
- **`CaptureResult` ok-union:** Consistent with `ProviderResult<T>`, `GuardResult`, `ConsentResult` — callers must unwrap.
- **Defensive load validation:** `isValidBrief()` rejects malformed `brief.json` (wrong types, missing `updatedAt`). Returns `undefined` gracefully.
- **File store is synchronous I/O wrapped in async:** Matches `LedgerStore` pattern — the async interface is for consistency and future extensibility.

## Learnings

- No vscode stub changes needed: DI seams mean the brief module never touches the `vscode` module alias.
- The `vi.fn()` closure captures variables from the outer function scope correctly when declared as `const saved: Brief[] = []` (not a property on the return object referenced from inside the mock).

## Files / Surfaces

- `src/brief/index.ts` — new: BriefPrompter, BriefStore, BriefInputStep (DI seams); BriefFileStore (file persistence); BriefCapture (capture flow + read access); createBriefCapture (factory)
- `test/unit/brief.test.ts` — new: 26 unit tests (BriefCapture.capture/read, BriefFileStore, createBriefCapture, capture+file-store round-trip)
- `src/test/suite/brief.test.ts` — new: 3 integration tests (capture+persist, edit re-capture, skip-all-fields)
- `vitest.config.ts` — modified: added `src/brief/index.ts` to coverage.include

## Errors / Corrections

- Initial memoryStore stub had `_loads` variable referenced inside `vi.fn()` closure that was declared as an object property instead of a closure variable — fixed by using `const saved: Brief[] = []` pattern.

## Ready for Next Run

- Task 17 (UI) needs to: wire a real `BriefPrompter` (wrapping `vscode.window.showInputBox()`), create a `BriefFileStore` at the workspace storage path, register a brief edit command, and place `BriefCapture` in the container's `brief` slot.
- Task 12 already accepts `brief?: Brief` in `CoachingTurnInput` — task 17 reads `capture.read()` and passes it through.
