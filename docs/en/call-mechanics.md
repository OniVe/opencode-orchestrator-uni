# Complete call mechanics (root → subagents)

## 1. Agent inventory

| Agent | Status | Role | Input | Output |
|---|---|---|---|---|
| `factcheck` | present | freshness/fidelity | brief | SGR (factcheck/v1) + the "FACT-CHECK" block (≤15 lines) |
| `empiric` | present | real runs, measurements, differentials | brief + fact-check | SGR (empiric/v1) |
| `invariant` | present | invariants/contracts/lifecycle | brief + fact-check | SGR (invariant/v1) |
| `arbiter` | present | resolving disputed items | only contradictions + evidence | SGR (arbiter/v1): confirmed/refuted/undecidable + prism |
| `meta` | present | meta-audit of reports | the pair's reports + the red-team report (at the gates) + the summary `summary-<id>.md` | SGR (meta/v1): gate / closing_list / coverage_gaps |
| `redteam` | present | acceptance run (the gates) | brief + submission + summary | SGR (redteam/v1) |
| `fix-runner` | present | fixes per the "to close" list (the only writing subagent) | findings list + criteria | SGR (fix-runner/v1) |
| `orchestrator` | present | universal root orchestrator (`mode: primary`) | goal/task | a finished result (the audit is a built-in mode) |

All agents except `orchestrator` are `mode: subagent`, with `shell` allowed (the `shell allow` rule in `permissions`), and universal (no project specifics). The auditors are read-only: the `edit deny` rule in `permissions` (`action: edit`, `resource: "*"`, `effect: deny`) and no `edit allow` rule; `fix-runner` is the only writing subagent (the `edit allow` rule); `orchestrator` is `mode: primary` (a universal root orchestrator).

Note (K6). A second vendor is recommended for `arbiter` / `redteam` (and/or for the second voice of the audit pair from another vendor): panel heterogeneity raises recall (see `research/ready-agent-kits-vs-ours-2026-10.md`). Until a model is chosen, deepseek is the default. Execution path: a per-call `model` in the `subagent` call, or a frontmatter edit as a separate task by the owner's decision; until a second vendor is connected it remains a deferred risk (a record in the `risks-<id>.md` registry).

## 2. Call forms

`subagent({agent, prompt, background?, sessionID?, model?})`

