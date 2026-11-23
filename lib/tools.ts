/**
 * tools — registration of the kit's deterministic, read-only audit tools.
 *
 * `registerAuditTools(ctx)` publishes five core tools in the `orch_uni`
 * namespace (canonical calls `tools.orch_uni.validate_report`,
 * `tools.orch_uni.context_lint`, `tools.orch_uni.snapshot`,
 * `tools.orch_uni.sessions`, `tools.orch_uni.session_stats`), a sixth
 * discovery tool `tools.orch_uni.list_tools`, and one flat compatibility alias
 * `orch_uni_validate_report`. The alias exists only because older prompts and
 * docs named the validator as `orch_uni_validate_report`; its live-host
 * registration is `not_verified` (the unit harness registers it, the packaged
 * host has not been observed), so every prompt uses the canonical dot form.
 *
 * - `validate_report` — extract the SGR JSON block of an agent report, resolve
 *   its schema, validate it and report prompt-level warnings;
 * - `context_lint` — deterministic, read-only checks for AGENTS.md/SPEC.md/CLAUDE.md:
 *   budget, vague phrases, duplicates, broken relative links, placeholders,
 *   dates in the first lines, required sections;
 * - `snapshot` — deterministic revision of a directory tree (per-file sha256 +
 *   aggregate hash) for "the state the verdict was fixed on";
 * - `sessions` — child sessions of a session (agent, model, cost, tokens, time),
 *   read through the plugin's session API only;
 * - `session_stats` — the session-protocol counters and limits of one session,
 *   plus the persisted protocol journal when there is one;
 * - `list_tools` — the canonical call of every tool and, for
 *   `validate_report`, the schema ids with minimal examples.
 *
 * Every tool answers with a JSON text body. Failures are typed (`E_*`) codes in
 * the body rather than thrown tool errors, so an agent can branch on the code.
 * All are read-only: they never write to the workspace or the config; the only
 * state kept is the plugin-scoped session index (`sessions`) and the protocol
 * journal read by `session_stats`, both in `ctx.storage` (see the notes below).
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { lintContext } from "./context-lint"
import type { EventJournal } from "./event-journal"
import { checkReport, type JsonSchemaNode, type ValidationCode } from "./report-schema"
import { compactionLimitReached, type SessionBudgetReport } from "./session-budget"
import { DEFAULT_EXCLUDE, isSnapshotFailure, snapshotTree } from "./snapshot"

/** Tool namespace; canonical calls are `tools.orch_uni.<name>`. */
export const TOOL_NAMESPACE = "orch_uni"

/** Names inside the namespace, in registration order. */
export const TOOL_NAMES: readonly string[] = [
  "validate_report",
  "context_lint",
  "snapshot",
  "sessions",
  "session_stats",
  "list_tools",
]

/** Canonical tool ids as a model addresses them through the tool API. */
export const TOOL_IDS: readonly string[] = TOOL_NAMES.map((name) => `${TOOL_NAMESPACE}.${name}`)

/**
 * The only flat compatibility alias: older prompts named the validator
 * `orch_uni_validate_report`. It is registered a second time without a
 * namespace; `not_verified` on a live host (the unit harness covers it).
 */
export const COMPATIBILITY_VALIDATE_REPORT = "orch_uni_validate_report"

/** Flat alias → the canonical name it mirrors. */
export const COMPATIBILITY_ALIASES: Readonly<Record<string, string>> = {
  [COMPATIBILITY_VALIDATE_REPORT]: "validate_report",
}

/** Every effective id a model may see: canonical dot names plus the one alias. */
export const TOOL_EFFECTIVE_IDS: readonly string[] = [...TOOL_IDS, COMPATIBILITY_VALIDATE_REPORT]

/** Directory holding the shipped report schemas (`schemas/*.json`). */
export const SCHEMAS_DIRECTORY = fileURLToPath(new URL("../schemas/", import.meta.url))

/** Storage key of the plugin-scoped session index. */
export const SESSION_INDEX_KEY = "session-index/v1"

const SESSIONS_PAGE_SIZE = 200
const SESSIONS_MAX_PAGES = 50

/** `{ id, schema, example? }` document shipped in `schemas/*.json`. */
interface SchemaDocument {
  readonly id: string
  readonly schema: JsonSchemaNode
  readonly example?: unknown
}

/** One loaded schema: the validator node and its optional minimal example. */
export interface SchemaEntry {
  readonly schema: JsonSchemaNode
  readonly example?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Typed failure of the schema registry (`schemas/*.json`): an unreadable
 * directory, an unreadable file, malformed JSON or a document of the wrong
 * shape. `loadSchemas` throws it on purpose — otherwise the plugin would
 * validate against a silently smaller registry — and the `validate_report`
 * executor converts it into an `E_SCHEMA_IO` refusal, so a caller always gets a
 * structured code plus the directory/file instead of a raw IO/parse exception.
 */
export class SchemaIoError extends Error {
  readonly code = "E_SCHEMA_IO"
  readonly directory: string
  readonly file: string | undefined

