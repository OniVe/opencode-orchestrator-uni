# Instruction: a test run of the audit loop in another session (on another project)

The loop: read-only subagents `factcheck`, `empiric`, `invariant`, `arbiter`, `meta`, `redteam` + the writing `fix-runner` (fixes per the "to close" list).
The agents are universal (without project specifics). Definitions: your harness's global agents directory (the path depends on the OS) and the harness's project agents directory. A backup copy — in the kit directory (`agents/`).

## How to use

1. Open a session in the target project's directory — or choose the primary agent `orchestrator` (its audit loop is a built-in mode; you only need to specify the project/change/data/budget).
2. Copy the prompt below into it and fill in the placeholders:
   - `<PROJECT_PATH>` — the path to the project;
   - `<CHANGE>` — a branch / a commit range / an uncommitted diff;
   - `<BASE>` — the comparison base;
   - `<DATA>` — the available corpora/test stands/reference materials (paths) and what is allowed to run;
   - `<BUDGET>` — the time/build limits and prohibitions;
   - `<MODE>` — `commit` (the light loop) or `release` (the gates with the red team).

## The prompt for the root agent (copy in full)

---
You are the root orchestrator of the audit. Drive the audit loop to full ready.

Project: <PROJECT_PATH>
Change: <CHANGE>
Comparison base: <BASE>
Available data and test stands: <DATA>
Budget: <BUDGET>
Mode: <MODE>

The loop's rules:
- The auditors are read-only subagents; you make the fixes (micro-fixes) or delegate them to `fix-runner` (medium/large ones). You are the orchestrator: the brief, the launch, the consolidation of the reports, decisions, fixes. You do not audit yourself. Several `fix-runner` instances — only in separate worktrees with non-overlapping lists and consolidation afterwards.
- Communication — via the brief file and SGR reports. Do NOT poll background subagents: the notifications arrive on their own.
- The loop lives until FULL ready: all roles ready, no open MAJORs, MINOR/NIT closed or explicitly accepted.
- Disputed matters are resolved by `arbiter` (disputed items only); the unprovable → the owner's decision: the root frames the question, records the risk and escalates.
- "Owner" = the user. Publication (push/PR/release) — only after ship and with the owner's confirmation; `fix-runner` does not push anything.

Steps:
0) Prepare the working directory `audit-<id>` in your environment's temporary area: the brief `case.md` (the template below), the registry `risks.md`.
   For the initial audit — a "blind" copy of the state (without the history of fixes); for a repeat one — with the fixes delta.
1) Fact-check (foreground):
   subagent(agent="factcheck", prompt="Read the brief <path>. Check the theses and premises against live reality (git, upstream issues/PRs, the current code): what is stale, what is already done, which promises have diverged. Return the SGR + the "FACT-CHECK" block.")
   If verdict=stale/already_done — stop the loop and revise the task.
2) The pair in parallel (background, one block):
   subagent(agent="empiric",   background=true, prompt="Brief <path>. FACT-CHECK:\n<block>. Do your role; return the SGR.")
   subagent(agent="invariant", background=true, prompt="Brief <path>. FACT-CHECK:\n<block>. Do your role; return the SGR.")
   Save both sessionIDs from the responses.
3) Summary: parse the SGRs (verdicts, open MAJORs, conflicts by location/class); materialize the summary `reports/summary-<id>.md` (for every MAJOR — id, verifier_role, verdict, evidence; the refuted list; accepted risks; the state revision).
4) Verification of MAJORs (cross-verification, fail-closed): every MAJOR finding is confirmed by the session of the opposite role (not by the author of the finding) —
   subagent(agent="<sibling>", sessionID="<session of the opposite role>", prompt="A counterpart's finding <id>: <text>. The author's evidence: <command→output>. State revision: <directory hash/commit>. Confirm or refute it by reproducing it yourself; the default is not confirmed. Return: {id, verifier_role, verdict: confirmed|refuted|partial|unavailable, evidence}.")
   partial/unavailable = "not confirmed"; a verifier failure/timeout — the same + noise. The refuted ones — into the refuted list; write the statuses into the summary `reports/summary-<id>.md`; an unconfirmed MAJOR does not go into fixes.
   Conflicts → subagent(agent="arbiter", prompt="Disputed items: <item → evidence A → evidence B>. For each: confirmed/refuted/undecidable + the prism (reproducibility|contract|falsification|not_applicable; for several — an array) + the method of checking. Only these items.")
   The summary's verdict (and the verification/arbitration) is recorded BEFORE the fixes and together with the state revision (hash/commit); a fix after the verdict is recorded → a repeat run (re-audit) or an explicit downgrade of the verdict: do not fix before the verdict.
