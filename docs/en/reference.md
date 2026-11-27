# Reference

Deep reference for the orchestrator kit: the write guard, the five core tools
plus the `list_tools` discovery tool and the flat compatibility alias, the
session protocol, model and locale configuration, and precedence rules.

[Back to the README](../../README.md)

The kit registers on setup via `ctx.agent.transform` / `ctx.reference.transform`.
The `audit-kit` reference points at this package's per-locale `docs/<locale>/`
directory; OpenCode lists it as an additional local directory, so agents read
`<reference path>/call-mechanics.md` directly. The reference ships
`call-mechanics.md`, `process-ready-loop.md`, `root-runbook.md`,
`instruction-other-session.md`, `context-efficiency.md` and
`session-discipline.md` — for example
`<reference path>/process-ready-loop.md`.

## Write Guard

The orchestrator itself has `edit` denied on `*`. The flat `permissions` are only
a narrow fallback allowlist for audit/state artifacts, and the real guard is the
`permission.hook("evaluate")` hook in `lib/write-guard.ts` with path-root
semantics.

Auditors are read-only at the tool level for `edit`/`write`/`patch` (`edit: deny`);
the prompt forbids all other writes. A shell write (redirect, `sed -i`, `tee`) is
an accepted risk (I-M15), not a sandbox.

- The session directory is read per event (`session.get`), so a moved session is
  evaluated against its new directory. If the lookup fails, the setup directory
  is used and a warning is written — fail-open.
- A resource outside the session directory is denied: the guard is the workspace
  boundary, so `reports/`, `docs/planning/` and `audit-*` are not writable
  outside it. Inside it the first **root** segment decides.
- `reports/` is a reserved artifact root — the whole subtree is writable (even
  `reports/src/x.ts`), so project code must not live there (a
  `packages/reports/**` path counts as an artifact by contract).
  `docs/planning/**/*.md` is allowed (nested Markdown at any depth; a `.ts` file
  is not). `docs` is a separate branch, not a source root — every other
  `docs/**` path is denied.
- The source roots (`src`, `lib`, `test`, `tests`, `agents`, `tools`, `schemas`,
  `eval`, `.github`) are denied even under an artifact-looking prefix
  (`src/reports/x.ts`, `src/docs/planning/x.md`).
- Root artifact files (`case-*`, `risks-*`, `handoff-*`, `decisions-*`,
  `state.md`) are allowed only in the location root, under `reports/`,
  `docs/planning/` or an `audit-*` directory — `app/state.md` is denied.
- The hook runs after the flat rules, so a local `edit: allow` for `orchestrator`
  is closed too. The flat fallback carries only that artifact set as
  location-root rules (`reports/*`, `case-*.md`, `risks-*.md`, `handoff-*.md`,
  `decisions-*.md`, `state.md`, `docs/planning/*.md`) plus `audit-*/…`. The broad
  `*/state.md`-style patterns are gone, so `src/state.md` is denied even without
  the hook, but last-match still cannot express root priority everywhere
  (`audit-x/src/case-y.md`) — a warning is written.
- The fallback is narrower than the hook for nested artifact roots:
  `lab/x/reports/*` and similar paths are written only with the hook (the root
  rules cover `reports/*` at the location root only).
- A failing or timed-out session lookup (250 ms bound) falls back to the setup
  directory and writes the warning once per guard; for a moved session an
  absolute artifact path may then be denied (fail-closed for that class). A
  single `sessionWarned` flag without a counter is accepted: failures after the
  first warning stay silent.
- `shell` stays allowed for git and checks. A shell write and symlinks/junctions
  (the host matches the normalized lexical path, not `realpath`) are accepted
  risks, as is fail-open (a broken guard never breaks the session), governed by
  the prompt rather than a sandbox. A tool denial is a role rule — the edit goes
  to a subagent.

## Tools

The plugin registers five deterministic, **read-only** core tools in the
`orch_uni` namespace, a sixth discovery tool `list_tools`, and one flat
compatibility alias `orch_uni_validate_report` for older prompts. Canonical
calls use `tools.orch_uni.<name>({...})`; the alias is a separate registration
whose live-host acceptance is `not_verified` (the unit harness covers it), so
prompts and docs always prefer the dot form.

