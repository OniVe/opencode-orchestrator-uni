/**
 * protocol-guard — loop metric, write attribution and the artifact gate.
 *
 * The kit's process contract says a slice with source edits runs the audit pair
 * (`empiric` + `invariant`) and then `fix-runner`, and ends with a handoff/state
 * artifact and a report. Flat permissions and the write guard can enforce *who*
 * may write *where*; they cannot see whether the cycle actually happened. This
 * module observes the same permission hook (through the write guard's
 * `onEvaluate` seam) and the event stream, and keeps one in-memory snapshot per
 * root session:
 *
 *   loop:    none | audit | audit+fix
 *   writes:  source writes by the root and every descendant (by parent chain)
 *   audits:  empiric/invariant children; pair = both; fix = fix-runner created
 *            at or after the first auditor
 *
 * A source write is an `edit` evaluation whose final effect is not `deny` and
 * whose resource the write guard classifies as source (`decideEdit` → `deny`).
 * Artifact edits, denied edits and shell writes are not counted. The directory
 * is the session's known location, falling back to the setup directory.
 *
 * When a root session goes idle (or reports a terminal execution event), the
 * snapshot is recomputed. If the root has source writes without `audit+fix`
 * (with `requirePair`), or — for a root terminal with writes/audit activity —
 * the artifact gate finds no `handoff-*.md`/`state.md` in the root or
 * `docs/planning/` and no top-level `reports/*.md`, a warning is queued. It is
 * injected **once per root on the next `context` hook**, as one system part; a
 * condition that disappears before delivery is dropped. File names, paths and
 * prompt text never enter the journal, metadata or the warning.
 *
 * Everything is fail-open: a missing event stream or hook API disables the guard
 * for the instance with one warning, a metadata failure is reported once and
 * ignored, and the in-memory snapshot plus the journal survive it.
 *
 * Known limits (documented in `docs/<locale>/reference.md`): sessions created
 * before this instance started are invisible; shell writes are invisible; the
 * host's `session.update` metadata merge and multiple `context` hooks are
 * `not_verified` on a live host.
 */

import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { EventJournal } from "./event-journal"
import { asyncIteratorOf, closeIteratorQuietly, safeJson } from "./session-budget"
import { decideEdit } from "./write-guard"

/** Locales the guard can render its warning in. */
export type ProtocolLocale = "ru" | "en"

/** Loop classes of one root session. */
export type LoopKind = "none" | "audit" | "audit+fix"

/** `options.protocolGuard`; every field has a documented default. */
export interface ProtocolGuardConfig {
  readonly enabled: boolean
  readonly requirePair: boolean
  readonly artifactWarnings: boolean
  readonly maxArtifactEntries: number
}

export const DEFAULT_PROTOCOL_GUARD: ProtocolGuardConfig = {
  enabled: true,
  requirePair: true,
  artifactWarnings: true,
  maxArtifactEntries: 500,
}

/** Hard ceiling for `options.protocolGuard.maxArtifactEntries`. */
export const MAX_ARTIFACT_ENTRIES = 10_000

/** Metadata key the snapshot is stored under. */
export const PROTOCOL_METADATA_KEY = "orchestrator.uni"

/** One root's latest snapshot, as exposed to `session_stats` and metadata. */
export interface ProtocolSnapshot {
  readonly loop: LoopKind
  readonly writes: number
  readonly audits: number
  readonly pair: boolean
  readonly fix: boolean
  readonly handoff: boolean
  readonly state: boolean
  readonly reports: number
  /** `true` when a directory scan hit `maxArtifactEntries` (the gate then stays silent). */
  readonly truncated: boolean
  readonly warnedLoop: boolean
  readonly warnedArtifacts: boolean
  readonly at: number
}