  constructor(message: string, directory: string, file?: string) {
    super(message)
    this.name = "SchemaIoError"
    this.directory = directory
    this.file = file
  }
}

/**
 * Read every `schemas/*.json` file into an id → `{schema, example}` map. Files
 * are read in sorted order; a malformed document throws a `SchemaIoError`
 * (fail-closed, typed). The example is optional at the loader level and checked
 * by the test suite (every shipped example must validate against its schema).
 */
export async function loadSchemaRegistry(directory: string = SCHEMAS_DIRECTORY): Promise<Map<string, SchemaEntry>> {
  let names: string[]
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    throw new SchemaIoError(`cannot read schemas directory ${directory}: ${errorMessage(error)}`, directory)
  }
  const schemas = new Map<string, SchemaEntry>()
  for (const file of names) {
    const absolute = path.join(directory, file)
    let source: string
    try {
      source = await readFile(absolute, "utf8")
    } catch (error) {
      throw new SchemaIoError(`cannot read schemas/${file} (${absolute}): ${errorMessage(error)}`, directory, absolute)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      throw new SchemaIoError(
        `schemas/${file} (${absolute}) is not valid JSON: ${errorMessage(error)}`,
        directory,
        absolute,
      )
    }
    const document = asRecord(parsed) as Partial<SchemaDocument> | undefined
    const id = document?.id
    const schema = document?.schema
    if (typeof id !== "string" || typeof schema !== "object" || schema === null) {
      throw new SchemaIoError(
        `schemas/${file} (${absolute}): expected { id: string, schema: object, example?: any }`,
        directory,
        absolute,
      )
    }
    schemas.set(id, {
      schema: schema as JsonSchemaNode,
      ...(document?.example === undefined ? {} : { example: document.example }),
    })
  }
  return schemas
}

/** Validator-facing view of the registry; the examples stay in `loadSchemaRegistry`. */
export async function loadSchemas(directory: string = SCHEMAS_DIRECTORY): Promise<Map<string, JsonSchemaNode>> {
  const registry = await loadSchemaRegistry(directory)
  return new Map([...registry].map(([id, entry]) => [id, entry.schema]))
}

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

function failure(code: string, message: string, extra: Record<string, unknown> = {}): { content: string } {
  return json({ ok: false, code, message, ...extra })
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}

/**
 * `session.get` failures that mean the session is genuinely absent.
 *
 * A live host may throw with an empty message but a typed `_tag`/`name`/`code`;
 * the message regex is only a narrow fallback, so a transient `unknown database`
 * or `unknown host` stays `E_INTERNAL` and cannot masquerade as a missing session.
 */
function isNotFoundError(error: unknown): boolean {
  const record = asRecord(error)
  if (record !== undefined) {
    for (const field of ["_tag", "name", "code"] as const) {
      const value = record[field]
      if (
        value === "Session.NotFoundError" ||
        value === "SessionNotFoundError" ||
        value === "NotFoundError" ||
        value === "ENOENT"
      ) {
        return true
      }
    }
  }
  return /session.*not.?found|unknown session/i.test(errorMessage(error))
}

/** `validate_report` input contract. */
const VALIDATE_REPORT_INPUT = {
  type: "object",
  properties: {
    text: { type: "string", description: "Report text to validate (use either text or path)." },
    path: { type: "string", description: "Path to a report file, absolute or relative to the location directory." },
    schema: { type: "string", description: 'Expected schema id, e.g. "empiric/v1".' },
  },
} as const

/** `context_lint` input contract. */
const CONTEXT_LINT_INPUT = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "File or directory to inspect, absolute or relative to the location directory. Default: the location directory.",
    },
    max_lines: { type: "number", description: "AGENTS/CLAUDE line budget. Default: 200." },
    max_tokens: { type: "number", description: "AGENTS/CLAUDE estimated token budget. Default: 2500." },
    max_words: {
      type: "number",
      description: "SPEC word budget. Default: 1500 (the authoring target); the documented ceiling is 2000.",
    },
    max_file_bytes: { type: "number", description: "Largest file that may be read, in bytes. Default: 2000000." },
    max_files: { type: "number", description: "Most files a directory target may expand to. Default: 500." },
    max_findings: {
      type: "number",
      description:
        "Per-file cap: MINOR/INFO findings kept, and the hard cap for MAJOR (excess becomes one MAJOR truncated finding). Default: 100.",
    },
    max_total_findings: {
      type: "number",
      description:
        "Global cap for all findings; MAJOR are kept first, the MAJOR overflow becomes one MAJOR truncated marker in closing_list. Default: 1000.",
    },
  },
} as const

/** `snapshot` input contract. */
const SNAPSHOT_INPUT = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "Directory to snapshot, absolute or relative to the location directory." },
    exclude: {
      type: "array",
      items: { type: "string" },
      description: `Extra names or relative prefixes to skip, on top of ${DEFAULT_EXCLUDE.join(", ")}.`,
    },
  },
} as const

/** `sessions` input contract. */
const SESSIONS_INPUT = {
  type: "object",
  properties: {
    sessionID: { type: "string", description: "Parent session id. Default: the calling session." },
    recursive: { type: "boolean", description: "Walk the whole subtree instead of direct children only." },
  },
} as const

/** `session_stats` input contract. */
const SESSION_STATS_INPUT = {
  type: "object",
  properties: {
    sessionID: { type: "string", description: "Session to report. Default: the calling session." },
  },
} as const

/** `list_tools` input contract. */
const LIST_TOOLS_INPUT = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: 'Optional tool name to expand, e.g. "validate_report" (adds schema ids and minimal examples).',
    },
  },
} as const

/** Upper bound for one example in the `list_tools` answer. */
export const MAX_TOOL_EXAMPLE_CHARS = 1200

