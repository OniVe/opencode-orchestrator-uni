# opencode-orchestrator-agents

A native [OpenCode V2](https://opencode.ai/v2/docs/build/plugins) package plugin that
ships the **orchestrator agent kit**:

- `orchestrator` — the root orchestrator (primary agent) with the audit loop as a
  built-in mode;
- read-only audit subagents — `audit-factcheck`, `audit-empiric`, `audit-invariant`,
  `audit-arbiter`, `audit-meta`, `audit-redteam`;
- `fix-runner` — the only writing subagent (applies the "to close" list);
- the kit's process documents, exposed as the **`audit-kit` reference**
  (`call-mechanics.md`, `process-ready-loop.md`, `root-runbook.md`,
  `instruction-other-session.md`);
- three deterministic, read-only tools — `audit_validate_report`, `audit_snapshot`,
  `audit_sessions` (see [Tools](#tools)).

The package is loaded directly from TypeScript: `exports` points at
[`index.ts`](./index.ts). There is **no build step and no `dist/`** — OpenCode's
Bun-based runtime resolves and loads the entry point natively (same pattern as the
official `@opencode/plugin-figma` package).

## What the plugin registers

On setup (`ctx.agent.transform` / `ctx.reference.transform`):

| Agent             | Mode       | Role                                                     |
| ----------------- | ---------- | -------------------------------------------------------- |
| `orchestrator`    | `primary`  | Root orchestrator; audit loop as a built-in mode         |
| `audit-factcheck` | `subagent` | Read-only: staleness pre-pass (already done / outdated)  |
| `audit-empiric`   | `subagent` | Read-only: reproductions, measurements, first sources    |
| `audit-invariant` | `subagent` | Read-only: states, cancels, races, hostile input         |
| `audit-arbiter`   | `subagent` | Read-only: resolves disputed findings only               |
| `audit-meta`      | `subagent` | Read-only: meta-audit of reports (pass/fail gate)        |
| `audit-redteam`   | `subagent` | Read-only: acceptance red team (release gates)           |
| `fix-runner`      | `subagent` | Writer: applies the fix list and proves closure          |

All agents ship **without a model**: models are deployment configuration (see
[Models](#models)). Definitions live in [`agents/`](./agents) as plain Markdown agent
files and are parsed at setup time — the files are the single source of truth.

The `audit-kit` reference points at this package's `docs/` directory. OpenCode lists it
in session context as an additional local directory, so the orchestrator (and any other
agent) can read the process documents directly, for example
`<reference path>/call-mechanics.md`.

The plugin also registers three deterministic, **read-only** tools in the `audit`
namespace — see [Tools](#tools).

## Tools

| Effective name           | Read-only | What it does                                                                  |
| ------------------------ | --------- | ----------------------------------------------------------------------------- |
| `audit_validate_report`  | yes       | Extract the SGR JSON block of a report, resolve its schema, validate it        |
| `audit_snapshot`         | yes       | Deterministic revision of a directory tree (per-file sha256 + aggregate hash)  |
| `audit_sessions`         | yes       | Child sessions of a session: agent, model, cost, tokens, time                  |

Every tool answers with a JSON text body. Failures are **typed codes** inside the body
(`E_INPUT`, `E_NO_JSON`, …) instead of thrown tool errors, so an agent can branch on the
code without parsing prose. None of the three writes to the workspace, the session store
or the configuration.

### `audit_validate_report`

```jsonc
{ "text": "<report text>" }              // or
{ "path": "reports/empiric-r1.md",        // absolute, or relative to the location directory
  "schema": "audit-empiric/v1" }          // optional: expected schema id
```

Provide exactly one of `text` / `path`. The tool takes the **last** fenced ```` ```json ````
block that parses and carries a `schema` field, resolves the schema by that field and
validates the document.

```jsonc
{ "valid": true, "schema": "audit-empiric/v1", "errors": [], "warnings": [ … ] }
{ "valid": false, "code": "E_INVALID", "schema": "audit-empiric/v1",
  "errors": [ { "path": "$.findings[0].severity", "message": "expected one of …" } ],
  "warnings": [] }
```

| Code                | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `E_INPUT`           | Bad call: neither/both of `text`/`path`, wrong types, unreadable file |
| `E_NO_JSON`         | No fenced ```` ```json ```` block found                          |
| `E_PARSE`           | A block exists but none parses as JSON                           |
| `E_UNKNOWN_SCHEMA`  | The report names an id that is not shipped (or no id at all)     |
| `E_SCHEMA_MISMATCH` | The report names another schema than the expected one            |
| `E_INVALID`         | The document does not satisfy its schema (see `errors`)          |
| `E_ABORTED`         | The session was stopped while reading the report                 |

`warnings` carry the prompt rules a *structurally valid* report can still miss — things
JSON Schema cannot express: a missing `rc` on an `audit-empiric` claim whose `method` is
`run|measure|compare_base`, `self_check` items other than 1–19, an `audit-invariant`
invariant that is `violated` without a counterexample, an uncovered mandatory
`lines_checked` line, `audit-meta`'s `verdict` diverging from its `gate`, and
`audit-redteam`'s `closing_list`/`verdict` invariants.

The seven schemas ship as `schemas/*.json` and are derived **strictly** from the SGR
sections of `agents/*.md`, which stay the source of truth: the test suite parses every
agent's SGR template and fails when a prompt field or enum value is not accepted by its
schema. Schemas set `additionalProperties` permissively — agents may add fields of their
own (`verdict_label`, `check`, …).

### `audit_snapshot`

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

### `audit_sessions`

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

## Models

Agent definitions carry no `model`; models are configured on the plugin entry in
`opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-orchestrator-agents",
      "options": {
        // Default for every kit agent.
        "model": "deepseek/deepseek-flash",
        // Per-agent overrides (id -> string or expanded form).
        "agents": {
          "audit-meta": "deepseek/deepseek-reasoner",
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
- Invalid values are ignored with a warning (`[orchestrator-agents] …`).
- Subagents run on their configured model; the primary `orchestrator` runs on the
  session's model, so a model set for `orchestrator` is informational for clients
  (as of OpenCode 2.0.28).
- An `agents` config entry or a local Markdown agent file that defines its own
  model still wins — configuration is applied after package plugins.

## Requirements

- **OpenCode 2.x** with the V2 plugin API (the `plugins` config field). V1's plugin
  loader expects the legacy `server()` export and will not load this plugin.

## Install

### With the OpenCode CLI

```sh
opencode plugin add opencode-orchestrator-agents
```

### Manually

Add the package to the `plugins` array in your global
`~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-orchestrator-agents"]
}
```

Pin a version if you prefer:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-orchestrator-agents@0.1.0"]
}
```

To set kit models at the same time, use the object form — see [Models](#models):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-orchestrator-agents",
      "options": { "model": "deepseek/deepseek-flash" }
    }
  ]
}
```

Restart the OpenCode service after changing the config:

```sh
opencode service restart
```

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

## Development

There is no build. `index.ts` is the shipped entry point.

```sh
npm install          # installs gray-matter + dev tooling
npm run typecheck    # tsc --noEmit
npm test             # bun test test/ (registration, tools, validator, snapshot, prompt↔schema guards)
```

Test against a live server by pointing a project config at the checkout:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///C:/path/to/opencode-orchestrator-agents"]
}
```

Configured local plugin paths must be directories (or `file://` URLs of directories);
OpenCode watches them and reloads on change.

## Notes

- One runtime dependency: [`gray-matter`](https://www.npmjs.com/package/gray-matter)
  for frontmatter parsing. OpenCode installs package plugin dependencies automatically.
- Plugin id: `orchestrator-agents`.
- Ships only the files listed in `package.json#files`: `index.ts`, `lib/`, `schemas/`,
  `agents/`, `docs/`, `README.md`, `LICENSE`.

## License

MIT
