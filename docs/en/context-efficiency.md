# Token-efficient AGENTS.md and SPEC.md

An instruction file is a budget of attention, not documentation. Every line is paid for: it participates in every session's context and competes with the task. The goal is the minimum set of testable rules that cannot be inferred from the code and are needed in most sessions.

## Budget

| File | Target | Ceiling |
|---|---:|---:|
| Global `AGENTS.md` | 25–40 lines / <500 tokens | 60 lines |
| Root `AGENTS.md` | 100–200 lines / 1–2k tokens | 250 lines |
| Nested `AGENTS.md` | 20–60 lines / <700 tokens | 100 lines |
| `SPEC.md` | 80–150 lines / ≤1.5k words | 2k words |
| `ADR` | 30–60 lines / <700 tokens | 100 lines |

Selection rule: if a line is not testable, is inferable from code/linters, or is needed in fewer than half of sessions — delete it or move it to a link.

## AGENTS.md: 12 rules

1. Commands first: install, build, test, one test, lint, run; with flags and a working directory.
2. Only the non-inferable: flags, traps, layer order, prohibitions, versions.
3. One instruction per line, imperative, testable.
4. Style belongs to the linter; do not restate the README or the language standard.
5. Explicit "Never" and "Ask first": secrets, `dist/`, prod, migrations, dependencies.
6. Precedence in the text: what overrides what; on a conflict, stop and ask.
7. One source of truth: `AGENTS.md` plus a symlink/import for `CLAUDE.md`.
8. Links instead of inline copies; inline only what is needed every time.
9. Add a rule after a repeated agent mistake, not "for the future".
10. Delete dead rules: they tax every request.
11. Stable content on top, dates/branches/tasks at the bottom (prefix cache).
12. Review the file as code; update it when tooling/CI changes.

## AGENTS.md template

```md
# AGENTS.md

## Precedence
1. The user's explicit instruction in the task.
2. `SPEC.md` of the active feature.
3. The nearest `AGENTS.md`.
4. This file.
5. The global `AGENTS.md`.
On a conflict, stop and ask.

## Commands
| Task | Command | Note |
|---|---|---|
| Install | `<...>` | `<version>` |
| Build | `<...>` | `<flag>` |
| Tests | `<...>` | `<limit>` |
| One test | `<...>` | `<name>` |
| Lint/types | `<...>` | |
| Run | `<...>` | `<port>` |

## Boundaries
- `<path>/` is generated; do not edit.
- `<path>/` is vendored; do not edit.
- New files go to `<path>`.

## Conventions
- <One testable rule per line.>

## Verification
`<analyze>` → `<lint>` → `<test>`.
Done = all commands green + `<DoD>`.

## Never / ask first
- Never: secrets, `dist/`, prod, applied migrations.
- Ask first: DB schema, public API, new dependencies, CI.

## Pointers
- `SPEC.md` — the feature contract.
- `docs/adr/` — decisions.
- `docs/pitfalls.md` — traps.
```

## SPEC.md: 12 rules

1. One feature per file, 1–3 pages; larger — split via a roadmap.
2. Stable IDs (`R1`, `AC1.1`); never renumber.
3. One requirement — one observable behavior.
4. EARS or Given/When/Then — consistently; MUST/SHOULD/MAY — sparingly.
5. No HOW: stack, files, classes belong in plan/design/ADR.
6. Contracts as links, not copies.
7. Non-goals: 3–7 items.
8. Invariants separate from acceptance criteria.
9. Tables for AC and traceability; prose for context only.
10. Frontmatter: `status`, `owner`, `version`, `supersedes`; no changelog in the body.
11. At most three open questions, each with an owner and a date; `TBD` elsewhere is forbidden.
12. DoD and metrics are measurable; "faster" without a number does not count.

## SPEC.md template

```md
---
id: SPEC-000
title: <name>
status: draft
owner: "@team"
version: 1.0.0
supersedes: —
---

# SPEC-000: <name>

## 1. Context and problem
<3–5 lines: who suffers, what hurts, why now.>

## 2. Goal and non-goals
**Goal:** <one sentence>.
**Non-goals:** <3–7 items we deliberately do not do>.

## 3. Scenarios
| ID | Role | Goal | Value | Independent test |
|---|---|---|---|---|
| S1 | <...> | <...> | <...> | <...> |

## 4. Requirements (EARS)
- **R1** — WHEN <trigger>, THE SYSTEM SHALL <result>.
- **R2** — IF <condition>, THEN THE SYSTEM SHALL <...>.

## 5. Acceptance criteria
| AC | R | Given | When | Then | Test |
|---|---|---|---|---|---|
| AC1.1 | R1 | <...> | <...> | <...> | `test_...` |

## 6. Invariants and edge cases
- Invariant: <always true>.
- Empty/limit/concurrency/error: <...>.

## 7. Contracts
Links: `<openapi.yaml>`, `<schema.sql>`, `<types.ts>`.

## 8. Non-functional requirements
| Metric | Target | How we check |
|---|---|---|
| Latency p95 | <...> | <...> |

## 9. Success metrics
- **SC-1** — <number and how to check>.

## 10. Open questions
- **Q1** — <...>; owner: <...>; due <date>.

## 11. Traceability
| R | AC | Task | Test |
|---|---|---|---|
| R1 | AC1.1 | T1 | `test_...` |

## 12. Definition of Done
- [ ] AC closed.
- [ ] Tests green.
- [ ] Contracts and docs/ADR updated.
```

## Command /agents-md

1. Decide the mode: audit an existing file or draft from scratch.
2. For an audit: `orch_uni_context_lint` → `context-lint`; show the SGR and `closing_list`.
3. For a draft: collect facts and ask at most 8 questions; do not invent commands or paths.
4. Fill the template; stay within 150–200 lines.
5. Run the linter; show the diff and open questions.
6. Change the canonical file only after approval; apply fixes through `fix-runner`.

## Command /spec

1. Capture the brief and ask at most 5 clarifying questions.
2. Non-goals, priorities and metrics are owned by the owner; do not invent them.
3. Fill the template: EARS, AC with tests, invariants, traceability, DoD.
4. Run `orch_uni_context_lint` and `context-lint`; show the diff and questions.
5. Change the canonical file only after approval.

## Review

- [ ] `AGENTS.md` ≤200 lines, `SPEC.md` ≤1.5k words.
- [ ] Every line is testable.
- [ ] No duplicates with README/linter/CI.
- [ ] Precedence and boundaries are explicit.
- [ ] Every relative link exists.
- [ ] Every R has an AC, every AC has a test.
- [ ] Non-goals and DoD are present.
- [ ] A baseline on 10–20 tasks exists.

## Anti-patterns

| Anti-pattern | Why it is bad | What to do |
|---|---|---|
| Auto-generation "just in case" | −0.5…−2% success, +20–23% cost | Write manually, high-signal only |
| Restating README/architecture | Duplication, zero effect | Link to docs |
| Duplicating the linter | Tokens on what is already checked | Linter/CI |
| Generic phrases ("write clean code") | Not testable | Imperative + example |
| Conflicts between layers | The model chooses arbitrarily | Explicit precedence |
