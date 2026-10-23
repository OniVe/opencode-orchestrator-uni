# Root-runbook: initiating an audit from the primary agent

## Roles

- **Root (the primary agent)** — does not audit: forms the brief, launches subagents, consolidates the reports; for the "unprovable" — the owner's decision: the root frames the question, records the risk and escalates. Maintains the registry of accepted risks, makes fixes as separate commits, decides on "ship".
- **Subagents** (read-only): `factcheck`, `empiric`, `invariant`, `arbiter`, (at the gates) `redteam`, `meta`.

## Brief template `case-<id>.md` (common to all steps)

```
# Audit: <task/PR/release>
State: <path to the sandbox/repo, commit or range; the diff base>
Context: <what the change is, its goal, what the author declares>
Materials: <the diff file, base/head paths; what is unavailable (e.g., git history)>
Constraints: read-only; experiments in a temporary directory; a targeted build; do not publish
Report format: SGR (a summary + ```json per its own schema)
```

A "Fact-check (pre-pass): …" block is added to the pair's prompts — 5–15 lines from the fact-checker's report.

## Call checklist (order)

1. **Fact-check**: `subagent(agent="factcheck", prompt="<brief> + check the theses against live reality: git/upstream issues/PRs/code; what is stale, what is already done, which promises have diverged")`.
   - If "stale/already done" → **STOP** and revise the task (the cheapest possible saving).
2. **The pair in parallel**: `subagent(agent="empiric", background=true, prompt="<brief> + the fact-check block")` and the same for `invariant`. Do not poll — wait for notifications.
3. **Summary by the root**: parse the JSON blocks; determine the verdicts (ready/not_ready), open MAJORs, intersections and discrepancies (by location+mechanism). Materialize the summary artifact `reports/summary-<id>.md` (definition — `call-mechanics.md` §4): for every MAJOR — {id, verifier_role, verdict, evidence}; the refuted list (explicit, even if empty); accepted risks; the state revision (directory hash/commit).
4. **Verification of MAJORs (cross-verification, fail-closed)**: every MAJOR finding is confirmed independently by **the session of the opposite role** (not by the author of the finding) — `subagent(agent="<sibling>", sessionID=<session of the opposite role>, prompt="A counterpart's finding <id>: <text>. The author's evidence: <command→output>. State revision: <directory hash/commit>. Confirm or refute it by reproducing it yourself; the default is not confirmed. Return: {id, verifier_role, verdict: confirmed|refuted|partial|unavailable, evidence}.")`. `verifier_role` ≠ the author's role; `partial`/`unavailable` = "not confirmed"; `refuted` — into the refuted list for the summary; a verifier failure/timeout — "not confirmed" + noise. Not confirmed → it does not go into fixes (a dispute → step 5, the arbiter); the verification statuses are written to the summary `reports/summary-<id>.md` (step 3). If a MAJOR finding is independently reproduced by both roles in their own runs — the mutual confirmation counts as verification (both sides are recorded in the summary), a separate run is not required. The sessionID in the call is mandatory: without it this is a new session, not a continuation — a step defect.
5. **The arbiter — only on discrepancies**: `subagent(agent="arbiter", prompt="Disputed items: <item → evidence A → evidence B>. For each: confirmed/refuted/undecidable + a command/quote.")`. The summary's verdict (and the verification/arbitration) is recorded BEFORE the fixes and **together with the state revision** (directory hash/commit); any fix after the verdict is recorded → a repeat run (re-audit) or an explicit downgrade of the verdict: do not fix before the verdict.
6. **Fixes** by threshold: micro-fixes — the root itself; medium/large ones — `fix-runner` (input: the "to close" list — id, location, mechanism, **class/area** (paths + a search rule for similar places), repro (before), acceptance criterion (after), severity — plus the boundaries and the **budget/limit (time, number of fixes)**; output: fix-runner/v1 with before/after/`proof`/tests). Separate commits `fix-<round>`; update the registry: `closed` / `accepted-risk` (with a reason). The root checks the delta before the re-audit. The round's test stand (if the kit ships a verification stand — the tools `tools/kit-verify` and `tools/kit-sync` of the kit directory; in rounds on other projects — only if the stand is explicitly included in the call boundaries): the stand's baseline into the fixer's prompt (if the output is passed — the fixer does not duplicate the run); closure — sync of the copies and a repeat run of the stand; both outputs — in the report's `stand` field. `fix-runner` statuses: `needs_decision` → the root's decision (for a dispute — the arbiter; if the decision is the owner's — escalation) with a record in the risk registry; `not_closed` → another iteration with the same id; the `out_of_scope` field (noticed outside the list) → include in the next "to close" list or escalate. Several `fix-runner` instances — only in separate worktrees (each with its own branch and a non-overlapping list); afterwards the root consolidates the branches/diffs into the main branch and runs the checks on the consolidated state.
7. **Re-audit = resuming the same sessions** (the sessionID from step 2): "Fixes: <range + the actual list of changed files>. Check the closure of your findings and the absence of regressions; return the updated SGR." — historically, that is how it was done (a continuation of the GLM/DS sessions). The sessionID is mandatory: a call without it (a new session instead of a continuation) — a step defect.
8. **Repeat steps 3–7 until full ready is reached** (the number of rounds is unlimited; all roles ready, MAJOR=0). From round 3 on, unresolved items — the arbiter one by one; recurring false ones — dismiss and record in the audit noise.
9. **Gates (release; order: red team → meta)**: a frozen commit → `redteam` (the falsification mandate + corpora/test stands) → a loop over its findings (MAJORs — with verification by the session of the opposite role) → `meta` (input: the reports + the summary `reports/summary-<id>.md`; evidence, completeness, the absence of "green tests = checked").
   - **SHIP ⟺ `meta.gate`=pass ∧ `closing_list` is empty/closed ∧ `coverage_gaps` accepted by the owner (a record in `risks-<id>.md`); otherwise ship is forbidden.**
   - `meta` → fail: ship is forbidden; a targeted list of non-conformities → fixes/rebuild of the reports → another meta pass; a repeated fail → escalation to the owner. Ship — only after the meta's pass and once the ship condition above is met.

## Data transfer between nodes

- fact-check → both auditors: a short block in the prompt (5–15 lines);
- the pair → the root: SGR JSON (machine-readable; keep in `reports/`);
- the root → the arbiter: **only disputed items** + evidence from both sides;
- the root → re-audit: the fixes range + a brief "what was closed";
- the root → the red team: the author's submission + the summary of all previous rounds (the object of falsification);
- the root → meta: the reports (paths) + the summary `reports/summary-<id>.md`;
- the root → fix-runner: the "to close" list (with the class/area) + boundaries + budget/limit (time, number of fixes); for a parallel launch — a separate worktree/branch and a non-overlapping list per fixer.

## Subtleties

- The `orch_uni_*` tools (if registered by the plugin): the state revision — `orch_uni_snapshot` (aggregate), an SGR report check — `orch_uni_validate_report` (invalid → resume the session and demand that the SGR be reissued), the roles' sessionID/model/cost — `orch_uni_sessions`; otherwise — manually, as before.
- The brief and the risk registry — as files; the subagents return the reports to the chat (the `edit deny` rule in `permissions`; `shell` is allowed), the root itself saves what is needed.
- "Blind" runs — a sandbox without git history (without fix commits); re-audit — by contrast, the fixes delta is shown.
- The root's verdict does not substitute for the auditors' verdicts: until both roles are ready, the loop lives (plus the escalation rules from `process-ready-loop.md`).
- Timings are approximate: fact-check ~1–2 min, the pair ~5–10 min, the arbiter ~1–3 min per item, the red team — hours (the gates only).
- Universality: both auditors and the types being added carry no project specifics; all project specifics — in the briefs and reference materials.
- **Environment preflight (Code Mode)**: if `subagent` is unavailable — the loop does not start; the outcome is "done; the regular audit is deferred" (the revision + compensating checks + the run plan), details — `call-mechanics.md` §8.
- **A mandatory configuration snapshot after installing/updating the agents**: the configuration snapshot — `tools/config-guard` (if shipped), otherwise save a copy of the configuration manually (otherwise there will be nothing to restore from). Do not mix the sources: agent definitions — the kit directory (`agents/`), configuration — `tools/config-guard` (if shipped).
- **Snapshot coverage**: the configuration snapshot covers the **configuration** (your harness's global configuration directory: agent definitions, the main config, general instructions, etc.); the kit's docs (`docs/`, `agents/`, `README.md`) are NOT covered by the snapshot — the kit remains the source, and the run reports are kept in `reports/`. The snapshot check returns 0 when there are no divergences and 2 when problems are found.
- The configuration guard (if shipped): the default restore only adds the missing elements and does NOT overwrite existing ones; a full overwrite from the snapshot — only with explicit confirmation (`-Force` or an equivalent).