5) Fixes by threshold: micro-fixes — yourself; medium/large ones — subagent(agent="fix-runner", prompt="To close: <id | location | mechanism | class/area (paths + a search rule for similar places) | repro (before) | acceptance criterion (after)>. Boundaries: <…>; budget/limit: <time, number of fixes>; commit fix-<round>. Return fix-runner/v1."). Before the re-audit check the delta (git show --stat + a key run); update risks.md (closed / accepted-risk with a reason).
6) Re-audit — resuming the SAME sessions (background, one block):
   subagent(agent="empiric",   sessionID="<emp>", background=true, prompt="Fixes: <range + the actual list of changed files>; closed: <…>. Check the closure of your findings and the absence of regressions on the new state; return the updated SGR.")
   subagent(agent="invariant", sessionID="<inv>", background=true, prompt="… same …")
7) Repeat steps 3–6 until full ready is reached (the number of rounds is unlimited). From round 3 on, unresolved items — the arbiter one by one; recurring false ones — dismiss and record in the audit noise.
8) Release mode (the gates; order: red team → meta): freeze the candidate →
   subagent(agent="redteam", background=true, prompt="Brief <path>. The author's submission: <…>. The summary of previous rounds: <…>. Falsification mandate: reproduce every claim with your own instruments; available data: <…>; generate crafted inputs. Return the SGR.")
   → the same loop (fixes; the red team's MAJOR findings — with verification by the session of the opposite role as directed by the root; a dispute → `arbiter`) with the red team resumed until it is ready → subagent(agent="meta", prompt="Reports: <paths>; summary: <path to summary-<id>.md>. Check the MAJOR verification statuses in the summary (verdict + verifier_role); the evidence of every finding; the completeness of the self-checks, the absence of "green tests = checked". Return pass/fail.") → a check of the SHIP condition (below); ship only when it holds.
   SHIP ⟺ meta.gate=pass ∧ closing_list is empty/closed ∧ coverage_gaps accepted by the owner (a record in risks.md). In all other cases ship is forbidden.
9) Final: a round-by-round summary (the verdicts, what was closed, the accepted risks); save the reports in `reports/` of the audit's working directory.

Brief template `case.md`:
# Audit <id>: <name>
State: <path, commit/range; the base>
Context: <the goal of the change, what the author declares>
Materials: <diff/paths; what is ABSENT: e.g., git history unavailable>
Available data and budget: <corpora/reference materials/test stands (paths); whether a build is allowed (an isolated target in a temporary directory); the time limit; what is forbidden>
Constraints: read-only; experiments in a temporary directory; do not publish
Report contract: SGR (a summary + ```json per the role's schema)

If a subagent is unavailable ("Agent not found"): check the agent files in your harness's global agents directory (the path depends on the OS) and in the harness's project agents directory; restore from the backup copy in the kit directory (`agents/`).
---

## What counts as the test's success

- The fact-check ran and either dismissed the stale task or gave a block for the pair.
- The pair produced SGR reports; the conflicts (if any) were resolved by the arbiter.
- The loop reached full ready (all verdicts ready; no open MAJORs).
- `reports\` holds all the reports and the summary `summary-<id>.md`; `risks.md` holds the accepted risks.
- No agent changed the project (check the target project's `git status`).
