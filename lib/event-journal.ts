/**
 * event-journal — a small, plugin-scoped, fail-open journal of protocol facts.
 *
 * The session guard keeps its counters in memory: a plugin reload or a server
 * restart loses them, and `tools.orch_uni.session_stats` cannot explain a slice that
 * was closed before the current instance started. This journal persists the few
 * facts a later review actually needs — a reminder was injected, a compaction
 * was confirmed or failed, a slash command ran, a report was validated — in
 * `ctx.storage`, one document per session:
 *
 *   key:   `orchestrator.uni/session-journal/v1/<sessionID>`
 *   value: `{ v: 1, counts: { <kind>: number }, events: JournalEvent[] }`
 *
 * `counts` is an all-time aggregate: it survives ring eviction, so a capped
 * journal still says how many reminders/compactions/commands/validations/loop/
 * artifact facts happened. `events` keeps the newest `maxEvents` entries.
 *
 * The journal stores only whitelisted primitives of the six kinds below. It
 * never stores prompt text, tool arguments, file paths or report bodies: a
 * caller that passes extra fields gets them dropped by `sanitizeEvent`, and the
 * append call sites only pass the documented shape.
 *
 * Everything here is fail-open. A storage failure produces one warning (never a
 * throw), the journal stops writing for the rest of the plugin instance, and
 * `read()` reports `available: false` instead of breaking the session. Writes
 * to one session are serialized through a promise chain, so two events in the
 * same turn cannot lose each other through a read-modify-write race; different
 * sessions are independent. `flush()` awaits every queued write. `read()` returns
 * `available: false` when journaling is off, storage failed, or the session has
 * no journal document yet.
 */
import type { Plugin } from "@opencode/plugin"

/** Storage key prefix; the session id is appended verbatim. */
export const JOURNAL_KEY_PREFIX = "orchestrator.uni/session-journal/v1/"

/** Journal defaults: on, newest 200 events per session. */
export const DEFAULT_SESSION_JOURNAL = {
  enabled: true,
  maxEvents: 200,
} as const

/** Hard ceiling for `options.sessionJournal.maxEvents`; a typo must not grow storage without bound. */
export const MAX_JOURNAL_EVENTS = 10_000

export interface SessionJournalConfig {
  readonly enabled: boolean
  readonly maxEvents: number
}

/** Protocol facts the journal understands; anything else is refused. */
export type JournalKind = "reminder" | "compaction" | "command" | "validation" | "loop" | "artifact"

const KINDS: ReadonlySet<string> = new Set<JournalKind>([
  "reminder",
  "compaction",
  "command",
  "validation",
  "loop",
  "artifact",
])

/** Loop classes reported by the protocol guard. */
export type JournalLoop = "none" | "audit" | "audit+fix"

const LOOPS: ReadonlySet<string> = new Set<JournalLoop>(["none", "audit", "audit+fix"])

const COMMANDS: ReadonlySet<string> = new Set(["handoff", "spec", "agents-md"])

/** Whitelisted event payloads (the journal adds `at` itself). */
export type JournalEventInput =
  | { readonly kind: "reminder"; readonly band: number; readonly compactionCount?: number }
  | {
      readonly kind: "compaction"
      readonly count: number
      readonly limitReached?: boolean
      readonly failed?: boolean
    }
  | {
      readonly kind: "command"
      readonly command: "handoff" | "spec" | "agents-md"
      readonly skipped?: boolean
    }
  | {
      readonly kind: "validation"
      readonly schema: string
      readonly valid: boolean
      readonly code?: string
      readonly errorCount: number
      readonly warningCount: number
    }
  | {
      readonly kind: "loop"
      readonly loop: JournalLoop
      readonly writes: number
      readonly audits: number
      readonly pair: boolean
      readonly fix: boolean
      readonly warning: boolean
    }
  | {
      readonly kind: "artifact"
      readonly handoff: boolean
      readonly state: boolean
      readonly reports: number
      readonly warning: boolean
    }

/** A stored event: the whitelisted payload plus the wall-clock time of the fact. */
export type JournalEvent = JournalEventInput & { readonly at: number }

/** One session's persisted document. */
export interface JournalDocument {
  readonly v: 1
  readonly counts: Readonly<Record<string, number>>
  readonly events: readonly JournalEvent[]
}

/** What `read()` returns; `available: false` means journaling is off or storage failed. */
export interface JournalSnapshot {
  readonly available: boolean
  readonly counts: Readonly<Record<string, number>>
  readonly events: readonly JournalEvent[]
}

type Warn = (message: string) => void

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
}

function safeSchemaId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  // A report-controlled id: keep it a short identifier, never prose/JSON.
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value) ? value : "unknown"
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^E_[A-Z_]{1,40}$/.test(value) ? value : undefined
}