/** Read-only view handed to the tools; keeps the hook state private. */
export interface ProtocolGuardReport {
  readonly available: boolean
  readonly config: ProtocolGuardConfig
  /** Latest snapshot of the root session above `sessionID`; `undefined` before the first root idle. */
  readonly snapshot: (sessionID: string) => Promise<ProtocolSnapshot | undefined>
}

export interface ProtocolGuard extends ProtocolGuardReport {
  readonly cleanup: () => Promise<void>
  /**
   * Observe one `edit` evaluation (already decided by the write guard). Source
   * writes of every agent are counted; denied/artifact writes are not.
   */
  readonly recordWrite: (event: {
    readonly sessionID?: string
    readonly agent?: string
    readonly action: string
    readonly resources: readonly string[]
    readonly effect: "allow" | "deny" | "ask"
  }) => void
}

export interface ProtocolGuardRuntime {
  /** Persisted protocol journal; absent in isolation and in older tests. */
  readonly journal?: EventJournal
}

type Warn = (message: string) => void

interface SessionRecord {
  parentID?: string
  agent?: string
  created: number
  /** Session location, learned from `session.created` or a later `session.get`. */
  directory?: string
}

interface RootState {
  loop: LoopKind
  writes: number
  audits: number
  pair: boolean
  fix: boolean
  handoff: boolean
  state: boolean
  reports: number
  truncated: boolean
  warnedLoop: boolean
  warnedArtifacts: boolean
  pendingLoop: boolean
  pendingArtifacts: boolean
  at: number
  metadataSignature: string
}

interface SessionEventLike {
  readonly id?: string
  readonly type?: string
  readonly created?: number
  readonly durable?: { readonly aggregateID?: string; readonly seq?: number }
  readonly data?: {
    readonly sessionID?: string
    readonly parentID?: string
    readonly agent?: string
    readonly location?: { readonly directory?: string }
  }
}

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

const AUDIT_AGENTS: ReadonlySet<string> = new Set(["empiric", "invariant"])

const FIX_AGENT = "fix-runner"

const HANDOFF_FILE = /^handoff-.*\.md$/i
const STATE_FILE = /^state\.md$/i
const MARKDOWN_FILE = /\.md$/i

/** Dedup windows: terminal events (durable position) and the per-root snapshots. */
const SEEN_TERMINAL_EVENTS = 500

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Normalize an agent id: the kit's legacy `audit-` prefix and the historical
 * `-d` suffix are stripped before comparison (the old auditor ids map back to
 * `empiric`/`invariant`).
 */
export function normalizeAgent(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined
  return value.replace(/^audit-/, "").replace(/-d$/, "")
}

function booleanOption(value: unknown, fallback: boolean, where: string, warn: Warn): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    warn(`${where}: expected a boolean, got ${safeJson(value)}, using ${fallback}`)
    return fallback
  }
  return value
}

function entriesOption(value: unknown, warn: Warn): number {
  if (value === undefined) return DEFAULT_PROTOCOL_GUARD.maxArtifactEntries
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    warn(
      `options.protocolGuard.maxArtifactEntries: expected a number >= 1, using ${DEFAULT_PROTOCOL_GUARD.maxArtifactEntries}`,
    )
    return DEFAULT_PROTOCOL_GUARD.maxArtifactEntries
  }
  return Math.min(MAX_ARTIFACT_ENTRIES, Math.floor(value))
}

/**
 * Parse `options.protocolGuard` by the same rule as `readSessionJournalOptions`:
 * a bad field is reported and replaced by its default, setup never fails.
 */
export function readProtocolGuardOptions(options: unknown, warn: Warn): ProtocolGuardConfig {
  const root = asRecord(options)
  const raw = root?.protocolGuard
  const guard = asRecord(raw)
  if (raw !== undefined && guard === undefined) {
    warn("options.protocolGuard: expected an object, ignored")
  }
  return {
    enabled: booleanOption(guard?.enabled, DEFAULT_PROTOCOL_GUARD.enabled, "options.protocolGuard.enabled", warn),
    requirePair: booleanOption(
      guard?.requirePair,
      DEFAULT_PROTOCOL_GUARD.requirePair,
      "options.protocolGuard.requirePair",
      warn,
    ),
    artifactWarnings: booleanOption(
      guard?.artifactWarnings,
      DEFAULT_PROTOCOL_GUARD.artifactWarnings,
      "options.protocolGuard.artifactWarnings",
      warn,
    ),
    maxArtifactEntries: entriesOption(guard?.maxArtifactEntries, warn),
  }
}

