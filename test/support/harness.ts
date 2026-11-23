/**
 * Mock plugin context for the tool tests.
 *
 * Mimics OpenCode 2.0.x: `ctx.tool.transform` runs synchronously with an editor
 * that records `namespace`/`add` calls, `ctx.storage` is an in-process map,
 * `ctx.event.subscribe` is a push-driven async iterable, and `ctx.session` can
 * be given a `list`/`get` surface (the live build has `get` but no `list`).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { EventJournal } from "../../lib/event-journal"
import type { ProtocolGuardReport } from "../../lib/protocol-guard"
import type { SessionBudgetReport } from "../../lib/session-budget"
import { COMPATIBILITY_VALIDATE_REPORT, registerAuditTools, SESSION_INDEX_KEY, TOOL_NAMESPACE } from "../../lib/tools"

export interface ToolRecord {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly options?: { readonly namespace?: string; readonly codemode?: boolean }
  readonly execute: (input: unknown, context: unknown) => Promise<{ content: string }>
}

export interface HarnessOptions {
  /** Session API surface: `get` and/or `list`. Defaults to `get` only. */
  readonly sessions?: Record<string, unknown>
  /** Pre-seeded session index (`childID → parentID`). */
  readonly index?: Record<string, string>
  /** Reuse an existing storage map (to test the persisted index). */
  readonly storage?: Map<string, unknown>
  /** Set to false to simulate a build without an event stream. */
  readonly events?: boolean
  readonly sessionID?: string
  /** Directory to read `schemas/*.json` from (defaults to the shipped schemas). */
  readonly schemasDirectory?: string
  /** Session-budget report wired into `orch_uni_session_stats` (absent = E_UNAVAILABLE). */
  readonly sessionBudget?: SessionBudgetReport
  /** Protocol guard snapshot wired into `session_stats.protocol`. */
  readonly protocolGuard?: ProtocolGuardReport
  /** Persisted protocol journal, shared with the tools. */
  readonly journal?: EventJournal
  /** Reject every namespace-less `editor.add` (the compatibility alias). */
  readonly rejectFlatTool?: boolean
  /** Warning sink for the tool registration. */
  readonly warn?: (message: string) => void
}

export interface Harness {
  readonly directory: string
  readonly sessionID: string
  readonly tools: Map<string, ToolRecord>
  readonly namespaces: { readonly name: string; readonly description: string }[]
  readonly storage: Map<string, unknown>
  readonly journal: EventJournal | undefined
  pushEvent(event: unknown): void
  drain(): Promise<void>
  indexEntries(): Record<string, string>
  readonly aborted: boolean
  dispose(): void
}

/** Push-driven async iterable: events are yielded as they are pushed. */
class EventStream {
  private readonly queue: unknown[] = []
  private waiting: ((value: IteratorResult<unknown>) => void) | null = null
  private closed = false
  pushed = 0
  consumed = 0

  push(event: unknown): void {
    this.pushed += 1
    this.deliver({ value: event, done: false })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.deliver({ value: undefined, done: true })
  }

  private deliver(result: IteratorResult<unknown>): void {
    const waiting = this.waiting
    if (waiting !== null) {
      this.waiting = null
      waiting(result)
      return
    }
    if (!result.done) this.queue.push(result.value)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.closed || this.queue.length > 0) {
      if (this.queue.length > 0) {
        this.consumed += 1
        yield this.queue.shift() as unknown
        continue
      }
      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiting = resolve
      })
      if (next.done) return
      this.consumed += 1
      yield next.value
    }
  }
}

/** Plugin-shaped storage over a plain map (the journal requires remove/scan too). */
export function memoryStorage(map: Map<string, unknown>): Plugin.Context["storage"] {
  return {
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    remove: async (key: string) => {
      map.delete(key)
    },
    scan: async () => ({ entries: [] }),
  } as unknown as Plugin.Context["storage"]
}

/** Canonical effective name: `<namespace>.<name>`; flat only without a namespace. */
function effectiveName(namespace: string | undefined, name: string): string {
  return namespace === undefined ? name : `${namespace}.${name}`
}