/**
 * Rebuild an event from known fields only. Extra properties (prompt text, tool
 * arguments, paths) are dropped; a malformed or unknown event is refused with
 * `undefined` rather than persisted in a half-valid shape.
 */
export function sanitizeEvent(input: unknown, at: number = Date.now()): JournalEvent | undefined {
  const record = asRecord(input)
  const kind = record?.kind
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined
  if (!Number.isFinite(at)) return undefined
  const timestamp = Math.trunc(at)
  switch (kind as JournalKind) {
    case "reminder": {
      const band = record?.band
      if (!isCount(band)) return undefined
      const compactionCount = record?.compactionCount
      return {
        kind: "reminder",
        at: timestamp,
        band,
        ...(isCount(compactionCount) ? { compactionCount } : {}),
      }
    }
    case "compaction": {
      const count = record?.count
      if (!isCount(count)) return undefined
      const limitReached = record?.limitReached
      const failed = record?.failed
      return {
        kind: "compaction",
        at: timestamp,
        count,
        ...(typeof limitReached === "boolean" ? { limitReached } : {}),
        ...(typeof failed === "boolean" ? { failed } : {}),
      }
    }
    case "command": {
      const command = record?.command
      if (typeof command !== "string" || !COMMANDS.has(command)) return undefined
      const skipped = record?.skipped
      return {
        kind: "command",
        at: timestamp,
        command: command as "handoff" | "spec" | "agents-md",
        ...(typeof skipped === "boolean" ? { skipped } : {}),
      }
    }
    case "validation": {
      const schema = safeSchemaId(record?.schema)
      const valid = record?.valid
      const errorCount = record?.errorCount
      const warningCount = record?.warningCount
      if (schema === undefined || typeof valid !== "boolean" || !isCount(errorCount) || !isCount(warningCount)) {
        return undefined
      }
      const code = safeCode(record?.code)
      return {
        kind: "validation",
        at: timestamp,
        schema,
        valid,
        ...(code === undefined ? {} : { code }),
        errorCount,
        warningCount,
      }
    }
    case "loop": {
      const loop = record?.loop
      const writes = record?.writes
      const audits = record?.audits
      const pair = record?.pair
      const fix = record?.fix
      const warning = record?.warning
      if (
        typeof loop !== "string" ||
        !LOOPS.has(loop) ||
        !isCount(writes) ||
        !isCount(audits) ||
        typeof pair !== "boolean" ||
        typeof fix !== "boolean" ||
        typeof warning !== "boolean"
      ) {
        return undefined
      }
      return { kind: "loop", at: timestamp, loop: loop as JournalLoop, writes, audits, pair, fix, warning }
    }
    case "artifact": {
      const handoff = record?.handoff
      const state = record?.state
      const reports = record?.reports
      const warning = record?.warning
      if (
        typeof handoff !== "boolean" ||
        typeof state !== "boolean" ||
        !isCount(reports) ||
        typeof warning !== "boolean"
      ) {
        return undefined
      }
      return { kind: "artifact", at: timestamp, handoff, state, reports, warning }
    }
  }
  return undefined
}

function emptyDocument(): JournalDocument {
  return { v: 1, counts: {}, events: [] }
}

/** Parse a stored value, dropping anything that is not a valid event/count. */
function parseDocument(raw: unknown): JournalDocument | undefined {
  const record = asRecord(raw)
  if (record === undefined || record.v !== 1) return undefined
  const countsRecord = asRecord(record.counts)
  const counts: Record<string, number> = {}
  if (countsRecord !== undefined) {
    for (const [key, value] of Object.entries(countsRecord)) {
      if (KINDS.has(key) && isCount(value)) counts[key] = value
    }
  }
  const events: JournalEvent[] = []
  if (Array.isArray(record.events)) {
    for (const entry of record.events) {
      const at = asRecord(entry)?.at
      // A stored event without a usable timestamp is dropped rather than revived
      // with "now", which would corrupt the order of a reloaded journal.
      if (typeof at !== "number" || !Number.isFinite(at)) continue
      const event = sanitizeEvent(entry, at)
      if (event !== undefined) events.push(event)
    }
  }
  return { v: 1, counts, events }
}

function journalKey(sessionID: string): string {
  return `${JOURNAL_KEY_PREFIX}${sessionID}`
}

/**
 * Persist protocol events per session. Construct one per plugin instance and
 * pass the same instance to the session guard, the tools and the commands.
 */
export class EventJournal {
  readonly config: SessionJournalConfig
  readonly enabled: boolean
  private readonly storage: Plugin.Context["storage"]
  private readonly warn: Warn
  /** One promise chain per session; keeps read-modify-write ordered. */
  private readonly chains = new Map<string, Promise<void>>()
  private failed = false
  private warned = false

  constructor(
    storage: Plugin.Context["storage"],
    config: SessionJournalConfig = DEFAULT_SESSION_JOURNAL,
    warn: Warn = () => {},
  ) {
    this.storage = storage
    this.config = config
    this.enabled = config.enabled
    this.warn = warn
  }