/** `ctx.event.subscribe` is optional at runtime even though the type declares it. */
function eventSubscriber(
  ctx: Plugin.Context,
): ((options: { signal: AbortSignal }) => AsyncIterable<unknown>) | undefined {
  const event = (ctx as { event?: unknown }).event
  if (typeof event !== "object" || event === null) return undefined
  const subscribe = (event as Record<string, unknown>).subscribe
  return typeof subscribe === "function"
    ? (subscribe.bind(event) as (options: { signal: AbortSignal }) => AsyncIterable<unknown>)
    : undefined
}

function emptyState(): RootState {
  return {
    loop: "none",
    writes: 0,
    audits: 0,
    pair: false,
    fix: false,
    handoff: false,
    state: false,
    reports: 0,
    truncated: false,
    warnedLoop: false,
    warnedArtifacts: false,
    pendingLoop: false,
    pendingArtifacts: false,
    at: 0,
    metadataSignature: "",
  }
}

function loopSignature(state: RootState): string {
  return [state.loop, state.writes, state.audits, state.pair, state.fix, state.warnedLoop].join("|")
}

function artifactSignature(state: RootState): string {
  return [state.handoff, state.state, state.reports, state.warnedArtifacts].join("|")
}

function metadataSignature(state: RootState): string {
  return [
    state.loop,
    state.writes,
    state.audits,
    state.pair,
    state.fix,
    state.handoff,
    state.state,
    state.reports,
    state.warnedLoop,
    state.warnedArtifacts,
  ].join("|")
}

function snapshotOf(state: RootState): ProtocolSnapshot {
  return {
    loop: state.loop,
    writes: state.writes,
    audits: state.audits,
    pair: state.pair,
    fix: state.fix,
    handoff: state.handoff,
    state: state.state,
    reports: state.reports,
    truncated: state.truncated,
    warnedLoop: state.warnedLoop,
    warnedArtifacts: state.warnedArtifacts,
    at: state.at,
  }
}

/** One short warning per condition; no paths, file names or user text. */
export function loopWarningText(locale: ProtocolLocale, writes: number): string {
  return locale === "ru"
    ? `Протокол: ${writes} правк(и) вне аудит/артефактных путей без полного цикла (empiric+invariant, затем fix-runner). Проведите обоих аудиторов и закройте находки через fix-runner.`
    : `Protocol: ${writes} edit(s) ran outside audit/artifact paths without the full loop (empiric+invariant, then fix-runner). Run both auditors and close findings with fix-runner.`
}

export function artifactWarningText(locale: ProtocolLocale): string {
  return locale === "ru"
    ? "Протокол: для среза нет артефакта handoff/state и нет отчёта. Закройте срез handoff-артефактом и отчётом."
    : "Protocol: no handoff/state artifact and no report found for this slice. Close it with a handoff and a report."
}

interface ArtifactScan {
  readonly handoff: boolean
  readonly state: boolean
  readonly reports: number
  readonly truncated: boolean
}

/** List file names (sorted) in one directory; an absent/unreadable directory is empty. */
async function listFiles(
  directory: string,
  cap: number,
): Promise<{ readonly names: string[]; readonly truncated: boolean }> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    // ENOENT (or any other read error) means "no artifacts here": the gate must
    // not fabricate a warning from an unreadable directory.
    return { names: [], truncated: false }
  }
  // Only regular files: a symlink/junction is a `Dirent` of another kind and is
  // skipped here; file names are never returned to a caller.
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  return { names: names.slice(0, cap), truncated: names.length > cap }
}