/** Canonical tool catalogue rendered by `list_tools`. */
const TOOL_CATALOG: readonly { readonly name: string; readonly call: string; readonly summary: string }[] = [
  {
    name: "validate_report",
    call: 'tools.orch_uni.validate_report({ text: "<report>" }) or ({ path: "reports/x.md", schema: "empiric/v1" })',
    summary:
      "Validate an SGR report: extract the last ```json block, resolve its schema, report errors, hints and warnings.",
  },
  {
    name: "context_lint",
    call: 'tools.orch_uni.context_lint({ path: "." })',
    summary:
      "Deterministic read-only audit of AGENTS.md/SPEC.md/CLAUDE.md: budget, vague phrases, links, sections, findings.",
  },
  {
    name: "snapshot",
    call: 'tools.orch_uni.snapshot({ path: "." })',
    summary: "Revision of a directory tree: per-file sha256 plus one aggregate hash for the verdict.",
  },
  {
    name: "sessions",
    call: 'tools.orch_uni.sessions({ sessionID: "ses_...", recursive: true })',
    summary: "List child sessions with agent, model, cost, tokens and time.",
  },
  {
    name: "session_stats",
    call: 'tools.orch_uni.session_stats({ sessionID: "ses_..." })',
    summary: "Protocol counters, limits and the persisted event journal of one session.",
  },
  {
    name: "list_tools",
    call: 'tools.orch_uni.list_tools({ tool: "validate_report" })',
    summary: "This catalogue, including schema ids and minimal examples for validate_report.",
  },
]

/** Keep one example small enough to be pasted back as a starting template. */
function boundedExample(example: unknown): unknown {
  const text = JSON.stringify(example)
  if (text === undefined) return null
  return text.length <= MAX_TOOL_EXAMPLE_CHARS ? example : `${text.slice(0, MAX_TOOL_EXAMPLE_CHARS - 3)}...`
}

interface SessionInfoLike {
  readonly id?: string
  readonly parentID?: string | null
  readonly agent?: string | null
  readonly model?: { readonly id?: string; readonly providerID?: string; readonly variant?: string } | null
  readonly title?: string | null
  readonly cost?: number | null
  readonly tokens?: { readonly input?: number; readonly output?: number } | null
  readonly time?: { readonly created?: number; readonly updated?: number } | null
}

interface SessionPage {
  readonly data?: readonly SessionInfoLike[]
  readonly cursor?: { readonly next?: string } | null
}

type SessionListFn = (input?: Record<string, unknown>) => Promise<SessionPage>
type SessionGetFn = (input: { sessionID: string }) => Promise<SessionInfoLike>

function sessionMethod<T>(session: unknown, name: string): T | undefined {
  if (typeof session !== "object" || session === null) return undefined
  const candidate = (session as Record<string, unknown>)[name]
  return typeof candidate === "function" ? (candidate.bind(session) as T) : undefined
}

function isoTime(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null
}

function sessionSummary(info: SessionInfoLike): Record<string, unknown> {
  const model = info.model
  return {
    sessionID: info.id ?? null,
    parentID: info.parentID ?? null,
    agent: info.agent ?? null,
    model: typeof model?.id === "string" ? `${model.providerID ?? "?"}/${model.id}` : null,
    variant: model?.variant ?? null,
    title: info.title ?? null,
    cost: typeof info.cost === "number" ? info.cost : null,
    tokens: {
      input: typeof info.tokens?.input === "number" ? info.tokens.input : 0,
      output: typeof info.tokens?.output === "number" ? info.tokens.output : 0,
    },
    created: isoTime(info.time?.created),
    updated: isoTime(info.time?.updated),
  }
}

async function listChildren(listFn: SessionListFn, parentID: string, signal: AbortSignal): Promise<SessionInfoLike[]> {
  const collected: SessionInfoLike[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < SESSIONS_MAX_PAGES; page += 1) {
    if (signal.aborted) throw new Error("E_ABORTED")
    const result = await listFn({ parentID, limit: SESSIONS_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) })
    const data = result?.data ?? []
    for (const item of data) {
      if (typeof item.id !== "string" || seen.has(item.id)) continue
      seen.add(item.id)
      collected.push(item)
    }
    const next = result?.cursor?.next
    if (typeof next !== "string" || next === "" || data.length === 0) break
    cursor = next
  }
  return collected
}

/**
 * Plugin-scoped child-session index: `child sessionID → parentID`.
 *
 * Why it exists: this OpenCode build's plugin session API exposes no session
 * listing (`ctx.session` has get/create/… but no `list`), so children cannot be
 * enumerated from the session store. The only remaining route is the event
 * stream, which reports `session.created` with `parentID` — a durable fact for
 * every session created while this plugin instance is loaded. The index is kept
 * in `ctx.storage` so it survives plugin reloads and server restarts, and the
 * per-child details (agent/model/cost/tokens/title/time) are read from
 * `ctx.session.get()` at query time.
 *
 * Limits are reported by the tool (`authoritative: false` + `limitations`):
 * sessions created before the plugin started are not indexed, and the index is
 * not a substitute for a real listing API.
 */
export class SessionIndex {
  private readonly entries = new Map<string, string>()
  private loaded = false
  private loading: Promise<void> | undefined

