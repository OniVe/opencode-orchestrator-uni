/**
 * tools — registration of the kit's deterministic, read-only audit tools.
 *
 * `registerAuditTools(ctx)` publishes three tools in the `orch_uni` namespace
 * (effective names `orch_uni_validate_report`, `orch_uni_snapshot`, `orch_uni_sessions`)
 * and returns a cleanup that stops the background session-index subscription:
 *
 * - `validate_report` — extract the SGR JSON block of an agent report, resolve
 *   its schema, validate it and report prompt-level warnings;
 * - `snapshot` — deterministic revision of a directory tree (per-file sha256 +
 *   aggregate hash) for "the state the verdict was fixed on";
 * - `sessions` — child sessions of a session (agent, model, cost, tokens, time),
 *   read through the plugin's session API only.
 *
 * Every tool answers with a JSON text body. Failures are typed (`E_*`) codes in
 * the body rather than thrown tool errors, so an agent can branch on the code.
 * All three are read-only: they never write to the workspace or the config; the
 * only state `sessions` keeps is a plugin-scoped session index in `ctx.storage`
 * (see the `sessions` tool notes below).
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { checkReport, type JsonSchemaNode, type ValidationCode } from "./report-schema"
import { DEFAULT_EXCLUDE, isSnapshotFailure, snapshotTree } from "./snapshot"

/** Tool namespace; effective names become `orch_uni_<name>`. */
export const TOOL_NAMESPACE = "orch_uni"

/** Effective tool names as they appear to a model. */
export const TOOL_IDS: readonly string[] = ["orch_uni_validate_report", "orch_uni_snapshot", "orch_uni_sessions"]

/** Directory holding the shipped report schemas (`schemas/*.json`). */
export const SCHEMAS_DIRECTORY = fileURLToPath(new URL("../schemas/", import.meta.url))

/** Storage key of the plugin-scoped session index. */
export const SESSION_INDEX_KEY = "session-index/v1"

const SESSIONS_PAGE_SIZE = 200
const SESSIONS_MAX_PAGES = 50

/** `{ id, schema }` document shipped in `schemas/*.json`. */
interface SchemaDocument {
  readonly id: string
  readonly schema: JsonSchemaNode
}

/**
 * Read every `schemas/*.json` file into an id → schema map. Files are read in
 * sorted order; a malformed document throws (the plugin would otherwise
 * validate against a silently smaller registry).
 */
export async function loadSchemas(directory: string = SCHEMAS_DIRECTORY): Promise<Map<string, JsonSchemaNode>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
  const schemas = new Map<string, JsonSchemaNode>()
  for (const file of files) {
    const source = await readFile(path.join(directory, file), "utf8")
    const document = JSON.parse(source) as SchemaDocument
    if (typeof document.id !== "string" || typeof document.schema !== "object" || document.schema === null) {
      throw new Error(`schemas/${file}: expected { id: string, schema: object }`)
    }
    schemas.set(document.id, document.schema)
  }
  return schemas
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

/** `validate_report` input contract. */
const VALIDATE_REPORT_INPUT = {
  type: "object",
  properties: {
    text: { type: "string", description: "Report text to validate (use either text or path)." },
    path: { type: "string", description: "Path to a report file, absolute or relative to the location directory." },
    schema: { type: "string", description: 'Expected schema id, e.g. "empiric/v1".' },
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

/**
 * Register the audit tools on the plugin context. Loading the schemas and the
 * session index happens before the transform callback, because transforms are
 * synchronous and the executors must close over complete, immutable state.
 */
export async function registerAuditTools(context: Plugin.Context): Promise<() => void> {
  const schemas = await loadSchemas()
  const directory = context.location.directory
  const session = context.session
  const index = new SessionIndex(context.storage)
  await index.ensureLoaded()
  const subscription = new AbortController()
  const indexed = startSessionIndexSubscription(context, index, subscription.signal)

  const validateReport = async (
    input: unknown,
    toolContext: { readonly signal: AbortSignal },
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
    const report = checkReport(source, { ...(expectedSchema === undefined ? {} : { expectedSchema }), schemas })
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
          "orch_uni_sessions needs session.list({parentID}); ctx.session has no list() here, and ctx.event.subscribe() " +
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
      if (getFn !== undefined && /not ?found|unknown/i.test(message)) {
        return failure("E_NOT_FOUND", `session ${parentID} was not found: ${message}`, { sessionID: parentID })
      }
      return failure("E_INTERNAL", message, { sessionID: parentID })
    }
  }

  await context.tool.transform((editor) => {
    editor.namespace({
      name: TOOL_NAMESPACE,
      description:
        "Deterministic, read-only tools of the orchestrator agent kit (SGR validation, state snapshots, session accounting).",
    })
    editor.add({
      name: "validate_report",
      description:
        "Validate an SGR report: extract the last ```json block, resolve its schema, validate it and list prompt-level warnings. " +
        "Read-only. Returns JSON {valid, schema, errors, warnings} or a typed code " +
        "(E_INPUT|E_NO_JSON|E_PARSE|E_UNKNOWN_SCHEMA|E_SCHEMA_MISMATCH|E_INVALID|E_ABORTED).",
      input: VALIDATE_REPORT_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: validateReport,
    })
    editor.add({
      name: "snapshot",
      description:
        "Deterministic revision of a directory tree: per-file sha256 + aggregate hash of sorted `<path>\\0<sha256>\\n` lines. " +
        "Read-only, excludes node_modules/.git/.ae by default, limits 5000 files and 50 MiB per file.",
      input: SNAPSHOT_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: snapshotTool,
    })
    editor.add({
      name: "sessions",
      description:
        "List child sessions of a session (sessionID, parentID, agent, model, title, cost, tokens, created, updated). " +
        "Defaults to the calling session; `recursive: true` walks the whole subtree. Read-only.",
      input: SESSIONS_INPUT,
      options: { namespace: TOOL_NAMESPACE, codemode: true },
      execute: sessionsTool,
    })
  })

  return () => {
    subscription.abort()
  }
}

export type { ValidationCode }