| Canonical call                   | Read-only | What it does                                                                    |
| -------------------------------- | --------- | ------------------------------------------------------------------------------- |
| `tools.orch_uni.validate_report` | yes       | Extract the SGR JSON block of a report, resolve its schema, validate it         |
| `tools.orch_uni.context_lint`    | yes       | Deterministic audit of AGENTS.md/SPEC.md: budget, vague phrases, links, sections |
| `tools.orch_uni.snapshot`        | yes       | Deterministic revision of a directory tree (per-file sha256 + aggregate hash)   |
| `tools.orch_uni.sessions`        | yes       | Child sessions of a session: agent, model, cost, tokens, time                   |
| `tools.orch_uni.session_stats`   | yes       | Session protocol counters plus the persisted journal                           |
| `tools.orch_uni.list_tools`      | yes       | Canonical calls; schema ids and minimal examples for `validate_report`          |

Every tool answers with a JSON text body. Failures are **typed codes** inside the
body (`E_INPUT`, `E_NO_JSON`, …) instead of thrown tool errors, so an agent can
branch on the code without parsing prose. None of the six writes to the
workspace, the session store or the configuration. The flat
`orch_uni_validate_report` alias executes exactly the validator above; it exists
only so older prompts keep working. Its registration is best-effort: if the host
rejects a namespace-less tool, the plugin emits one warning and skips the alias;
the six canonical tools stay registered.

### `tools.orch_uni.validate_report`

```jsonc
{ "text": "<report text>" }              // or
{ "path": "reports/empiric-r1.md",        // absolute, or relative to the location directory
  "schema": "empiric/v1" }          // optional: expected schema id
```

Provide exactly one of `text` / `path`. An unknown `schema` argument is refused
with `E_UNKNOWN_SCHEMA` **before** the file is read; the body carries `available`
(the shipped ids) and a `hint`. The tool then takes the **last** fenced ```` ```json ````
block that parses and carries a `schema` field, resolves the schema by that field and
validates the document.

```jsonc
{ "valid": true, "schema": "empiric/v1", "errors": [], "warnings": [ … ] }
{ "valid": false, "code": "E_INVALID", "schema": "empiric/v1",
  "errors": [ { "path": "$.findings[0].severity", "message": "expected one of …",
                "hint": "Field \"severity\" is not an allowed value; …" } ],
  "hint": "Fix $.findings[0].severity first: …",
  "warnings": [] }
```

Every failure body also carries `hint` (≤300 characters): the fenced-block
skeleton for `E_NO_JSON`, the usual JSON mistakes for `E_PARSE`, the expected and
reported ids plus `available` for `E_SCHEMA_MISMATCH`, and the first error for
`E_INVALID` — where each `errors[]` entry has its own `hint`.

| Code                | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `E_INPUT`           | Bad call: neither/both of `text`/`path`, wrong types, unreadable file |
| `E_NO_JSON`         | No fenced ```` ```json ```` block found; `hint` has the skeleton |
| `E_PARSE`           | A block exists but none parses as JSON                           |
| `E_UNKNOWN_SCHEMA`  | Unknown expected id (preflight) or a report id that is not shipped (see `available`) |
| `E_SCHEMA_MISMATCH` | The report names another schema than the expected one            |
| `E_INVALID`         | The document does not satisfy its schema (see `errors[].hint`)   |
| `E_SCHEMA_IO`       | `schemas/*.json` unreadable/malformed (see `directory`, `file`)  |
| `E_ABORTED`         | The session was stopped while reading the report                 |

`warnings` carry the prompt rules a *structurally valid* report can still miss — things
JSON Schema cannot express: a missing `rc` on an `empiric` claim whose `method` is
`run|measure|compare_base`, `self_check` items other than 1–19, an `invariant`
invariant that is `violated` without a counterexample, an uncovered mandatory
`lines_checked` line, `meta`'s `verdict` diverging from its `gate`, and
`redteam`'s `closing_list`/`verdict` invariants.

The schemas ship as `schemas/*.json` and are derived **strictly** from the SGR
sections of `agents/*.md`, which stay the source of truth: the test suite parses every
agent's SGR template and fails when a prompt field or enum value is not accepted by its
schema. `context-lint-failure/v1` is the typed failure envelope of
`tools.orch_uni.context_lint` — it has no agent template and is never a report. Schemas set
`additionalProperties` permissively — agents may add fields of their
own (`verdict_label`, `check`, …).