  /** `false` after the first storage failure: the journal fails open and stays off. */
  get available(): boolean {
    return this.enabled && !this.failed
  }

  private fail(error: unknown): void {
    this.failed = true
    if (!this.warned) {
      this.warned = true
      this.warn(`session journal disabled after a storage error: ${errorMessage(error)}`)
    }
  }

  private enqueue(sessionID: string, operation: () => Promise<void>): Promise<void> {
    if (!this.enabled || this.failed) return Promise.resolve()
    const previous = this.chains.get(sessionID) ?? Promise.resolve()
    // `previous` never rejects (commit swallows), but a defensive catch keeps a
    // broken chain from skipping every later event.
    const next = previous.catch(() => undefined).then(operation)
    this.chains.set(sessionID, next)
    return next.finally(() => {
      if (this.chains.get(sessionID) === next) this.chains.delete(sessionID)
    })
  }

  private async commit(sessionID: string, event: JournalEvent): Promise<void> {
    try {
      const raw = await this.storage.get(journalKey(sessionID))
      const document = parseDocument(raw) ?? emptyDocument()
      const counts = { ...document.counts }
      counts[event.kind] = (counts[event.kind] ?? 0) + 1
      const events = [...document.events, event]
      const maxEvents = this.config.maxEvents
      while (events.length > maxEvents) events.shift()
      await this.storage.set(journalKey(sessionID), { v: 1, counts, events })
    } catch (error) {
      this.fail(error)
    }
  }

  /**
   * Append one whitelisted fact. Serialized with every other write to the same
   * session; a malformed event is ignored. Never throws.
   */
  append(sessionID: string, event: JournalEventInput): Promise<void> {
    if (!this.enabled || this.failed) return Promise.resolve()
    if (typeof sessionID !== "string" || sessionID === "") return Promise.resolve()
    const sanitized = sanitizeEvent(event)
    if (sanitized === undefined) return Promise.resolve()
    return this.enqueue(sessionID, () => this.commit(sessionID, sanitized))
  }

  /** Current journal of one session, after every write already queued. Never throws. */
  async read(sessionID: string): Promise<JournalSnapshot> {
    const empty: JournalSnapshot = { available: false, counts: {}, events: [] }
    if (!this.enabled || this.failed) return empty
    try {
      await this.chains.get(sessionID)
      const raw = await this.storage.get(journalKey(sessionID))
      // No key yet (no facts recorded) is reported as "no journal", not as an
      // error: `available` means there is a readable journal document.
      if (raw === undefined) return empty
      const document = parseDocument(raw)
      if (document === undefined) return empty
      return { available: true, counts: document.counts, events: document.events }
    } catch (error) {
      this.fail(error)
      return empty
    }
  }

  /** Remove one session's journal (called on `session.deleted`). Never throws. */
  clear(sessionID: string): Promise<void> {
    if (!this.enabled || this.failed) return Promise.resolve()
    if (typeof sessionID !== "string" || sessionID === "") return Promise.resolve()
    return this.enqueue(sessionID, async () => {
      try {
        await this.storage.remove(journalKey(sessionID))
      } catch (error) {
        this.fail(error)
      }
    })
  }

  /** Await every queued write; used by tests and on plugin unload. Never throws. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()].map((chain) => chain.catch(() => undefined)))
  }
}

function booleanOption(value: unknown, fallback: boolean, where: string, warn: Warn): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    warn(`${where}: expected a boolean, using ${fallback}`)
    return fallback
  }
  return value
}

function maxEventsOption(value: unknown, warn: Warn): number {
  if (value === undefined) return DEFAULT_SESSION_JOURNAL.maxEvents
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    warn(`options.sessionJournal.maxEvents: expected a number >= 1, using ${DEFAULT_SESSION_JOURNAL.maxEvents}`)
    return DEFAULT_SESSION_JOURNAL.maxEvents
  }
  return Math.min(MAX_JOURNAL_EVENTS, Math.floor(value))
}

/**
 * Parse `options.sessionJournal` by the same rule as `readSessionBudgetOptions`:
 * a bad field is reported and replaced by its default, setup never fails.
 */
export function readSessionJournalOptions(options: unknown, warn: Warn): SessionJournalConfig {
  const root = asRecord(options)
  const journal = asRecord(root?.sessionJournal)
  if (root?.sessionJournal !== undefined && journal === undefined) {
    warn("options.sessionJournal: expected an object, ignored")
  }
  return {
    enabled: booleanOption(journal?.enabled, DEFAULT_SESSION_JOURNAL.enabled, "options.sessionJournal.enabled", warn),
    maxEvents: maxEventsOption(journal?.maxEvents, warn),
  }
}

export type { Warn as SessionJournalWarn }
