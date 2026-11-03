# Session discipline: how to run development

This document defines the session protocol: where a session starts and ends, its
context budget, when to delegate, how to treat tool output, and what survives the
session. It complements `context-efficiency.md` (the instruction-file budget) and
`root-runbook.md` (the audit loop): those cover artifacts and verdicts, this one
covers keeping context small and decisions pinned.

## Why it matters

- Context is a consumable resource, not the project's memory. As input grows,
  quality degrades even on simple tasks (context rot); "it fits the window" does
  not mean "the model uses it".
- Compaction is a lossy summary. After it the agent remembers a paraphrase of
  decisions, not the decisions; a second compaction paraphrases a paraphrase.
- A measured long session: 13 253 turns, 19 compactions, the median prompt grew
  from 314k to 780k tokens. Almost all of that is re-sending history, not work.

The protocol keeps the working state small and the decisions in files that
outlive the session.

## 1. A session is one slice

A session is one slice with a measurable DoD, not the whole project.

| Rule | Value |
| --- | --- |
| Estimated prompt budget | ≤ 150k tokens |
| Compactions per slice | ≤ 1 |
| Stop signal | the first compaction |
| Required output | handoff + commit |

- At the first sign of approaching the budget, close the slice instead of pushing
  on: handoff, commit, new session.
- After the first compaction the slice always closes: the summary has already lost
  details and further work runs on a paraphrase.
- Cut work by waves, gates or fix batches; a phase change (plan → implementation →
  acceptance) always starts a new session.

## 2. Role separation

- Investigation and verification ("find", "understand", "reproduce") go to
  subagents: they get a clean context and return 1–2k tokens of findings instead
  of a dump.
- Implementation goes to one writer per workspace: related decisions must be made
  in one context (otherwise parallel agents diverge in style and contracts).
- Decisions, consolidation and acceptance belong to the root orchestrator.
- The audit loop is unchanged: re-audit resumes the same sessions; short audit
  sessions do not threaten the budget.

Rule of thumb: delegate **investigation** broadly, **implementation** narrowly,
keep **integration** centralized.

## 3. Tool batching

Every turn re-sends the whole prompt. One tool per turn multiplies the budget by
the number of small steps.

- ≥ 3 independent commands per turn, or one script instead of five to ten calls.
- Move long WSL commands into a wrapper script: a 250-character line in every turn
  costs more than a file read once.
- For file reads use `read` with `limit`/`offset`, not a full `cat`.
- Target metric: ≥ 2 tools per turn.

## 4. Tool output

- Anything over 20k chars goes to a file; context gets the head (4k) and the path.
  The guard does this automatically for `shell`, `bash`, `webfetch`.
- Screenshots and binary attachments are files plus a path, never base64 in
  context.
- `execute` (Code Mode) is not capped by the guard: limit the result in the script
  itself — return a summary and a path, not hundreds of kilobytes of raw JSON.
- `read`, `write`, `edit` and the kit's own tools are not capped: they have their
  own contract, and losing content breaks the work.

## 5. State in files

- `handoff` — the required output of a slice (template below).
- `decisions` — decisions and reasons; one decision per entry.
- `state` — branch, gates, open risks, the next three steps; refreshed before a
  new session.
- A new session starts from `state` and the target SPEC section, not from a
  retelling of the previous session.

## 6. Models

- Default to the cheap model; the expensive one only for architecture decisions,
  reviews and dispute resolution.
- Document edits, reading and mechanical checks do not need an expensive model.
- Measurement: 223 turns of the expensive model cost $63, 104 turns of the cheap
  one cost $0.09. One model switch saves more than any prompt tweak.

## 7. Metrics

| Metric | Target | Where |
| --- | --- | --- |
| Estimated prompt (median) | ≤ 150k | `orch_uni_session_stats` |
| Compactions per slice | ≤ 1 | `orch_uni_session_stats` |
| Tools per turn | ≥ 2 | `orch_uni_session_stats` |
| Outputs over 20k chars | < 5% | `orch_uni_session_stats` |
| Handoff at slice end | present | working tree |

`orch_uni_session_stats` reports the counters of the current plugin instance and
the configured limits; historical runs are counted from the session database on
the project side.

## 8. Guard

The guard is three plugin hooks, not a set of bans:

- `session.context` — estimates the prompt and adds one short reminder when it
  crosses a budget level; the text is stable within a level, so the prefix cache
  is not broken on every turn.
- `session.compaction` — counts compactions; the next request carries a reminder
  that the summary is lossy and decisions must be pinned to a file.
- `tool.execute.after` — caps the output of the configured tools and stores the
  full text in a temp directory.

Configuration (defaults):

```jsonc
{
  "sessionGuard": {
    "enabled": true,
    "promptTokensSoft": 150000,
    "maxCompactions": 1
  },
  "toolOutputGuard": {
    "enabled": true,
    "maxChars": 20000,
    "headChars": 4000,
    "tools": ["shell", "bash", "webfetch"]
  }
}
```

The guard is fail-open: a hook error neither breaks the request nor corrupts the
tool result. It writes nothing to the working tree and blocks nothing — it only
reminds and caps output. Either part can be disabled with its `enabled` flag.

## Handoff template

```md
# Handoff: <slice> — <YYYY-MM-DD>

## Goal and DoD
One sentence of the goal and a verifiable definition of done.

## Done
- What changed; what proves it (command, test, commit).

## Not done
- What remains and why (blocker, owner decision, next wave).

## Decisions
- Decision — reason; link to the document or commit.

## Risks and limits
- Accepted risk — by whom and until when.

## Next step
One concrete action for the next session.
```

## Slice checklist

- [ ] The slice is closed by DoD, not by "ran out of time".
- [ ] The handoff is written and references evidence.
- [ ] Decisions and risks are in files, not only in chat.
- [ ] The working tree is clean or explicitly described in the handoff.
- [ ] The next session starts from `state` and SPEC, not from a retelling.