### `tools.orch_uni.list_tools`

```jsonc
{}                              // catalogue only
{ "tool": "validate_report" }   // plus schema ids, required fields and minimal examples
```

Returns `{ok, namespace, canonical, tools, compatibility, schemas?, exampleMaxChars?}`.
`tools` lists every name with its canonical `call` (`tools.orch_uni.<name>({...})`)
and a one-line summary. With `tool: "validate_report"` it adds `schemas`: one entry
per shipped id with `required` and a minimal valid `example` (≤1200 characters),
so a model can repair a report without reading these docs. An unknown `tool` is
`E_INPUT` with the available names.

### `tools.orch_uni.context_lint`

```jsonc
{ "path": "AGENTS.md" }                  // file or directory, relative to the location
{ "path": ".", "max_lines": 150, "max_tokens": 2000 }
{ "path": ".", "max_words": 2000 }       // SPEC word budget; default 1500 (target), ceiling 2000
{ "path": ".", "max_file_bytes": 500000, "max_files": 100, "max_findings": 50, "max_total_findings": 500 }
```

Deterministic, read-only audit of `AGENTS.md`, `SPEC.md` and `CLAUDE.md`. It returns
`{ schema: "context-lint/v1", ok: true, verdict, closing_list, files, summary, truncated? }`;
each finding carries `id`, `severity`, `kind`, `evidence`, `detail` and `fix`. Checks:
line/token/word budget, distinct vague phrases, duplicate lines, broken relative links,
placeholders, dates/versions in the first three lines, required sections and AC test
columns. Links and explicit targets are confined by their **real** path: a symlink or
junction that resolves outside the root is skipped, and such a target is refused
(`E_OUT_OF_ROOT`). Code fences, inline code and HTML comments are masked, so a sample is
never a rule: structural checks (commands, boundaries, verification) read the full mask,
while requirements, AC ids and non-goals read the fence mask. Link targets are
streamed from the line scanner one at a time (no candidate array), so memory does
not grow with the number of links; checks are capped per file at 50 000
candidates, the signal is checked per line and every 100 candidates, and the
link caches keep at most 5 000 entries, so an abort wins; 2001 links are checked
normally, 50 000 valid links still pass, and the 50 001st candidate makes the list
incomplete (`truncated: true` plus a MAJOR `link candidates truncated` marker in
`closing_list`), so a capped run can never pass. Broken
links have no separate per-file cap: the finding caps bound the output and report the
overflow. A line is scanned however long it is: the link scanner and the placeholder regex
are linear, so a 4100-character line is checked like any other and a broken link or
placeholder on it is the real finding, not a marker. Duplicate lines have no inner cap.
UNC/network targets are never probed. Measured (bun 1.4.2, Windows, fresh
process): 50 001 broken links with `max_findings: 2` → ~1.4 s and ~67 MB peak
RSS; 50k plain lines → ~0.14 s / ~65 MB; a 2 MB single line with links →
~3.1 s / ~116 MB (~41 MB without links). Masking reuses a line as-is when it
has no backtick and no `<pre>`/`<code>`/`<!--`, so it never copies a line
character by character, and a 2 MB single line stays capped at 50 000
candidates instead of materializing every link.
Limits: ≤ 2 MB per file, ≤ 500 files per scan. `max_findings` (per file) is N per
severity: up to N MAJOR and N MINOR/INFO are kept, and any excess is replaced by one
marker (MAJOR when a MAJOR was dropped, otherwise INFO); a MAJOR marker stays in
`closing_list`. `max_total_findings` (global, default 1000) keeps MAJOR
findings first; when MAJOR overflow, `max_total` findings plus one MAJOR `truncated`
marker are kept. A capped list sets `truncated: true` instead of hiding findings.
Markers are additional to `max_findings` and do not consume its budget: a capped
link-candidate list and a capped findings list report one marker each in the same run, so
`max_findings: 2` over 20 001 broken links yields 2 kept findings plus 2 markers. Cap
markers point at `file:1` in `evidence`.
Non-goals are counted as top-level items: a wrapped paragraph is one item, inline
`;`/`,`/`and` and their localized equivalents split only at the top level (not inside
`(…)`, `[…]`, backticks of any width or `<code>`), and a bullet at 0–4 spaces under the label is an item — fenced,
`<pre>` and deeper-indented code is not.
Placeholders are `<...>` (three or more dots) and `TODO`/`TBD`/`FIXME`; `<DoD>` and
`<name>` are markup.
`max_lines` is the single 200-line root budget the tool applies: the 60/200/100
per-level figures in [`docs/`](../) are authoring guidance, not separate tool limits.
`max_words` defaults to the 1500-word SPEC target; pass `max_words: 2000` to enforce the
documented ceiling instead.
Typed failures: `E_INPUT`, `E_NOT_FOUND`, `E_NO_FILES`, `E_IO`, `E_ABORTED`,
`E_LIMIT_FILE`, `E_LIMIT_FILES`, `E_OUT_OF_ROOT`.
A failure is a typed payload `{schema:"context-lint-failure/v1", ok:false, code, message, path?, bytes?, files?, max?}`
that validates only against `context-lint-failure/v1`; a report is
`{schema:"context-lint/v1", ok, verdict, closing_list, files, summary, truncated?}` and every file carries `lines`,
`words`, `chars` and `tokens_est` (tokens are estimated as Cyrillic/3 + the rest/4). A directory
target is scanned to depth 3, and `max_files` refuses early: the walk stops at the first file above
the limit. Nothing is dropped silently: a directory below the depth limit, a link or junction that
resolves outside the workspace root, and an unclosed fence, `<pre>` or HTML comment are INFO
findings, so a `pass` never hides an unchecked region. An unclosed `<code>` is a
line-local mask: it hides the rest of its line and is not reported (only fence,
`<pre>` and HTML comments span lines and get an INFO marker). An abort is observed
between files, every 2048 lines of a line-oriented check and at each gate, so the
worst-case latency is one mask pass over a file capped by `max_file_bytes` (tens of
milliseconds per 2 MB), not the whole scan. Commands count only inside code, a Task table
or a Commands section, an HTML comment such as `<!-- npm install -->` is not a command, and `make`
needs a target, so prose such as "Make sure …" is not a command. A scan started at the root also
picks up fixture trees such as `eval/`; pass an explicit path for the canonical files.

