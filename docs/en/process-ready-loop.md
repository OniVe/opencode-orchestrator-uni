# Process: the run loop to full ready

Rule: the audit is considered complete only when **all roles** have issued `verdict=ready` and all findings are processed. No "stops after N rounds": the loop runs to full ready; when it does not converge — escalation, not endless repeats on the same state.

Numbering: "[N]" — the steps of this document (`process-ready-loop.md`); "Phase N" — the phases of `call-mechanics.md`. Cross-document references name their namespace explicitly.

## Tree

```
[0] FACT-CHECKER (the freshness of premises/issues/PRs)
     │
     ├─ the task is stale/done → STOP (revise the task)
     ▼
[1] EMPIRIC ∥ INVARIANT (on state X0)
     │        └─ conflicts? → ARBITER (disputed items only); MAJOR → independent verification (cross-verification, fail-closed)
     ▼
   VERDICT: all ready and no open MAJORs?
     ├─ YES ──► for the release gates: [4] RED TEAM → [5] META
     │           (input of [5]: the pair's reports + the red team's report + the summary `reports/summary-<id>.md`)
     │           ├─ SHIP ⟺ `meta.gate`=pass ∧ closing_list is empty/closed ∧ coverage_gaps accepted by the owner (a record in risks-<id>.md)
     │           ├─ otherwise ship is forbidden; a targeted list of non-conformities → fixes/rebuild of the reports → another meta pass; a repeated fail → escalation to the owner
     │         for a commit/PR: SHIP if there were no fixes after the verdict (the red team and meta are not mandatory)
     └─ NO ─► [2] FIXES (close the MAJORs; MINOR/NIT — close or explicitly accept with a rationale, a record in risks-<id>.md)
                ▼
           [3] NEW STATE X1 (the fixes are committed/recorded)
                ▼
           repeat [1] on X1 (both auditors, the same brief)
                ▼
           … repeat [1] on Xn until all roles issue ready …

   [A VERDICT EXISTS, THE STATE CHANGED] → repeat [1] (re-audit on the new state) or an explicit downgrade of the verdict
   [COMMIT/PR] → the line "no fixes after the verdict"
```

At the release gates the loop is the same, plus after the first full ready — the red team; its findings (including MAJORs — with independent verification by the session of the opposite role) go through the same loop of fixes/re-checks until it, too, issues ready.

## The "full ready" criterion

1. All roles (the empiric, the invariant; at the gates — the red team as well) — `verdict=ready`.
2. No open MAJORs. MINOR/NIT: closed or **explicitly accepted** with a reason (a record in `risks-<id>.md`; in the summary/PR: "accepted as debt: …").
3. All discrepancies are resolved by the arbiter; the unprovable → the owner's decision: the root frames the question, records the risk and escalates.
4. The repeat run is based **on the state after the fixes**, not on the old diff. No "re-votings" on the same snapshot.
5. At the release gates — `meta` = pass (`gate`=pass), `closing_list` is empty/closed, `coverage_gaps` accepted by the owner (a record in `risks-<id>.md`). **SHIP ⟺ `meta.gate`=pass ∧ `closing_list` is empty/closed ∧ `coverage_gaps` accepted by the owner (a record in `risks-<id>.md`); otherwise ship is forbidden.**
6. MAJOR findings go into fixes only after independent verification; the verifier's default is "not confirmed" (fail-closed).
7. The verdict and the verification are recorded together with the state revision (directory hash/commit); any fix after the verdict is recorded → a repeat run (re-audit) or an explicit downgrade of the verdict.

## When the loop "does not converge" — escalation (instead of a stop)

- Round 3+ and still not_ready → the arbiter examines **the remaining items one by one**: confirmed / refuted (a false positive) / undecidable.
  - "refuted" — the finding is dismissed, recorded as a false positive of the auditor (noise data for calibration);
  - "undecidable" — the owner's decision: the root frames the question, records the risk and escalates;
  - "confirmed" — a mandatory fix, the loop continues.
- A sign of a pointless continuation: the same false/undecidable findings repeat without new facts. This is not "not ready", this is an audit defect — record it and close it.

## Loop data (per round)

- Input: the diff/state Xn + the fact-checker's report + the list of accepted risks.
- Output: two SGR reports (the empiric, the invariant) + the arbiter's resolution (if any).
- The orchestrator's summary: `ready` / `not_ready(the list of open ones)`, what was closed, what was accepted.
- At the gates, additionally: the summary `reports/summary-<id>.md` — the input of meta `[5]` (Phase 6); the gates' verdicts — the red team (`closing_list`/`coverage_gaps`) and meta (`meta.gate`/`closing_list`/`coverage_gaps`).

## Notes

- "Ready" is not "zero findings" but "all findings are processed": closed or knowingly accepted.
- The loop itself accounts for the variance of single runs: the next round gives a new sample; hence the loop to convergence, not "a single run in a cage".
- History confirms the model: PR #37 (bsl-context) — the pair issued ready with caveats, acceptance found 8 defects, after the fixes and a re-acceptance — v0.22.0 and full ready.