  constructor(private readonly storage: Plugin.Context["storage"]) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loading ??= (async () => {
      const raw = await this.storage.get(SESSION_INDEX_KEY).catch(() => undefined)
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const children = (raw as { children?: unknown }).children
        if (typeof children === "object" && children !== null && !Array.isArray(children)) {
          for (const [child, parent] of Object.entries(children as Record<string, unknown>)) {
            if (typeof parent === "string" && parent !== "") this.entries.set(child, parent)
          }
        }
      }
      this.loaded = true
    })()
    await this.loading
  }

  private persist(): Promise<void> {
    return this.storage
      .set(SESSION_INDEX_KEY, { version: 1, children: { ...Object.fromEntries(this.entries) } })
      .catch(() => undefined)
  }

  async record(childID: string, parentID: string): Promise<void> {
    if (this.entries.get(childID) === parentID) return
    this.entries.set(childID, parentID)
    await this.persist()
  }

  async forget(sessionID: string): Promise<void> {
    if (this.entries.delete(sessionID)) await this.persist()
  }

  /** Known direct children of `parentID`, in insertion order. */
  childrenOf(parentID: string): string[] {
    const result: string[] = []
    for (const [child, parent] of this.entries) if (parent === parentID) result.push(child)
    return result
  }

  get size(): number {
    return this.entries.size
  }
}

interface SessionEventLike {
  readonly type?: string
  readonly data?: { readonly sessionID?: string; readonly parentID?: string }
}

/**
 * Feed the session index from the event stream. Returns false when this build
 * has no event subscription to offer. Failures are swallowed: an audit tool must
 * not break session execution.
 */
export function startSessionIndexSubscription(
  context: Plugin.Context,
  index: SessionIndex,
  signal: AbortSignal,
): boolean {
  const subscribe = sessionMethod<(options?: { signal?: AbortSignal }) => AsyncIterable<SessionEventLike>>(
    context.event,
    "subscribe",
  )
  if (subscribe === undefined) return false
  void (async () => {
    try {
      for await (const event of subscribe({ signal })) {
        const type = event?.type
        const data = event?.data
        if (data === undefined) continue
        const sessionID = data.sessionID
        if (typeof sessionID !== "string") continue
        if (type === "session.created" && typeof data.parentID === "string" && data.parentID !== "") {
          await index.record(sessionID, data.parentID)
        } else if (type === "session.deleted") {
          await index.forget(sessionID)
        }
      }
    } catch {
      // Subscription ended or the server went away; the index keeps its last state.
    }
  })()
  return true
}

/** Resolve an absolute path from a location-relative or absolute one. */
export function resolveRoot(directory: string, input: string): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(directory, input)
}

/** Optional seams for tests; the plugin calls this with the session-budget report. */
export interface RegisterAuditToolsOptions {
  /** Directory to read `schemas/*.json` from. Defaults to the shipped `schemas/`. */
  readonly schemasDirectory?: string
  /** Session counters from the runtime session guard; absent in isolation. */
  readonly sessionBudget?: SessionBudgetReport
  /** Persisted protocol journal, shared with the session guard and commands. */
  readonly journal?: EventJournal
  /** Warning channel of the plugin entry; a rejected compatibility alias is reported here. */
  readonly warn?: (message: string) => void
}

/**
 * Register the audit tools on the plugin context. The session index is loaded
 * before the transform callback, because transforms are synchronous; the report
 * schemas are not: they are re-read on every `validate_report` call, so a schema
 * edited while the plugin is live is applied without a reload (a price of a few
 * small JSON reads per validation).
 */