### `tools.orch_uni.snapshot`

```jsonc
{ "path": "lab/stack-test", "exclude": ["tmp"] }   // exclude is optional and additive
```

```jsonc
{ "root": "C:\\…\\lab\\stack-test",
  "files": [ { "path": "a.txt", "sha256": "…", "bytes": 1 } ],
  "aggregate": "…" }
```

- `aggregate = sha256` over the sorted lines `"<relpath>\0<sha256>\n"` (`/` separators,
  codepoint order) — stable across runs, machines and traversal order, and it changes
  whenever one file's path or content changes.
- Excluded by default (always): `node_modules`, `.git`, `.ae`; `exclude` adds names,
  whole relative paths or relative prefixes (`lab/tmp`). Symlinks are skipped.
- Limits: ≤ 5000 files, ≤ 50 MiB per file — `E_LIMIT_FILES` / `E_LIMIT_BYTES` (fail the
  whole snapshot; a truncated snapshot would be a wrong aggregate). `E_NOT_FOUND` for a
  missing path or a non-directory, `E_ABORTED` when the session is stopped.

### `tools.orch_uni.sessions`

```jsonc
{}                                        // children of the calling session
{ "sessionID": "ses_…", "recursive": true }  // whole subtree of another session
```

```jsonc
{ "sessionID": "ses_parent", "recursive": false, "source": "session.index",
  "authoritative": false, "indexSize": 1, "count": 1,
  "limitations": [ … ],
  "sessions": [ { "sessionID": "ses_child", "parentID": "ses_parent", "agent": "explore",
                  "model": "deepseek/deepseek-flash", "variant": "default", "title": "…",
                  "cost": 0.0005, "tokens": { "input": 3491, "output": 2 },
                  "created": "2026-10-15T04:01:06.627Z", "updated": "…" } ] }
```

`source` tells which route produced the answer:

- `session.list` — this build exposes a session listing API; the answer is
  **authoritative** and complete (`recursive` walks the subtree page by page).
