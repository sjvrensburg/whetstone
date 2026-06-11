# Whetstone Writing Coach — Task List

## Tasks

| # | Title | Status | Complexity | Dependencies |
|---|-------|--------|------------|--------------|
| 01 | Extension scaffold, build/test tooling & headless harness | completed | high | — |
| 02 | Shared domain types & structured-output JSON schema | completed | low | task_01 |
| 03 | Canonical JSON, SHA-256 hashing & Ed25519 signing primitives | completed | medium | task_01 |
| 04 | Configuration & SecretStorage access | completed | low | task_01 |
| 05 | Grammar engine — harper.js lint + LaTeX masking + diagnostics | completed | high | task_01, task_02 |
| 06 | Grammar UX — hover, dismiss quick-fix & persistent dismissals | completed | medium | task_05 |
| 07 | Provenance ledger — hash chain, signed checkpoints & verify | completed | high | task_02, task_03, task_04 |
| 08 | External-text-insertion detector | completed | medium | task_07 |
| 09 | CoachingProvider interface + ZAI/GLM (OpenAI-compatible) reference impl | completed | high | task_02, task_04 |
| 10 | Refusal guard — deterministic layer + screen() boundary | completed | high | task_02 |
| 11 | Refusal guard — cloud-judge integration | completed | medium | task_09, task_10 |
| 12 | Coaching orchestration — request build + turn pipeline | completed | high | task_07, task_09, task_11 |
| 13 | Just-in-time cloud consent gate + key setup | completed | medium | task_04, task_07, task_09 |
| 14 | Writing brief capture (QuickInput) + persistence | completed | medium | task_02 |
| 15 | "Explain this rule in my own words" action | pending | medium | task_05, task_09, task_13 |
| 16 | Transparency report & ICMJE disclosure export | pending | high | task_07 |
| 17 | Native sidebar UI — coaching & ledger TreeViews + commands | pending | high | task_07, task_12, task_13, task_14 |
| 18 | Opt-out telemetry instrumentation | pending | medium | task_07, task_12, task_17 |
| 19 | Red-team release gate — corpus, CI wiring & per-provider validation | pending | high | task_11, task_18 |