export async function registerAuditTools(
  context: Plugin.Context,
  options: RegisterAuditToolsOptions = {},
): Promise<() => void> {
  const schemasDirectory = options.schemasDirectory ?? SCHEMAS_DIRECTORY
  const directory = context.location.directory
  const session = context.session
  const warn = options.warn ?? (() => {})
  const index = new SessionIndex(context.storage)
  await index.ensureLoaded()
  const subscription = new AbortController()
  const indexed = startSessionIndexSubscription(context, index, subscription.signal)

  const readSchemas = async (): Promise<Map<string, JsonSchemaNode> | { readonly content: string }> => {
    try {
      return await loadSchemas(schemasDirectory)
    } catch (error) {
      if (error instanceof SchemaIoError) {
        return failure(error.code, error.message, {
          directory: error.directory,
          ...(error.file === undefined ? {} : { file: error.file }),
        })
      }
      return failure("E_SCHEMA_IO", `cannot load schemas from ${schemasDirectory}: ${errorMessage(error)}`, {
        directory: schemasDirectory,
      })
    }
  }

  const validateReport = async (
    input: unknown,
    toolContext: { readonly signal: AbortSignal; readonly sessionID?: string },
  ): Promise<{ content: string }> => {
    const record = asRecord(input)
    if (record === undefined) return failure("E_INPUT", "input must be an object ({text?} or {path?})")
    const { text, path: reportPath, schema: expectedSchema } = record
    if (text !== undefined && typeof text !== "string") return failure("E_INPUT", '"text" must be a string')
    if (reportPath !== undefined && typeof reportPath !== "string") return failure("E_INPUT", '"path" must be a string')
    if (expectedSchema !== undefined && typeof expectedSchema !== "string") {
      return failure("E_INPUT", '"schema" must be a string')
    }
    if ((text === undefined) === (reportPath === undefined)) {
      return failure("E_INPUT", 'provide exactly one of "text" or "path"')
    }
    let schemas: Map<string, JsonSchemaNode> | undefined
    // One journal fact per validator answer; never the report text or a path.
    const recordValidation = async (
      schema: string,
      valid: boolean,
      code: string | undefined,
      errorCount: number,
      warningCount: number,
    ): Promise<void> => {
      if (options.journal === undefined) return
      if (typeof toolContext.sessionID !== "string" || toolContext.sessionID === "") return
      await options.journal.append(toolContext.sessionID, {
        kind: "validation",
        schema,
        valid,
        ...(code === undefined ? {} : { code }),
        errorCount,
        warningCount,
      })
    }
    // Preflight: an expected schema id is checked before the report file is read,
    // so a typo in the call is E_UNKNOWN_SCHEMA with the available ids, not a
    // misleading "cannot read" when the path is wrong too.
    if (expectedSchema !== undefined) {
      const loaded = await readSchemas()
      if (!(loaded instanceof Map)) return loaded
      schemas = loaded
      if (!schemas.has(expectedSchema)) {
        const refusal = checkReport("", { schemas, expectedSchema })
        await recordValidation(expectedSchema, false, refusal.code, 0, 0)
        return failure(refusal.code ?? "E_UNKNOWN_SCHEMA", refusal.message ?? "unknown schema", {
          schema: expectedSchema,
          available: refusal.available,
          hint: refusal.hint,
        })
      }
    }
    let source = text as string
    if (reportPath !== undefined) {
      const absolute = resolveRoot(directory, reportPath)
      try {
        source = await readFile(absolute, "utf8")
      } catch (error) {
        return failure("E_INPUT", `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (toolContext.signal.aborted) return failure("E_ABORTED", "validation aborted")
    if (schemas === undefined) {
      const loaded = await readSchemas()
      if (!(loaded instanceof Map)) return loaded
      schemas = loaded
    }
    const report = checkReport(source, { ...(expectedSchema === undefined ? {} : { expectedSchema }), schemas })
    await recordValidation(
      report.schema ?? expectedSchema ?? "unknown",
      report.valid,
      report.code,
      report.errors.length,
      report.warnings.length,
    )
    return json(report)
  }

  const snapshotTool = async (
    input: unknown,
    toolContext: { readonly signal: AbortSignal },
  ): Promise<{ content: string }> => {
    const record = asRecord(input)
    if (record === undefined) return failure("E_INPUT", 'input must be an object with a "path" field')
    const { path: target, exclude } = record
    if (typeof target !== "string" || target === "") return failure("E_INPUT", '"path" must be a non-empty string')
    if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some((item) => typeof item !== "string"))) {
      return failure("E_INPUT", '"exclude" must be an array of strings')
    }
    const outcome = await snapshotTree({
      root: resolveRoot(directory, target),
      exclude: [...new Set([...DEFAULT_EXCLUDE, ...((exclude as string[] | undefined) ?? [])])],
      signal: toolContext.signal,
    })
    if (isSnapshotFailure(outcome)) return failure(outcome.code, outcome.message)
    return json({ root: outcome.root, files: outcome.files, aggregate: outcome.aggregate })
  }

  const contextLintTool = async (
    input: unknown,
    toolContext: { readonly signal?: AbortSignal } | undefined,
  ): Promise<{ content: string }> => {
    // A failure is not a report: it carries the `context-lint-failure/v1` id so it
    // validates against that schema and never passes as a `context-lint/v1` report.
    const lintFailure = (code: string, message: string, extra: Record<string, unknown> = {}) =>
      failure(code, message, { schema: "context-lint-failure/v1", ...extra })
    const record = input === undefined ? {} : asRecord(input)
    if (record === undefined)
      return lintFailure(
        "E_INPUT",
        "input must be an object ({path?, max_lines?, max_tokens?, max_words?, max_file_bytes?, max_files?, max_findings?, max_total_findings?})",
      )
    const {
      path: target,
      max_lines,
      max_tokens,
      max_words,
      max_file_bytes,
      max_files,
      max_findings,
      max_total_findings,
    } = record
    if (target !== undefined && (typeof target !== "string" || target === "")) {
      return lintFailure("E_INPUT", '"path" must be a non-empty string')
    }
    for (const [key, value] of [
      ["max_lines", max_lines],
      ["max_tokens", max_tokens],
      ["max_words", max_words],
      ["max_file_bytes", max_file_bytes],
      ["max_files", max_files],
      ["max_findings", max_findings],
      ["max_total_findings", max_total_findings],
    ] as const) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
        return lintFailure("E_INPUT", `"${key}" must be a positive number`)
      }
    }
    // The host may call an executor without a context (`execute(input, {})`), and
    // some builds pass no signal at all: fall back to a local controller instead
    // of throwing on `undefined.signal`.
    const controller = new AbortController()
    const signal = toolContext?.signal ?? controller.signal
    if (signal.aborted) return lintFailure("E_ABORTED", "context lint aborted")
    const outcome = await lintContext({
      root: directory,
      ...(target === undefined ? {} : { target: target as string }),
      ...(max_lines === undefined ? {} : { maxLines: max_lines as number }),
      ...(max_tokens === undefined ? {} : { maxTokens: max_tokens as number }),
      ...(max_words === undefined ? {} : { maxWords: max_words as number }),
      ...(max_file_bytes === undefined ? {} : { maxFileBytes: max_file_bytes as number }),
      ...(max_files === undefined ? {} : { maxFiles: max_files as number }),
      ...(max_findings === undefined ? {} : { maxFindingsPerFile: max_findings as number }),
      ...(max_total_findings === undefined ? {} : { maxTotalFindings: max_total_findings as number }),
      signal,
    })
    if (!outcome.ok) {
      const extra: Record<string, unknown> = {}
      if (outcome.path !== undefined) extra.path = outcome.path
      if (outcome.bytes !== undefined) extra.bytes = outcome.bytes
      if (outcome.files !== undefined) extra.files = outcome.files
      if (outcome.max !== undefined) extra.max = outcome.max
      return lintFailure(outcome.code, outcome.message, extra)
    }
    return json(outcome)
  }

  const listToolsTool = async (
    input: unknown,
    toolContext: { readonly signal?: AbortSignal } | undefined,
  ): Promise<{ content: string }> => {
    const record = input === undefined ? {} : asRecord(input)
    if (record === undefined) return failure("E_INPUT", "input must be an object ({tool?})")
    const { tool } = record
    if (tool !== undefined && (typeof tool !== "string" || tool === "")) {
      return failure("E_INPUT", '"tool" must be a non-empty string')
    }
    const wanted = tool as string | undefined
    if (wanted !== undefined && !TOOL_NAMES.includes(wanted)) {
      return failure("E_INPUT", `unknown tool "${wanted}"`, {
        available: TOOL_NAMES,
        hint: `Use tools.orch_uni.list_tools() or one of: ${TOOL_NAMES.join(", ")}.`,
      })
    }
    const response: Record<string, unknown> = {
      ok: true,
      namespace: TOOL_NAMESPACE,
      canonical: "tools.orch_uni.<name>({...})",
      tools: TOOL_CATALOG.map((entry) => ({ name: entry.name, call: entry.call, summary: entry.summary })),
      compatibility: {
        [COMPATIBILITY_VALIDATE_REPORT]: {
          preferred: "tools.orch_uni.validate_report",
          note: "flat alias kept for older prompts; registration on a live host is not_verified",
        },
      },
    }
    if (wanted === "validate_report") {
      if (toolContext?.signal?.aborted === true) return failure("E_ABORTED", "listing aborted")
      let registry: Map<string, SchemaEntry>
      try {
        registry = await loadSchemaRegistry(schemasDirectory)
      } catch (error) {
        if (error instanceof SchemaIoError) {
          return failure(error.code, error.message, {
            directory: error.directory,
            ...(error.file === undefined ? {} : { file: error.file }),
          })
        }
        return failure("E_SCHEMA_IO", `cannot load schemas from ${schemasDirectory}: ${errorMessage(error)}`, {
          directory: schemasDirectory,
        })
      }
      response.schemas = [...registry].map(([id, entry]) => ({
        id,
        required: entry.schema.required ?? [],
        example: boundedExample(entry.example),
      }))
      response.exampleMaxChars = MAX_TOOL_EXAMPLE_CHARS
      response.hint =
        'Paste one example into a fenced ```json block, replace the sample values, and keep the "schema" field. Warnings are advisory; errors block the report.'
    }
    return json(response)
  }

  const sessionsTool = async (
    input: unknown,
    toolContext: { readonly signal: AbortSignal; readonly sessionID: string },
  ): Promise<{ content: string }> => {
    const record = input === undefined ? {} : asRecord(input)
    if (record === undefined) return failure("E_INPUT", "input must be an object ({sessionID?, recursive?})")
    const { sessionID, recursive } = record
    if (sessionID !== undefined && (typeof sessionID !== "string" || sessionID === "")) {
      return failure("E_INPUT", '"sessionID" must be a non-empty string')
    }
    if (recursive !== undefined && typeof recursive !== "boolean") {
      return failure("E_INPUT", '"recursive" must be a boolean')
    }
    const parentID = (sessionID as string | undefined) ?? toolContext.sessionID
    if (toolContext.signal.aborted) return failure("E_ABORTED", "listing aborted")

    const listFn = sessionMethod<SessionListFn>(session, "list")
    const getFn = sessionMethod<SessionGetFn>(session, "get")
    const source = listFn !== undefined ? "session.list" : "session.index"
    if (listFn === undefined && !indexed && index.size === 0) {
      return failure("E_NO_API", "this OpenCode build exposes neither a session listing API nor an event stream", {
        sessionID: parentID,
        available: Object.keys(session as object).sort(),
        hint:
          "tools.orch_uni.sessions needs session.list({parentID}); ctx.session has no list() here, and ctx.event.subscribe() " +
          "was unavailable too, so children cannot be discovered. The context-scan fallback (subagent tool parts in " +
          "ctx.session.context) was evaluated and rejected: it misses in-flight children and any history dropped by " +
          "compaction. See README «Tools».",
      })
    }
    try {
      if (getFn !== undefined) await getFn({ sessionID: parentID })
      const children: SessionInfoLike[] = []
      if (listFn !== undefined) {
        if (recursive !== true) {
          children.push(...(await listChildren(listFn, parentID, toolContext.signal)))
        } else {
          const visited = new Set<string>([parentID])
          const queue = [parentID]
          while (queue.length > 0) {
            const current = queue.shift() as string
            for (const item of await listChildren(listFn, current, toolContext.signal)) {
              const id = item.id
              if (typeof id !== "string" || visited.has(id)) continue
              visited.add(id)
              children.push(item)
              queue.push(id)
            }
          }
        }
      } else {
        const ids: string[] = []
        if (recursive !== true) {
          ids.push(...index.childrenOf(parentID))
        } else {
          const visited = new Set<string>([parentID])
          const queue = [parentID]
          while (queue.length > 0) {
            const current = queue.shift() as string
            for (const id of index.childrenOf(current)) {
              if (visited.has(id)) continue
              visited.add(id)
              ids.push(id)
              queue.push(id)
            }
          }
        }
        for (const id of ids) {
          if (getFn === undefined) {
            children.push({ id })
            continue
          }
          try {
            children.push(await getFn({ sessionID: id }))
          } catch {
            children.push({ id })
          }
        }
      }
      return json({
        sessionID: parentID,
        recursive: recursive === true,
        source,
        authoritative: listFn !== undefined,
        indexSize: index.size,
        ...(listFn === undefined
          ? {
              limitations: [
                "children are indexed from `session.created` events: sessions created before this plugin instance started are not listed",
                "an event gap (plugin unloaded/reloaded during a run) hides children created in that window",
                "agent/model/cost/tokens/title/time are read from session.get() at call time",
              ],
            }
          : {}),
        count: children.length,
        sessions: children.map(sessionSummary),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === "E_ABORTED" || toolContext.signal.aborted) return failure("E_ABORTED", "listing aborted")
      if (getFn !== undefined && isNotFoundError(error)) {
        return failure("E_NOT_FOUND", `session ${parentID} was not found: ${message}`, { sessionID: parentID })
      }
      return failure("E_INTERNAL", message, { sessionID: parentID })
    }
  }

  const sessionStatsTool = async (
    input: unknown,
    toolContext: { readonly signal: AbortSignal; readonly sessionID: string },
  ): Promise<{ content: string }> => {
    const record = input === undefined ? {} : asRecord(input)
    if (record === undefined) return failure("E_INPUT", "input must be an object ({sessionID?})")
    const { sessionID } = record
    if (sessionID !== undefined && (typeof sessionID !== "string" || sessionID === "")) {
      return failure("E_INPUT", '"sessionID" must be a non-empty string')
    }
    if (toolContext.signal.aborted) return failure("E_ABORTED", "report aborted")
    const target = (sessionID as string | undefined) ?? toolContext.sessionID
    const budget = options.sessionBudget
    if (budget === undefined) {
      return failure("E_UNAVAILABLE", "the session guard is not registered in this plugin instance", {
        sessionID: target,
      })
    }
    if (!budget.available) {
      return failure("E_UNAVAILABLE", "the session guard is unavailable: its hooks could not be registered", {
        sessionID: target,
      })
    }
    const tracked = budget.tracked(target)
    const counters = budget.stats(target)
    const { session: sessionConfig, toolOutput } = budget.config
    const guard = budget.guard()
    const getFn = sessionMethod<SessionGetFn>(session, "get")
    if (getFn === undefined && !tracked) {
      return failure(
        "E_NO_API",
        "this OpenCode build exposes no session.get() and the session is not tracked by this plugin instance",
        { sessionID: target },
      )
    }
    let info: Record<string, unknown> | undefined
    let getError: unknown
    let getMissing = false
    if (getFn !== undefined) {
      try {
        const fetched: SessionInfoLike | null | undefined = await getFn({ sessionID: target })
        if (fetched === undefined || fetched === null) getMissing = true
        else info = sessionSummary(fetched)
      } catch (error) {
        getError = error
      }
    }
    // A session this instance never observed is only "not found" when the store
    // says so; a transient error (lock, permission, transport) stays `E_INTERNAL`
    // instead of masquerading as a missing session. A known session with zero
    // requests is a valid `tracked:false` report. `session.get` returning
    // `undefined` without an error is the store's "no such session" answer.
    if (info === undefined && !tracked) {
      if (getError !== undefined) {
        const message = errorMessage(getError)
        if (isNotFoundError(getError)) {
          return failure("E_NOT_FOUND", `session ${target} was not found: ${message}`, { sessionID: target })
        }
        return failure("E_INTERNAL", message, { sessionID: target })
      }
      if (getMissing) {
        return failure("E_NOT_FOUND", `session ${target} was not found`, { sessionID: target })
      }
    }
    const journal =
      options.journal === undefined ? { available: false, counts: {}, events: [] } : await options.journal.read(target)
    return json({
      ok: true,
      sessionID: target,
      counters,
      limits: {
        promptTokensSoft: sessionConfig.promptTokensSoft,
        maxCompactions: sessionConfig.maxCompactions,
        maxToolOutputChars: toolOutput.maxChars,
      },
      overBudget: counters.promptTokensMax > sessionConfig.promptTokensSoft,
      compactionLimitReached: compactionLimitReached(budget.config, counters.compactions),
      toolsPerTurn: counters.requests > 0 ? Math.round((counters.toolCalls / counters.requests) * 100) / 100 : 0,
      tracked,
      guard,
      journal,
      ...(getFn === undefined
        ? { session: null, limitations: ["session.get is unavailable in this build"] }
        : info === undefined
          ? {}
          : { session: info }),
    })
  }

  await context.tool.transform((editor) => {
    editor.namespace({
      name: TOOL_NAMESPACE,
      description:
        "Deterministic, read-only tools of the orchestrator agent kit (SGR validation, context-file lint, state snapshots, session accounting).",
    })
    editor.add({
      name: "context_lint",
      description:
        'Canonical call: tools.orch_uni.context_lint({ path: "." }). ' +
        "Deterministic, read-only audit of AGENTS.md/SPEC.md/CLAUDE.md: line/token/word budget, distinct vague phrases, duplicate lines, " +
        "broken relative links, placeholders, dates in the first three lines, required sections, AC test columns. " +
        "A directory target is scanned to depth 3 and capped at max_files (the walk stops at the first file above the limit); " +
        "a scan started at the root also picks up fixture trees such as eval/ (pass an explicit path for the canonical files); " +
        "undocumented directories below depth 3, unclosed fences and links that resolve outside the workspace root are reported " +
        "as INFO findings and never checked silently. Commands count only inside code, a Task table or a Commands section; " +
        "tokens are estimated as Cyrillic/3 + the rest/4. " +
        "Returns JSON {schema, ok, verdict, closing_list, files, summary, truncated?}; each file carries lines, words, chars " +
        "and tokens_est. A per-file cap drops findings and sets truncated=true, max_total_findings keeps MAJOR first and turns " +
        "the MAJOR overflow into one MAJOR truncated finding in closing_list. A file target is capped by max_file_bytes, " +
        'also while it is read. A failure is JSON {schema:"context-lint-failure/v1", ok:false, code, message, path?, bytes?, ' +
        "files?, max?} with a typed code " +
        "(E_INPUT|E_NOT_FOUND|E_NO_FILES|E_IO|E_ABORTED|E_LIMIT_FILE|E_LIMIT_FILES|E_OUT_OF_ROOT).",
      input: CONTEXT_LINT_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: contextLintTool,
    })
    editor.add({
      name: "validate_report",
      description:
        'Canonical call: tools.orch_uni.validate_report({ text: "<report>" }) or ' +
        '({ path: "reports/empiric-r1.md", schema: "empiric/v1" }). ' +
        "Validate an SGR report: extract the last ```json block, resolve its schema, validate it and list prompt-level warnings. " +
        "Read-only. Returns JSON {valid, schema, errors, warnings}; a failure body carries a code, a short hint, the error list " +
        "(each error has a hint) and, for schema problems, the available schema ids. " +
        "Typed codes: E_INPUT|E_NO_JSON|E_PARSE|E_UNKNOWN_SCHEMA|E_SCHEMA_MISMATCH|E_INVALID|E_SCHEMA_IO|E_ABORTED.",
      input: VALIDATE_REPORT_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: validateReport,
    })
    editor.add({
      name: "snapshot",
      description:
        'Canonical call: tools.orch_uni.snapshot({ path: "." }). ' +
        "Deterministic revision of a directory tree: per-file sha256 + aggregate hash of sorted `<path>\\0<sha256>\\n` lines. " +
        "Read-only, excludes node_modules/.git/.ae by default, limits 5000 files and 50 MiB per file.",
      input: SNAPSHOT_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: snapshotTool,
    })
    editor.add({
      name: "sessions",
      description:
        "Canonical call: tools.orch_uni.sessions({ recursive: true }). " +
        "List child sessions of a session (sessionID, parentID, agent, model, title, cost, tokens, created, updated). " +
        "Defaults to the calling session; `recursive: true` walks the whole subtree. Read-only.",
      input: SESSIONS_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: sessionsTool,
    })
    editor.add({
      name: "session_stats",
      description:
        'Canonical call: tools.orch_uni.session_stats({ sessionID: "ses_..." }). ' +
        "Session protocol counters of a session: requests, estimated prompt tokens (last/max), budget band, confirmed " +
        "compactions and compaction attempts, failed compactions, the live compaction source, reminders injected, tool " +
        "calls and capped tool outputs (totals and per normalized tool name), chars kept out of context, plus the " +
        "configured limits and toolsPerTurn. The optional `journal` field carries the persisted protocol events " +
        "({available, counts, events}); it is available:false when journaling is off or storage failed, never an " +
        "E_NOT_FOUND. Read-only; counters belong to this plugin instance. `sessionID` may name any " +
        "session on this server, not only a child of the caller. Returns JSON {ok, sessionID, counters, limits, overBudget, " +
        "compactionLimitReached, toolsPerTurn, tracked, guard, journal, session?, limitations?} or a typed code " +
        "(E_INPUT|E_NOT_FOUND|E_INTERNAL|E_NO_API|E_UNAVAILABLE|E_ABORTED).",
      input: SESSION_STATS_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: sessionStatsTool,
    })
    editor.add({
      name: "list_tools",
      description:
        'Canonical call: tools.orch_uni.list_tools({ tool: "validate_report" }). ' +
        "Discovery tool: returns the namespace, the canonical call and a one-line summary of every tool, and — with " +
        'tool:"validate_report" — the shipped schema ids with required fields and one minimal valid example each ' +
        `(examples are capped at ${MAX_TOOL_EXAMPLE_CHARS} characters). Read-only.`,
      input: LIST_TOOLS_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: listToolsTool,
    })
    // Compatibility alias only: older prompts named the validator
    // `orch_uni_validate_report`. It is registered a second time without a
    // namespace so the flat name stays callable; `not_verified` on a live host
    // (the harness registers it, the packaged host has not been observed), and
    // every prompt/doc prefers `tools.orch_uni.validate_report`. The registration
    // is best-effort: a host that rejects namespace-less tools must not take the
    // six working namespaced tools down with it.
    try {
      editor.add({
        name: COMPATIBILITY_VALIDATE_REPORT,
        description:
          "Compatibility flat alias of tools.orch_uni.validate_report for older prompts. " +
          'Prefer the canonical call: tools.orch_uni.validate_report({ text: "<report>" }) or ' +
          '({ path: "reports/x.md", schema: "empiric/v1" }). Same input and output as validate_report. ' +
          "If the host rejects a namespace-less registration, this alias is skipped with one warning and the " +
          "canonical tools.orch_uni.validate_report remains available. Registration of this flat name on a live " +
          "host is not_verified.",
        input: VALIDATE_REPORT_INPUT,
        execute: validateReport,
      })
    } catch (error) {
      warn(
        `compatibility flat alias ${COMPATIBILITY_VALIDATE_REPORT} skipped: the host rejected a namespace-less ` +
          `tool registration (${errorMessage(error)}); use tools.orch_uni.validate_report`,
      )
    }
  })

  return () => {
    subscription.abort()
  }
}

export type { ValidationCode }