- `session.index` — the fallback used by OpenCode 2.0.28: `ctx.session` has
  `get/create/…` but **no `list`**, so children cannot be enumerated from the store. The
  plugin subscribes to `session.created` / `session.deleted` events at setup and keeps
  `child → parent` in its plugin-scoped storage; per-child details are read from
  `ctx.session.get()` at call time. The answer is **not authoritative**; the caveats are
  returned in `limitations` (sessions created before the plugin instance started are
  invisible, and an event gap hides children created while the plugin was unloaded).
- `E_NO_API` — neither route exists. The context-scan fallback (looking for the
  `subagent` tool parts in `ctx.session.context`) was evaluated and rejected: in-flight
  children carry no session id in their tool part and compaction drops the history.
  Open question: a plugin-facing session listing (or a `parentID` filter on
  `ctx.session.context`) would remove the fallback entirely.

`E_INPUT` for malformed arguments, `E_NOT_FOUND` when the parent session does not exist,
`E_ABORTED` when the session is stopped.

### `tools.orch_uni.session_stats`

```jsonc
{}                                  // counters of the calling session
{ "sessionID": "ses_…" }            // any session on this server, not only a child
```

```jsonc
{ "ok": true, "sessionID": "ses_…",
  "counters": {
    "requests": 12, "promptTokensLast": 151204, "promptTokensMax": 161002,
    "promptTokensMedian": 148900, "band": 1, "compactions": 1,
    "compactionAttempts": 1, "compactionFailures": 0, "compactionSource": "event",
    "reminders": 2, "toolCalls": 31, "outputsCapped": 1,
    "outputCharsSaved": 18422, "errors": 0,
    "toolCallsByTool": { "shell": 18, "bash": 6, "webfetch": 2, "read": 5 },
    "toolOutputsCappedByTool": { "shell": 1, "bash": 0, "webfetch": 0, "read": 0 }
  },
  "limits": { "promptTokensSoft": 150000, "maxCompactions": 1, "maxToolOutputChars": 20000 },
  "overBudget": true, "compactionLimitReached": true, "toolsPerTurn": 2.58,
  "tracked": true,
  "guard": { "available": true, "hooksRegistered": true, "sessionEnabled": true,
             "toolOutputEnabled": true,
             "toolOutputTools": ["shell", "bash", "webfetch"],
             "compactionSource": "event", "eventLive": true,
             "streamFailures": 0, "unkeyedCalls": 0 },
  "journal": { "available": true,
               "counts": { "reminder": 1, "compaction": 1, "command": 1, "validation": 2 },
               "events": [ { "kind": "validation", "at": 1760000000000,
                             "schema": "empiric/v1", "valid": true,
                             "errorCount": 0, "warningCount": 1 } ] } }
```

`journal` is an optional, backward-compatible field: `{available, counts, events}`.
`counts` is an all-time aggregate per kind (`reminder`, `compaction`, `command`,
`validation`); `events` keeps the newest `options.sessionJournal.maxEvents`
(default 200) entries, so a capped journal still reports every fact in `counts`.
The journal lives in plugin storage under
`orchestrator.uni/session-journal/v1/<sessionID>`; it contains only whitelisted
primitives — never prompt text, tool arguments, paths or report bodies — and
`session.deleted` removes it with the counters. If journaling is disabled, a
storage write failed, or the session has no journal yet, `available` is `false`
and the field stays a normal success shape; it is never `E_NOT_FOUND`.

`sessionID` may name **any session on this server**, not only a child of the caller;
that is deliberate — the orchestrator uses the report to control every slice it runs.
Counters are per plugin instance, and `tracked` is `true` once any event or hook
observed the session; a `session.deleted` event forgets it. `band` is the highest
budget level reached (`0` below the soft threshold); `promptTokensMedian` is the
median over the last 256 requests; `toolCalls` and the per-tool counters include
nested Code Mode calls; `toolCallsByTool` and `toolOutputsCappedByTool` split calls
and capped outputs by the normalized tool name (namespace stripped, lower-case);
`outputCharsSaved` is a character count, not bytes, and an upper estimate (the
injected stub is subtracted). `compactions` counts confirmed
`session.compaction.ended` events only; `compactionAttempts` counts every
`session.compaction` hook call, so on a host with a dead or absent event stream
attempts keep growing while `compactions` and `compactionLimitReached` stay put (a
failed attempt is never a stop signal). A dead stream is reported once in
`guard.streamFailures`; the per-session `errors` counts hook failures only, so a
transport incident is not attributed to every session. Duplicate compaction events
are counted once only when the host supplies `event.id` or a durable position;
without either identity a re-delivered event may be counted again (fail-open in the
direction of counting). A
session the store does not return and this instance never observed is
`E_NOT_FOUND` (recognized by the typed `_tag`/`name`/`code` — `Session.NotFoundError`,
`SessionNotFoundError`, `NotFoundError`, `ENOENT` — with a narrow message fallback);
`session.get` returning `undefined` for an untracked session is the same not-found
answer; a transient `session.get` failure (a lock, permission, `unknown database`) is
`E_INTERNAL`; a known session with zero requests is a valid report with
`tracked: false`. Without `session.get`,
an untracked session is `E_NO_API`, a tracked one is `ok` with `session: null` and a
`limitations` entry. Codes: `E_INPUT`, `E_NOT_FOUND`, `E_INTERNAL`, `E_NO_API`,
`E_UNAVAILABLE` (the guard is not registered or its hooks failed), `E_ABORTED`.