/** Flat `orch_uni_<name>` → canonical `orch_uni.<name>`; the alias keeps its flat name. */
function canonicalFromFlat(id: string): string | undefined {
  if (id === COMPATIBILITY_VALIDATE_REPORT) return undefined
  const prefix = `${TOOL_NAMESPACE}_`
  return id.startsWith(prefix) ? `${TOOL_NAMESPACE}.${id.slice(prefix.length)}` : undefined
}

/**
 * Tool map keyed by canonical effective names. `get`/`has` also answer for a
 * legacy flat name (`orch_uni_sessions`) so older tests keep addressing the
 * same tool; the flat compatibility alias has its own exact entry.
 */
class ToolRegistry extends Map<string, ToolRecord> {
  override get(id: string): ToolRecord | undefined {
    return super.get(id) ?? super.get(canonicalFromFlat(id) ?? "")
  }

  override has(id: string): boolean {
    return super.has(id) || super.has(canonicalFromFlat(id) ?? "")
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "audit-tools-"))
  const sessionID = options.sessionID ?? "ses_caller"
  const tools = new ToolRegistry()
  const namespaces: { name: string; description: string }[] = []
  const storage = options.storage ?? new Map<string, unknown>()
  if (options.index !== undefined) {
    storage.set(SESSION_INDEX_KEY, { version: 1, children: { ...options.index } })
  }
  const stream = new EventStream()
  let subscriptionSignal: AbortSignal | undefined

  const context = {
    location: { directory, project: { id: "test", directory, canonical: directory } },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    event:
      options.events === false
        ? {}
        : {
            subscribe: (requestOptions?: { signal?: AbortSignal }) => {
              subscriptionSignal = requestOptions?.signal
              requestOptions?.signal?.addEventListener("abort", () => stream.close())
              return stream
            },
          },
    session: options.sessions ?? { get: async (input: { sessionID: string }) => ({ id: input.sessionID }) },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: (namespace: { name: string; description: string }) => {
            namespaces.push(namespace)
          },
          add: (tool: ToolRecord & { options?: { namespace?: string } }) => {
            if (options.rejectFlatTool === true && tool.options?.namespace === undefined) {
              throw new Error("this host rejects namespace-less tool registration")
            }
            tools.set(effectiveName(tool.options?.namespace, tool.name), tool)
          },
          list: () => [...tools.values()],
          get: (id: string) => tools.get(id),
          update: () => {},
          remove: (id: string) => {
            tools.delete(id)
          },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await registerAuditTools(context, {
    ...(options.schemasDirectory === undefined ? {} : { schemasDirectory: options.schemasDirectory }),
    ...(options.sessionBudget === undefined ? {} : { sessionBudget: options.sessionBudget }),
    ...(options.protocolGuard === undefined ? {} : { protocolGuard: options.protocolGuard }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  })

  return {
    directory,
    sessionID,
    tools,
    namespaces,
    storage,
    journal: options.journal,
    pushEvent: (event: unknown) => stream.push(event),
    drain: async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (stream.consumed === stream.pushed && stream.pushed > 0) {
          for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      throw new Error("event drain timed out")
    },
    indexEntries: () => {
      const document = storage.get(SESSION_INDEX_KEY) as { children?: Record<string, string> } | undefined
      return { ...(document?.children ?? {}) }
    },
    get aborted() {
      return subscriptionSignal?.aborted ?? false
    },
    dispose: () => {
      cleanup()
      void rm(directory, { recursive: true, force: true })
    },
  }
}

/** Call a tool executor and parse its JSON body. Canonical names are preferred. */
export async function runTool(
  harness: Harness,
  name: string,
  input: unknown,
  exact = false,
): Promise<Record<string, unknown>> {
  const resolved = exact ? name : (canonicalFromFlat(name) ?? name)
  const tool = harness.tools.get(resolved)
  if (tool === undefined) throw new Error(`tool ${resolved} is not registered`)
  const result = await tool.execute(input, { signal: new AbortController().signal, sessionID: harness.sessionID })
  return JSON.parse(result.content) as Record<string, unknown>
}