function matchesRootArtifact(names: readonly string[], pattern: RegExp): boolean {
  return names.some((name) => pattern.test(name))
}

/** Shallow artifact gate: root, `docs/planning` and top-level `reports/`. */
async function scanArtifacts(directory: string, cap: number): Promise<ArtifactScan> {
  const root = await listFiles(directory, cap)
  const planning = await listFiles(path.join(directory, "docs", "planning"), cap)
  const reports = await listFiles(path.join(directory, "reports"), cap)
  return {
    handoff: matchesRootArtifact(root.names, HANDOFF_FILE) || matchesRootArtifact(planning.names, HANDOFF_FILE),
    state: matchesRootArtifact(root.names, STATE_FILE) || matchesRootArtifact(planning.names, STATE_FILE),
    reports: reports.names.filter((name) => MARKDOWN_FILE.test(name)).length,
    truncated: root.truncated || planning.truncated || reports.truncated,
  }
}

/** Bound a session lookup so a hung store cannot stall the event loop. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Register the protocol guard. Never throws: a host without the event stream or
 * the session hook API yields a warned no-op, and every later failure is
 * fail-open.
 */
export async function createProtocolGuard(
  ctx: Plugin.Context,
  config: ProtocolGuardConfig = DEFAULT_PROTOCOL_GUARD,
  locale: ProtocolLocale = "en",
  warn: Warn = () => {},
  runtime: ProtocolGuardRuntime = {},
): Promise<ProtocolGuard> {
  const noop = async () => {}
  const noSnapshot = async () => undefined
  if (!config.enabled) {
    return { available: false, config, snapshot: noSnapshot, recordWrite: () => {}, cleanup: noop }
  }
  const subscribe = eventSubscriber(ctx)
  const session = (ctx as { session?: { hook?: unknown; get?: unknown; update?: unknown } }).session
  const sessionHook = session?.hook
  if (subscribe === undefined || typeof sessionHook !== "function") {
    warn("protocol guard disabled: this OpenCode build exposes no event stream or no session context hook API")
    return { available: false, config, snapshot: noSnapshot, recordWrite: () => {}, cleanup: noop }
  }

  const location = (ctx as { location?: { directory?: unknown } }).location?.directory
  // An empty setup location must not turn artifact paths into source writes:
  // `process.cwd()` is the documented fallback for a write attribution.
  const fallbackDirectory = typeof location === "string" && location !== "" ? location : process.cwd()
  const journal = runtime.journal
  /** `sessionID → creation facts`; filled from `session.created`. */
  const sessions = new Map<string, SessionRecord>()
  /** `sessionID → allowed source writes`; summed by parent chain at root idle. */
  const writes = new Map<string, number>()
  const roots = new Map<string, RootState>()
  const seenTerminal = new Set<string>()
  const seenTerminalOrder: string[] = []
  let metadataFailed = false
  let metadataWarned = false
  const metadataChains = new Map<string, Promise<void>>()
  const abort = new AbortController()
  let disposed = false
  let registration: { dispose: () => Promise<void> | void } | undefined

  const stateFor = (rootID: string): RootState => {
    let state = roots.get(rootID)
    if (state === undefined) {
      state = emptyState()
      roots.set(rootID, state)
    }
    return state
  }

  /** Every known parent link above `sessionID`; the topmost id is the root. */
  const rootOf = (sessionID: string): string => {
    let current = sessionID
    const seen = new Set<string>()
    while (!seen.has(current)) {
      seen.add(current)
      const parentID = sessions.get(current)?.parentID
      if (parentID === undefined || parentID === "") return current
      current = parentID
    }
    return current
  }

  const directoryOf = (sessionID: string): string => sessions.get(sessionID)?.directory ?? fallbackDirectory

  /**
   * Read one session's creation facts from the host, bounded and fail-open. A
   * terminal event may arrive without a `session.created` (a session created
   * before this instance started), and a root may carry no agent in the event:
   * both are resolved here before any classification.
   */
  const fetchSession = async (sessionID: string): Promise<SessionRecord | undefined> => {
    const get = session?.get
    if (typeof get !== "function") return sessions.get(sessionID)
    try {
      const info = (await bounded(get.call(session, { sessionID }), 500)) as
        | {
            readonly parentID?: unknown
            readonly agent?: unknown
            readonly location?: { readonly directory?: unknown }
          }
        | null
        | undefined
      if (info === null || info === undefined) return sessions.get(sessionID)
      const record = sessions.get(sessionID) ?? { created: Date.now() }
      sessions.set(sessionID, record)
      if (typeof info.parentID === "string" && info.parentID !== "") record.parentID = info.parentID
      const agent = normalizeAgent(info.agent)
      if (agent !== undefined) record.agent = agent
      const directory = info.location?.directory
      if (typeof directory === "string" && directory !== "") record.directory = directory
      return record
    } catch {
      // Fail-open: a timed-out or failing lookup leaves the known record as is.
      return sessions.get(sessionID)
    }
  }

  /** Known record, or one fetched from the host when `force` is set. */
  const sessionRecord = async (sessionID: string, force = false): Promise<SessionRecord | undefined> => {
    const known = sessions.get(sessionID)
    if (!force && known !== undefined) return known
    return (await fetchSession(sessionID)) ?? known
  }

  /** Resolve a root directory for the artifact gate; a failed lookup is fail-open. */
  const resolveDirectory = async (sessionID: string): Promise<string> => {
    const known = sessions.get(sessionID)?.directory
    if (known !== undefined) return known
    const record = await fetchSession(sessionID)
    return record?.directory ?? fallbackDirectory
  }

  /** Root + every descendant by parent chain (cycle-safe). */
  const writesFor = (rootID: string): number => {
    let total = 0
    for (const [sessionID, count] of writes) {
      let current: string | undefined = sessionID
      const seen = new Set<string>()
      while (current !== undefined && !seen.has(current)) {
        if (current === rootID) {
          total += count
          break
        }
        seen.add(current)
        const parentID: string | undefined = sessions.get(current)?.parentID
        current = parentID === "" ? undefined : parentID
      }
    }
    return total
  }

  const warnMetadata = (message: string): void => {
    metadataFailed = true
    if (metadataWarned) return
    metadataWarned = true
    warn(message)
  }

  const persistMetadata = async (rootID: string, state: RootState): Promise<void> => {
    if (metadataFailed) return
    const get = session?.get
    const update = session?.update
    if (typeof get !== "function" || typeof update !== "function") {
      warnMetadata("protocol guard: session.get/session.update is unavailable; the loop snapshot stops at the journal")
      return
    }
    try {
      const info = (await bounded(get.call(session, { sessionID: rootID }), 500)) as
        | { readonly metadata?: unknown }
        | undefined
      const existing = asRecord(info?.metadata) ?? {}
      const value = {
        loop: state.loop,
        writes: state.writes,
        audits: state.audits,
        pair: state.pair,
        fix: state.fix,
        handoff: state.handoff,
        state: state.state,
        reports: state.reports,
        warnedLoop: state.warnedLoop,
        warnedArtifacts: state.warnedArtifacts,
        at: state.at,
      }
      // Both calls are bounded: a hung metadata store must not hold cleanup (or
      // any queued classification) open.
      await bounded(
        update.call(session, { sessionID: rootID, metadata: { ...existing, [PROTOCOL_METADATA_KEY]: value } }),
        500,
      )
    } catch (error) {
      warnMetadata(`protocol guard: cannot persist the loop snapshot in session metadata: ${errorMessage(error)}`)
    }
  }

  /**
   * Persist on snapshot change only. Writes are serialized per root so two
   * classifications cannot interleave their get/merge/update.
   */
  const scheduleMetadata = (rootID: string, state: RootState): void => {
    if (metadataFailed) return
    const signature = metadataSignature(state)
    if (signature === state.metadataSignature) return
    state.metadataSignature = signature
    const previous = metadataChains.get(rootID) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => persistMetadata(rootID, state))
      .catch(() => undefined)
    metadataChains.set(rootID, next)
    void next.finally(() => {
      if (metadataChains.get(rootID) === next) metadataChains.delete(rootID)
    })
  }

  const appendLoop = (rootID: string, state: RootState): Promise<void> | undefined =>
    journal?.append(rootID, {
      kind: "loop",
      loop: state.loop,
      writes: state.writes,
      audits: state.audits,
      pair: state.pair,
      fix: state.fix,
      warning: state.warnedLoop,
    })

  const appendArtifact = (rootID: string, state: RootState): Promise<void> | undefined =>
    journal?.append(rootID, {
      kind: "artifact",
      handoff: state.handoff,
      state: state.state,
      reports: state.reports,
      warning: state.warnedArtifacts,
    })

  const loopIncomplete = (state: RootState): boolean => {
    if (state.writes <= 0) return false
    return config.requirePair ? state.loop !== "audit+fix" : state.loop === "none"
  }

  /** Recompute the loop from live children; journal and metadata only on change. */
  const updateLoop = async (rootID: string, state: RootState): Promise<void> => {
    const auditAgents = new Set<string>()
    let audits = 0
    let fix = false
    let firstAudit = Number.POSITIVE_INFINITY
    for (const record of sessions.values()) {
      if (record.parentID !== rootID) continue
      const agent = normalizeAgent(record.agent)
      if (agent === undefined || !AUDIT_AGENTS.has(agent)) continue
      auditAgents.add(agent)
      audits += 1
      if (record.created < firstAudit) firstAudit = record.created
    }
    for (const record of sessions.values()) {
      if (record.parentID !== rootID) continue
      if (normalizeAgent(record.agent) !== FIX_AGENT) continue
      if (record.created >= firstAudit) fix = true
    }
    const pair = auditAgents.size === AUDIT_AGENTS.size
    const kind: LoopKind = pair && fix ? "audit+fix" : audits > 0 ? "audit" : "none"
    const before = loopSignature(state)
    state.loop = kind
    state.writes = writesFor(rootID)
    state.audits = audits
    state.pair = pair
    state.fix = fix
    state.pendingLoop = state.warnedLoop ? false : loopIncomplete(state)
    const after = loopSignature(state)
    if (after === before) return
    state.at = Date.now()
    await appendLoop(rootID, state)
  }

  /** Shallow artifact gate for a root terminal; silent on truncation. */
  const updateArtifacts = async (rootID: string, state: RootState): Promise<void> => {
    if (!config.artifactWarnings) {
      state.pendingArtifacts = false
      return
    }
    if (state.writes <= 0 && state.loop === "none") {
      state.pendingArtifacts = false
      return
    }
    const directory = await resolveDirectory(rootID)
    const scan = await scanArtifacts(directory, config.maxArtifactEntries)
    const before = artifactSignature(state)
    state.handoff = scan.handoff
    state.state = scan.state
    state.reports = scan.reports
    state.truncated = scan.truncated
    // A truncated listing may hide the very files the gate looks for: never
    // turn an incomplete scan into a warning.
    const missing = !scan.handoff && !scan.state && scan.reports === 0 && !scan.truncated
    state.pendingArtifacts = missing && !state.warnedArtifacts
    const after = artifactSignature(state)
    if (after === before) return
    state.at = Date.now()
    await appendArtifact(rootID, state)
  }

  const classifyRoot = async (rootID: string): Promise<void> => {
    const state = stateFor(rootID)
    await updateLoop(rootID, state)
    await updateArtifacts(rootID, state)
    scheduleMetadata(rootID, state)
  }

  const rememberTerminal = (event: SessionEventLike): boolean => {
    const id = typeof event.id === "string" && event.id !== "" ? event.id : undefined
    const durable = event.durable
    const key =
      id ??
      (typeof durable?.aggregateID === "string" && typeof durable.seq === "number"
        ? `${durable.aggregateID}:${durable.seq}`
        : undefined)
    if (key === undefined) return true
    if (seenTerminal.has(key)) return false
    seenTerminal.add(key)
    seenTerminalOrder.push(key)
    if (seenTerminalOrder.length > SEEN_TERMINAL_EVENTS) {
      const oldest = seenTerminalOrder.shift()
      if (oldest !== undefined) seenTerminal.delete(oldest)
    }
    return true
  }

  const handleEvent = async (event: SessionEventLike): Promise<void> => {
    const type = event.type
    const data = event.data
    if (type === undefined || data === undefined) return
    const sessionID = data.sessionID
    if (typeof sessionID !== "string" || sessionID === "") return
    if (type === "session.created") {
      const parentID = typeof data.parentID === "string" && data.parentID !== "" ? data.parentID : undefined
      const created = typeof event.created === "number" && Number.isFinite(event.created) ? event.created : Date.now()
      const directory =
        typeof data.location?.directory === "string" && data.location.directory !== ""
          ? data.location.directory
          : undefined
      const record = sessions.get(sessionID) ?? { created }
      const agent = normalizeAgent(data.agent)
      // Upsert: a repeated creation event must not lose a learned location.
      sessions.set(sessionID, {
        ...record,
        ...(parentID === undefined ? {} : { parentID }),
        ...(agent === undefined ? {} : { agent }),
        created,
        ...(directory === undefined ? {} : { directory }),
      })
      return
    }
    if (type === "session.deleted") {
      sessions.delete(sessionID)
      writes.delete(sessionID)
      roots.delete(sessionID)
      return
    }
    if (!TERMINAL_EVENTS.has(type)) return
    // Children's terminal events do not classify: only a parentless orchestrator
    // session is a root end-of-turn. Child writes are already attributed by
    // parent chain.
    let record = sessions.get(sessionID)
    if (record?.parentID !== undefined && record.parentID !== "") return
    // A session created before this instance started has no `session.created`:
    // ask the host for parentID/agent/location before deciding root vs child.
    if (record === undefined || record.agent === undefined) {
      record = (await sessionRecord(sessionID, true)) ?? record
    }
    if (record?.parentID !== undefined && record.parentID !== "") return
    // P1 is the orchestrator's metric only: build/general/plan roots must not
    // emit warnings or journal/metadata snapshots.
    if (normalizeAgent(record?.agent) !== "orchestrator") return
    if (!rememberTerminal(event)) return
    await classifyRoot(sessionID)
  }

  /** Inject queued warnings into the root's next context, as one system part. */
  const onContext = async (input: unknown): Promise<void> => {
    const payload = input as
      | { readonly sessionID?: unknown; readonly system?: Array<{ type: "text"; text: string }> }
      | null
      | undefined
    if (payload === null || payload === undefined) return
    const sessionID = payload.sessionID
    if (typeof sessionID !== "string" || sessionID === "") return
    // Only the root's own request consumes its warning: a child's context must
    // not steal it from the root.
    const rootID = rootOf(sessionID)
    if (rootID !== sessionID) return
    const state = roots.get(rootID)
    if (state === undefined) return
    try {
      // Recompute before delivery: a condition that disappeared (the fix-runner
      // finished, the handoff appeared) drops the pending note instead of lying.
      await updateLoop(rootID, state)
      if (state.pendingArtifacts) await updateArtifacts(rootID, state)
      const parts: string[] = []
      if (state.pendingLoop) parts.push(loopWarningText(locale, state.writes))
      if (state.pendingArtifacts) parts.push(artifactWarningText(locale))
      if (parts.length === 0) return
      const system = payload.system
      if (!Array.isArray(system)) return
      // All warnings in one part: one text block, one delivery point.
      system.push({ type: "text", text: parts.join("\n") })
      // Flags move only after the push succeeded: a rejected push keeps the
      // warning queued for the next request.
      if (state.pendingLoop) {
        state.pendingLoop = false
        state.warnedLoop = true
        state.at = Date.now()
        void appendLoop(rootID, state)
      }
      if (state.pendingArtifacts) {
        state.pendingArtifacts = false
        state.warnedArtifacts = true
        state.at = Date.now()
        void appendArtifact(rootID, state)
      }
      scheduleMetadata(rootID, state)
    } catch {
      // Fail-open: the guard must never break a request.
    }
  }

  try {
    registration = await sessionHook.call(session, "context", onContext)
  } catch (error) {
    warn(`protocol guard disabled: cannot register the context hook: ${errorMessage(error)}`)
    return { available: false, config, snapshot: noSnapshot, recordWrite: () => {}, cleanup: noop }
  }

  try {
    const stream = subscribe({ signal: abort.signal })
    void (async () => {
      const aborted = new Promise<"aborted">((resolve) => {
        const signal = abort.signal
        if (signal.aborted) {
          resolve("aborted")
          return
        }
        signal.addEventListener("abort", () => resolve("aborted"), { once: true })
      })
      let iterator: AsyncIterator<unknown> | undefined
      try {
        iterator = asyncIteratorOf(stream)
        while (true) {
          const step = await Promise.race([iterator.next(), aborted])
          if (step === "aborted") break
          if (step.done === true) break
          const event = step.value as SessionEventLike | null | undefined
          if (event === null || event === undefined) continue
          try {
            await handleEvent(event)
          } catch {
            // A single malformed event must not kill the stream.
          }
        }
      } catch {
        // Subscription ended or the server went away; the in-memory snapshot stays.
      } finally {
        closeIteratorQuietly(iterator)
      }
    })().catch(() => {
      // Last barrier: no path may surface as an unhandled rejection.
    })
  } catch (error) {
    warn(`protocol guard disabled: cannot subscribe to events: ${errorMessage(error)}`)
    try {
      if (registration !== undefined) await registration.dispose()
    } catch {
      // best effort
    }
    return { available: false, config, snapshot: noSnapshot, recordWrite: () => {}, cleanup: noop }
  }

  const recordWrite: ProtocolGuard["recordWrite"] = (event) => {
    try {
      if (event.action !== "edit" || event.effect === "deny") return
      const sessionID = event.sessionID
      if (typeof sessionID !== "string" || sessionID === "") return
      const directory = directoryOf(sessionID)
      let count = 0
      for (const resource of event.resources) {
        // `deny` here means a source path for the write guard; `allow` is an
        // artifact, and an orchestrator source edit already ended as `deny`.
        if (decideEdit(resource, directory) === "deny") count += 1
      }
      if (count === 0) return
      writes.set(sessionID, (writes.get(sessionID) ?? 0) + count)
    } catch {
      // Fail-open: observation must never affect the guarded edit.
    }
  }

  return {
    available: true,
    config,
    recordWrite,
    snapshot: async (sessionID: string): Promise<ProtocolSnapshot | undefined> => {
      if (disposed) return undefined
      const state = roots.get(rootOf(sessionID))
      return state === undefined ? undefined : snapshotOf(state)
    },
    cleanup: async () => {
      // Idempotent: a repeated cleanup must not dispose twice.
      if (disposed) return
      disposed = true
      abort.abort()
      try {
        await registration?.dispose()
      } catch {
        // best effort
      }
      await Promise.allSettled([...metadataChains.values()])
      sessions.clear()
      writes.clear()
      roots.clear()
      seenTerminal.clear()
      seenTerminalOrder.length = 0
    },
  }
}

export type { Warn as ProtocolGuardWarn }