## Session Hygiene

The plugin implements the [`session-discipline.md`](./session-discipline.md)
protocol: a session is one slice, the prompt budget is ≤150k tokens, at most one
compaction, tool output goes to a file, and a slice ends with a handoff.

The runtime part is three hooks (`session.context`, `session.compaction`,
`tool.execute.after`) plus a compaction-event subscription:

- `session.context` — estimates the prompt (system + messages) and, when it crosses
  a budget level, adds one short reminder. The reminder is injected **once, when a
  new level is crossed**, not on every request; within a level the text is stable,
  so the prefix cache is not broken.
- compaction events — the `session.compaction` hook is registered on **every** host:
  it counts attempts (`compactionAttempts`) and sends a tentative note to the
  nearest request; the note names no compaction number and claims no limit. Only
  `session.compaction.ended` confirms a compaction (deduplicated by `event.id` or
  the durable position) and raises a confirmed note with the number and the limit;
  `session.compaction.failed` increments `compactionFailures`, drops the tentative
  note and keeps a confirmed note that is still waiting for delivery. If the event
  stream ends or throws, `guard.eventLive` turns `false`,
  `guard.compactionSource` becomes `hook` and `guard.streamFailures` becomes `1`
  (the per-session `errors` stays `0`); the hook keeps counting attempts, but no
  confirmed compaction and no false "limit reached" is invented on that path.
- `tool.execute.after` — for `shell`, `bash`, `webfetch` it caps output over
  `maxChars`: the full text goes to a private per-process root
  `os.tmpdir()/opencode-tool-output-<random>/` (POSIX 0700 for the root and the
  session directory, 0600 for the file). Windows ignores mode (measured: 0666),
  so privacy there rests on the ACL of `os.tmpdir()` and is not checked by code.
  The model gets a head and the path; the root is created with
  `mkdtemp` at plugin setup, so a pre-created `opencode-tool-output` directory or
  junction is never used; on POSIX the root must belong to the current uid with no
  group/other access, otherwise the guard disables itself with a warning (fail-open:
  results are untouched). Session directories (`s-<uuid>`) and files
  (`c-<uuid>.txt`, written with `wx`) are random, and each `realpath` is proven
  inside the root. The root is removed when the plugin unloads (best effort). A
  lone surrogate is normalized once (U+FFFD), so the file, the head and the
  counters describe the same string. Residual risk accepted: a same-user attacker
  can still swap a session directory between `realpath` and `writeFile` (Node has
  no `openat`). If `TMPDIR` points inside the workspace, the files land there
  instead. `read`, `write`, `edit`, `execute` and the kit's own tools are not
  capped, and a kit tool named without its namespace (`session_stats`) is refused
  in the config with a warning.

