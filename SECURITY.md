# Security Policy

## Threat model and stance

Whetstone's product claim is **friction, not proof**: it adds deliberate
friction to the writing process and can produce an honest, self-reported
disclosure of how a piece was written. It **does not** verify authorship or
personhood, and no artifact it produces may imply that it does.

The security-relevant components are:

- **The coach guard** (`src/core/guard.rs`) — a deterministic screen every coach
  reply passes before it reaches the UI (length cap, rewrite/dictation patterns,
  n-gram overlap with the draft, forbidden labels). This is **load-bearing and
  always runs**. The structured-coaching path is ghostwrite-proof by schema; the
  free-text chat path has a small residual risk by design (the doc comment on
  `screen_chat_reply` states this explicitly).
- **The optional LLM judge** (`src/coach/judge.rs`) — defence-in-depth on top of
  the deterministic guard. It can only *withhold* a reply, never rewrite one. It
  fails open if unreachable, and the fail-open is recorded as an auditable
  `JudgeUnavailable` process event in the disclosure.
- **The injection screen** (`screen_injection`) — a best-effort regex blocklist
  run on the draft, the writer's message, and each prior chat turn on replay,
  **before** egress. It is ASCII/English-only and has trivial bypasses by
  design (homoglyphs, synonyms, non-English) — it is defence-in-depth, not a
  guarantee. The reply guard is the real backstop.
- **The forbidden-label guard** (`src/core/labels.rs`) — every user-facing
  artifact (coach reply, disclosure export, HTML/text export) must clear it;
  nothing may carry proof-of-personhood language.

## Reporting a vulnerability

**If you find a way to bypass any of the above guards**, or to make the
disclosure misrepresent how a piece was written, please report it privately
rather than opening a public issue:

- Email: **sjvrensburg** at the github-user domain (see the GitHub profile), with
  subject line starting `Whetstone guard bypass:`.
- Include: which guard, the input that bypasses it, and what you expected vs.
  what happened.

Please give a reasonable window (aim for 90 days) before public disclosure so a
fix can ship. A bypass of the *best-effort* injection screen alone (homoglyphs,
non-English phrasing) is a known design limitation rather than a vulnerability —
feel free to open a public issue for those — but a chat reply that hands the
writer usable prose past the deterministic guard is a real issue worth a private
report.

## Out of scope

- Bypasses of the injection regex blocklist via Unicode/synonyms/non-English
  (known, documented, defence-in-depth — the reply guard is the backstop).
- The tool not *proving* authorship — that is the product stance, not a flaw.
- Provider-side (OpenAI/Anthropic/Ollama) misbehavior; report those to the
  provider. Whetstone screens whatever comes back.