- **foreground** — short, dependent steps (fact-check, arbiter, meta).
- **background** — long ones (the pair, the red team); two calls in one block = a parallel launch.
- **sessionID** — only for resume (re-audit and verification continue the same role's session); a call without a saved sessionID = a step defect (a new session instead of a continuation).
- **model** — only by the owner's decision (a per-call vendor change; see note K6 in §1): panel heterogeneity is a deliberate choice, not a default.

## 3. Phases

Numbering: "Phase N" denotes the phases of this document (`call-mechanics.md`); "[N]" denotes the loop steps from `process-ready-loop.md`. Cross-document references name their namespace explicitly.

### Phase 0. Preparation (root, no calls)
Creates state X0 (a blind sandbox for the initial audit; with the delta — for a repeat audit), writes `case-<id>.md`, opens `risks-<id>.md`.

Brief template:
```
# Audit <id>: <name>
State: <path, commit/range; the comparison baseline>
Context: <the goal of the change, what the author claims>
Materials: <diff/paths; what is ABSENT: e.g., git history unavailable>
Available data and budget: <corpora/reference materials/test stands (paths); whether a build is allowed
  (an isolated target in a temporary directory); a time limit; what is forbidden>
Constraints: read-only; experiments in a temporary directory; do not publish
Report contract: SGR (a summary + ```json per the role's schema)
```

### Phase 1. Fact-check (1 foreground call)
```
subagent({
  agent: "factcheck",
  prompt: "Read the brief <case>. Check its theses and premises against live reality
   (git, upstream issues/PRs, the current code): what is stale, what is already done,
   which promises/docs have diverged. Return the SGR + the "FACT-CHECK" block (≤15 lines)
   to pass to the auditors."
})
```
The root's decision: "stale/already done" → **STOP**, revise the task. Otherwise, extract the block.

### Phase 2. The pair (2 background calls in one block)
```
subagent({agent:"empiric",  background:true,
  prompt:"Brief <case>. FACT-CHECK:\n<block>. Carry out your role; return the SGR."})
subagent({agent:"invariant", background:true, prompt:"… same …"})
```
The root saves the sessionIDs from both responses and **waits for notifications** (does not poll).

### Phase 3. Summary (root, no calls)
- Parses the JSON blocks: verdicts, open MAJOR findings, the completeness of self_check/lines.
- A conflict = a contradiction on one place/class or a mismatch of verdicts on an item.
- An invalid report: an empty/broken/unparseable report or a verdict outside the enum → a step defect: resume the same session and demand that the SGR be reissued; a repeated failure → escalation to the owner.
- Produces the **summary artifact** `reports/summary-<id>.md` (definition: §4): for every MAJOR — `{id, verifier_role, verdict, evidence}`; an explicit refuted list; accepted risks; the state revision.
- Branching: both ready and MAJOR=0 → release gates: **Phase 8 (red team) → Phase 6 (meta)**; a commit/PR → Phase 7; otherwise → Phase 3.5 (MAJOR verification) → Phases 4/5.

### Phase 3.5. Verification of MAJOR findings (cross-verification)
Every MAJOR finding goes through an independent check in **the opposite role's session** (a sibling auditor, not the author of the finding; the standard pair is `empiric` ↔ `invariant`) — by resuming that session:
```
subagent({agent:"<sibling>", sessionID:<session>,
  prompt:"A counterpart's finding <id>: <text>. The author's evidence: <command→output>.
   State revision: <directory hash/commit>. Confirm or refute it by reproducing
   it yourself; the default is not confirmed. Return: verdict + evidence."})
```
The verifier's response schema (mandatory):
```
{"id": "<finding id>", "verifier_role": "<verifier role>",
 "verdict": "confirmed|refuted|partial|unavailable", "evidence": "<command → raw result>"}
```
Rules:
- `verifier_role` ≠ the role of the finding's author — the verifier is not the one who found it.
- `partial` and `unavailable` are treated as **"not confirmed"** — the finding does not go into fixes.
- A verifier failure/timeout → "not confirmed" (`unavailable`) + a record in the audit noise (see §5).
- Fail-closed: without an explicit confirmation by one's own reproduction the finding is considered **not confirmed**. A dispute → Phase 4 (arbiter). The refuted ones (`refuted`) are collected into the summary's refuted list and go into the audit noise.
- The state revision is recorded together with the verdict: the verification is valid only for the revision on which it was performed (see §7).
- The verification statuses (`verifier_role` + `verdict` + evidence) are appended to the summary `reports/summary-<id>.md`.
- Mutual reproduction: if a MAJOR finding is independently reproduced by both roles in their own runs (their own commands, one state revision) — this counts as cross-verification; a separate verifier run is not required, both sides are recorded in the summary (`verifier_role` of each role + evidence).

### Phase 4. Arbiter (conditional; only on conflicts)
```
subagent({
  agent: "arbiter",
  prompt: "Disputed items:
   1) <item> — evidence A: <command→output>; evidence B: <command→output>.
   For each: confirmed/refuted/undecidable + the method of checking +
   the prism (reproducibility|contract|falsification|not_applicable;
   for several — an array of prisms). Check nothing beyond this."
})
```
Outcome: confirmed → a fix; refuted → dismiss it + a record in the audit noise; undecidable → the owner's decision: the root frames the question, records the risk (`risks-<id>.md`) and escalates.

### Phase 5. Fixes and repeat
- Fixes start only after the summary's verdict is recorded (and verification/arbitration has been done). Do not fix before the verdict.
- Fixes by threshold: micro-fixes (1–3 lines, texts/docs) — the root itself; medium/large ones (multi-file, logic, tests) — the `fix-runner` subagent; a disputed matter is decided by the root before delegation (after the arbiter).
- Several `fix-runner` instances in parallel — only in separate workspaces: each with its own git worktree and branch (`worktree_create`, otherwise `git worktree add`), with non-overlapping "to close" lists; when they finish, the root consolidates the branches/diffs into the main branch (resolving intersections and conflicts) and runs the checks on the consolidated state. Two fixers in one workspace or on the same files — forbidden.
- Calling the fix-runner:
```
subagent({agent:"fix-runner", prompt:"To close:\n1) <id | location | mechanism |
 class/area (paths + a search rule for similar places) | repro command (before) |
 acceptance criterion (after) | severity>\nBoundaries: <paths/branch>; budget/limit: <time, number of
 fixes>; commit: <yes/no, message fix-<round>>. Return fix-runner/v1."})
```
- The root checks the delta (`git show --stat` + a key run) before the re-audit and updates the registry.
- The round's test stand (if the kit ships a verification stand — the tools `tools/kit-verify` (the verifier) and `tools/kit-sync` (sync of copies + a snapshot) in the kit directory; in rounds on other projects — only if the stand is explicitly included in the call boundaries): baseline → fixes → sync of copies and a repeat run of the stand; the baseline→after delta is attached to the report (the `stand` field).
- **re-audit = resuming the same sessions**:
```
subagent({agent:"empiric", sessionID:<emp>, background:true,
  prompt:"Fixes: <range/commits + the actual list of changed files>; closed: <…>. Check the closure of your
   findings and that there are no regressions on the new state; return the updated SGR."})
subagent({agent:"invariant", sessionID:<inv>, background:true, prompt:"… same …"})
```
- → Phase 3. From round 3 on, unresolved items — the arbiter one by one; recurring false findings — close as noise.

### Phase 6. Meta-audit (mandatory at the release gates = publication of a release/tag)
```
subagent({
  agent: "meta",
  prompt: "Reports: <paths>; summary: <path to summary-<id>.md>. Check the MAJOR
   verification statuses in the summary (verdict + verifier_role); the evidence of every
   finding; the completeness of
   lines/items; whether there is any "green tests = checked". Return pass/fail
   per report and the list of non-conformities."
})
```
`meta` → fail: ship is forbidden; a targeted list of non-conformities → fixes/rebuild of the reports → a repeat of the meta-audit; a repeated fail → escalation to the owner. The meta's verdict carries the only blocking aggregate `gate` (pass|fail; `verdict` is a synonym of `gate`); additionally `closing_list` (ids of red-team findings mandatory for closure) and `coverage_gaps` — what could not be checked. `gate`=pass requires "`closing_list` is empty/closed"; `coverage_gaps` can only be accepted by the owner, with a record in `risks-<id>.md`.

### Phase 7. Light exit (commit/PR)
Condition: all roles ready, MAJOR=0, the risks accepted, **no fixes after the verdict** (otherwise, a repeat run or an explicit downgrade of the verdict, see §7). The PR carries the line "audit loop: N rounds; verdicts ready; accepted risks: …".

### Phase 8. Gates (release)
- Freeze candidate Xn.
```
subagent({agent:"redteam", background:true,
  prompt:"Brief <case>. The author's submission: <…>. The summary of previous rounds: <…>.
   Falsification mandate: reproduce every claim with your own instruments;
   available data: <corpora/test stands>; generate crafted inputs. Return the SGR."})
```
- not_ready → a repeat of Phases 3.5–5 (MAJOR verification + fixes, with the red team resumed); then Phase 6 (`meta`, see above; without duplicating the rules). The gate verdict carries `closing_list` (ids of findings that must be closed for a pass) and `coverage_gaps` (what could not be checked/attacked).
- The red team's MAJOR findings go through the same verification (Phase 3.5): the verifier is the session of the opposite role, as directed by the root; a dispute → the arbiter (Phase 4).
- **Ship condition (the same for all documents):** SHIP ⟺ `meta.gate`=pass ∧ `closing_list` is empty/closed ∧ `coverage_gaps` accepted by the owner (a record in `risks-<id>.md`); otherwise ship is forbidden.

## 4. Data transfer

| From → To | What | Format |
|---|---|---|
| root → everyone | the brief `case-<id>.md` (one for all) | file |
| factcheck → the pair | "FACT-CHECK" ≤15 lines | a block in the prompt |
| the pair → root | full SGR reports | JSON blocks |
| root → the arbiter | only disputed items + evidence from both sides | list |
| root → the verifier | a MAJOR finding (id, text, the author's evidence, the state revision) | text |
| root → fix-runner | the "to close" list (id, location, class/area, repro command (before), acceptance criterion (after), severity) + boundaries/budget | text |
| root → re-audit | the fixes delta + the actual list of changed files + the list of what was closed | text |
| root → redteam | the submission + the summary of all rounds | text |
| redteam → root | SGR | JSON |
| root → meta | reports (paths) + the summary `reports/summary-<id>.md` | file |
| meta → root | SGR (meta/v1) | JSON |

### The summary artifact `summary-<id>.md` (in `reports/`)

The materialized summary of a round — the input to Phase 6 (`meta`) and the anchor tying the verdict to the state. Composition:
- for every MAJOR — `{id, verifier_role, verdict, evidence}`;
- the refuted list — an explicit section, even if empty (`verifications: —`);
- accepted risks (id/gist + a reference to `risks-<id>.md`);
- the state revision (directory hash/commit) on which the verdicts and the verification were recorded.

Writers: Phase 3 creates/updates it; Phase 3.5 appends the verification statuses; Phase 5 records the closed/accepted items; the state revision is recorded together with every verdict.

Persistence (all kit documents): the SGR reports of all roles, including **the SGR reports of `fix-runner`**, and the summary `summary-<id>.md` are kept in `reports/` (next to `case-<id>.md` and `risks-<id>.md`); the reports are the machine-readable input to the following phases (meta, the verifier), not just text in the chat.

### The `orch_uni_*` tools (if registered by the plugin)

- the state revision → `orch_uni_snapshot` (aggregate = the directory hash): recorded together with the verdict and the verification;
- a role's report → `orch_uni_validate_report` (path or text): `valid=false` → a step defect, resume the same session and demand that the SGR be reissued; do not ignore `warnings`;
- the roles' sessionIDs, their model and cost → `orch_uni_sessions`;
- if the tools are unavailable, work manually, as before.

## 5. Failures and recovery

- A subagent crashed/was interrupted → resume with "continue from where you stopped, do not redo"; on `Agent not found` — check the agent files. Do not mix the sources: the agent definitions are in the kit directory (`agents/`); the copies are in your harness's global agents directory (the path depends on the OS) and the harness's project agents directory; configuration snapshot/restore is `tools/config-guard` (the kit's configuration guard, if shipped), not the agents.
- The model/provider is unavailable → wait/switch the model by the owner's decision, keep the sessions.
- A restricted environment (Code Mode: actions only via `execute`+directory, `subagent` unavailable) → the audit loop does not start; the outcome is "done; the regular audit is deferred" with the revision and the run plan (§8).
- The `arbiter` is unavailable or its budget is exhausted → the root examines the disputed item one by one on facts/quotes and records it as a risk and escalates to the owner.
- The MAJOR verifier (Phase 3.5) failed or timed out → the finding is considered **not confirmed** (`unavailable`), does not go into fixes, the fact is recorded in the audit noise.
- A server restart in the middle of a run → resume by sessionID.
- No polling: the notifications arrive automatically.

## 6. Budgets (a guideline)

| Step | Time |
|---|---|
| fact-check | 1–2 min |
| the pair (in parallel) | 5–10 min each |
| the arbiter | 1–3 min per item |
| MAJOR verification (Phase 3.5) | 1–3 min per finding |
| meta (Phase 6) | 1–3 min per report |
| fix-runner (Phase 5) | per the call budget (the number of fixes / time) |
| a loop round (summary+fixes+repeat) | 10–20 min |
| the red team (the gates, Phase 8) | hours |

## 7. Process invariants

- The root does not audit and does not substitute for the verdicts; at any moment there is a single writer **per workspace**: the root (micro-fixes) or `fix-runner` (medium/large ones); several `fix-runner` instances — in parallel only in separate worktrees with non-overlapping lists, with the root consolidating afterwards.
- The auditors are read-only; project specifics — only in the brief.
- Fixes start only after the summary's verdict is recorded (and MAJOR verification/arbitration has been done). Do not fix before the verdict.
- MAJOR findings go into fixes only after independent verification (Phase 3.5); the verifier's default is "not confirmed" (fail-closed).
- Disputed matters — `arbiter`; the unprovable → the owner's decision: the root frames the question, records the risk and escalates; recurring false findings — noise and closure.
- The verdict and the verification are recorded together with the state revision (directory hash/commit); any fix after the verdict is recorded → a repeat run (re-audit) or an explicit downgrade of the verdict.
- "Ready" = all findings are closed or explicitly accepted; the loop runs until full ready.

## 8. Restricted environments (Code Mode)

The session's environment can change in the course of work: direct tools are replaced by a call via `execute`+directory, the `subagent` tool disappears — the audit loop is impossible in such a session.

- Preflight: before the audit phase, check that `subagent` is available; if not — do not start the loop.
- The outcome status: "done; the regular audit is deferred". The outcome includes the state revision (commit/directory hash), compensating checks as a list (explicitly as checks), and the run plan in a normal session.
- Forbidden: passing a self-check/`ai` review off as an independent audit; marking the task as audited; writing "ready".
- Handoff: the audit is run on the recorded revision in a normal session; or the roles are launched as separate processes `opencode run --agent <role> "<brief>"` in the project directory (if the environment provides a shell — for example, AetherShell); keep the roles' sessionIDs (Phase 3.5/re-audit).
- If the environment is restored before completion — run the deferred audit and update the verdict.