`maxCompactions: 0` disables the compaction limit. `guard.toolOutputEnabled` is
`true` only when the private root was created **and** the effective tool list is
non-empty; `guard.toolOutputTools` is that list, and `guard.unkeyedCalls` counts
hook calls without a non-empty `sessionID` (they are dropped, not merged into an
empty bucket). An empty `tools` list disables the cap with a warning. The guard is
fail-open: a hook error neither breaks the request nor corrupts the result. Either
part can be disabled with its `enabled` flag:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-orchestrator-uni",
      "options": {
        "sessionGuard": { "enabled": true, "promptTokensSoft": 150000, "maxCompactions": 1 },
        "toolOutputGuard": {
          "enabled": true,
          "maxChars": 20000,
          "headChars": 4000,
          "tools": ["shell", "bash", "webfetch"]
        },
        "auditBudget": { "enabled": true, "softToolCalls": 150, "agents": ["empiric", "invariant"] },
        "sessionJournal": { "enabled": true, "maxEvents": 200 }
      }
    }
  ]
}
```

The **event journal** (`options.sessionJournal`) is a separate, fail-open
persistence of four protocol facts: `reminder` (after a real system-prompt push),
`compaction` (confirmed or failed, after deduplication), `command` (a slash command
ran) and `validation` (the validator returned). It stores no prompt text, tool
arguments, paths or report bodies, keeps the newest `maxEvents` per session
(default 200) while `counts` survives eviction, and is removed on `session.deleted`.
A storage failure produces one warning and turns journaling off for the instance;
`session_stats.journal.available` then reads `false`. Set
`"sessionJournal": { "enabled": false }` to switch it off entirely.

Slice metrics — `tools.orch_uni.session_stats`; closing a slice — the `/handoff` command.

## Auditor Efficiency

Auditors are the most expensive part of the loop: a session that re-reads the same
file, re-runs the same command or widens the class beyond the brief spends tool
calls without adding findings. Two layers keep the median in check.

**Budget and stop rules (prompt).** `empiric` and `invariant` carry the same block:
start from the brief's check matrix (claims/invariants → how to check); everything
outside it is `not_verified`; one `tools.orch_uni.snapshot` per audit (the revision
comes from the brief — repeat snapshot only when the revision is missing or the
tree changed); cache results, batch independent commands and send long output to a
file (≤200 lines into context); do not expand the class/files beyond the matrix.
The soft budget is **150 tool calls**: on reaching it the auditor stops collecting,
fills in the SGR and puts uncovered items into `not_verified`. The root does the
same before the pair: one snapshot, the revision and the claim matrix go into both
prompts.

**Soft runtime budget.** `options.auditBudget` counts `tool.execute.after` events
for the configured agents and, at `softToolCalls` (default **150**), queues one
system note for the next context request: "stop collecting, mark `not_verified`,
submit the SGR". It is delivered once per session, needs no compaction and works
even with `sessionGuard.enabled = false`; it never blocks a tool call and never
changes the result shape. Configuration: `{ "enabled": true, "softToolCalls": 150,
"agents": ["empiric", "invariant"] }`; agent names accept the legacy `audit-`
prefix and the `-d` suffix. An empty list disables the budget with a warning;
invalid values fall back to the default with a warning.

**How to measure.** Per session, `tools.orch_uni.session_stats` returns
`counters.toolCalls`, `counters.requests`, `counters.toolCallsByTool` and
`counters.promptTokensMax` (plus `reminders` and per-tool capped outputs).
`tools.orch_uni.validate_report` gives the report's `valid` share and its
findings. The target: a median of ≤150 tool calls for `empiric`/`invariant`
**without a drop in the valid share or the findings count**. Compare cohorts from
before and after the change (same project, same slice type, at least a few sessions
each) and report the median and the spread, not a single run.

## Loop And Artifacts

`options.protocolGuard` adds a live loop metric and a root artifact gate. It
observes the write guard's edit evaluations (every agent, final effect) and the
event stream (`session.created`, root `session.idle`/`session.execution.*`).
Defaults: `{ enabled: true, requirePair: true, artifactWarnings: true,
maxArtifactEntries: 500 }`.

- Only roots whose agent is `orchestrator` are classified; `build`/`general`/
  `plan` roots are ignored. A root with no known agent, or a terminal event for
  a session with no observed `session.created`, is resolved through a bounded
  `session.get` first; if the agent stays unknown, the root is skipped
  (fail-open).
- The loop is `none` without an `empiric`/`invariant` child, `audit` with at
  least one, and `audit+fix` only when both auditors and a `fix-runner` created
  at or after the first auditor exist. A source write is an allowed edit that
  the write guard classifies as source (`decideEdit` → `deny`); denied edits,
  artifact edits and shell writes are not counted.
- Writes of the root and every descendant (by parent chain) are summed. The
  metric is journaled as `loop` and mirrored into session metadata under
  `orchestrator.uni`; only counters and booleans are stored, never paths.
- When a root turn ends with source writes but no `audit+fix` (strict by
  default; `requirePair: false` accepts `audit`), one warning is queued and
  injected into the root's **next context** as a system part, once per root. A
  condition that disappears before delivery is dropped.
- The artifact gate runs on a root idle/terminal when the root has writes or
  audit activity: it shallowly checks `handoff-*.md`/`state.md` in the location
  root and `docs/planning/`, plus top-level `reports/*.md`. If none is found and
  `artifactWarnings` is on, the same next-context warning applies. Symlinks are
  skipped, absent directories count as empty, and a scan that hits
  `maxArtifactEntries` is marked truncated and never fabricates a warning.
- `tools.orch_uni.session_stats` returns the latest snapshot as `protocol` (or
  `null` before the first root idle); the event journal keeps `loop` and
  `artifact` events.
- Limitations: sessions created before this plugin instance started are
  invisible; shell writes are invisible; metadata is best-effort (bounded
  `session.get`/`session.update` failures and timeouts are one warning and the
  journal stays); multiple `context` hooks on one live host are **not_verified**
  (the API returns a separate registration per call).

## Models

Agent definitions carry no `model`; models are configured on the plugin entry in
`opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-orchestrator-uni",
      "options": {
        // Default for every kit agent.
        "model": "deepseek/deepseek-flash",
        // Per-agent overrides (id -> string or expanded form).
        "agents": {
          "meta": "deepseek/deepseek-reasoner",
          "fix-runner": { "providerID": "anthropic", "model": "claude-sonnet-4-5", "variant": "high" }
        }
      }
    }
  ]
}
```

- `model` — default model for every kit agent; `agents.<id>` — per-agent override.
  Both accept `"provider/model[#variant]"` or `{ providerID, model, variant }`.
- Without options, kit agents keep no model, so subagents inherit the session's model.
- Invalid values are ignored with a warning (`[orchestrator.uni] …`).
- Subagents run on their configured model; the primary `orchestrator` runs on the
  session's model, so a model set for `orchestrator` is informational for clients
  (as of OpenCode 2.0.28).
- An `agents` config entry or a local Markdown agent file that defines its own
  model still wins — configuration is applied after package plugins.

## Locale

Agent definitions and process documents ship per locale — `agents/<locale>/`
and `docs/<locale>/`; currently `ru` and `en` (the English content is a
translation of the Russian originals). The kit picks one locale in this order:

1. `options.locale` (`"ru"` or `"en"`; full tags such as `"ru-RU"` are accepted);
2. auto-detection: `LC_ALL` / `LC_MESSAGES` / `LANG`, then the runtime's Intl
   locale (the OS setting);
3. the default: `en`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-orchestrator-uni",
      "options": { "locale": "ru", "model": "deepseek/deepseek-flash" }
    }
  ]
}
```

A requested locale that ships no content falls back to the default locale and is
reported with a warning in the plugin log. Both locales register the same agents
under the same ids — switching the locale only changes the language of the
prompts, the process documents and the reference description.

## Precedence

Agent **definitions** are only filled in for ids that are not defined elsewhere: an
agent with the same id coming from your configuration — an `agents` config entry, or a
Markdown file under `~/.config/opencode/agents/` (or `.opencode/agents/`) — wins and the
plugin skips its definition. A **configured model** (see [Models](#models)) is still
applied to kit agents; a model defined by your own agent entry or file wins over it,
because configuration is applied after package plugins. The same skip-if-taken rule
applies to the `audit-kit` reference.

If you previously installed the kit by copying agent files into your config directory,
**remove those copies** after enabling the plugin, otherwise the stale copies keep
overriding the plugin-provided definitions.

## Notes

- One runtime dependency: [`gray-matter`](https://www.npmjs.com/package/gray-matter)
  for frontmatter parsing. OpenCode installs package plugin dependencies automatically.
- Plugin id: `orchestrator.uni`.
- The package loads directly from TypeScript: `exports` points at `index.ts`.
  There is no build step and no `dist/` (same pattern as `@opencode/plugin-figma`).
- Ships only the files listed in `package.json#files`: `index.ts`, `lib/`, `schemas/`,
  `agents/`, `docs/`, `README.md`, `README.ru.md`, `LICENSE`.

<p align="right">(<a href="../../README.md">back to README</a>)</p>
