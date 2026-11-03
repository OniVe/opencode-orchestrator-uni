/**
 * session-budget — the kit's session protocol as runtime behaviour.
 *
 * The process documents describe how to keep a session healthy: a session is one
 * slice with a measurable DoD, the prompt budget is bounded, a compaction is a
 * stop signal, tool output belongs in a file rather than in context, and a
 * handoff is written before the next session starts. Prose alone does not hold:
 * a long-running root drifts past the budget silently. This module makes the
 * protocol observable and, where it is safe, enforced:
 *
 * - `session.context`  — estimate the prompt (system + messages), keep counters,
 *   and, when the estimate crosses a budget band or a compaction just happened,
 *   append one short reminder to the request's system parts. The reminder text is
 *   constant within a band, so prefix caching is not broken on every turn;
 * - `session.compaction` — count compactions; the next request carries a note
 *   that a compaction is lossy and the decisions must be pinned to a file;
 * - `tool.execute.after` — cap the model-facing content of configured tools.
 *   The full output is written to a temp file; the model gets a head plus the
 *   path. Only tools that produce read-only text (shell/bash/webfetch by
 *   default) are capped — `read`, `execute` (Code Mode), edit tools and the
 *   kit's own tools keep their contract.
 *
 * Everything here is fail-open: a hook error leaves the request/tool result
 * untouched and increments `errors`, because a broken guard must never break the
 * session it tries to protect. Counters are in-memory and scoped to one plugin
 * instance; `orch_uni_session_stats` exposes them to the orchestrator.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Locale } from "../index"

/** Session guard defaults: 150k estimated prompt tokens, at most one compaction. */
export const DEFAULT_SESSION_GUARD = {
  enabled: true,
  promptTokensSoft: 150_000,
  maxCompactions: 1,
} as const

/** Tool-output guard defaults: read-only text tools, 20k chars, 4k head kept. */
export const DEFAULT_TOOL_OUTPUT_GUARD = {
  enabled: true,
  maxChars: 20_000,
  headChars: 4_000,
  tools: ["shell", "bash", "webfetch"],
} as const

export interface SessionGuardConfig {
  readonly enabled: boolean
  readonly promptTokensSoft: number
  readonly maxCompactions: number
}

export interface ToolOutputGuardConfig {
  readonly enabled: boolean
  readonly maxChars: number
  readonly headChars: number
  readonly tools: readonly string[]
}

export interface SessionBudgetConfig {
  readonly session: SessionGuardConfig
  readonly toolOutput: ToolOutputGuardConfig
}

/** Counters of one session, as exposed by `orch_uni_session_stats`. */
export interface SessionBudgetCounters {
  readonly sessionID: string
  readonly requests: number
  readonly promptTokensLast: number
  readonly promptTokensMax: number
  readonly promptTokensMedian: number
  readonly band: number
  readonly compactions: number
  readonly reminders: number
  readonly toolCalls: number
  readonly outputsCapped: number
  readonly outputCharsSaved: number
  readonly errors: number
}

interface MutableCounters {
  sessionID: string
  requests: number
  promptTokensLast: number
  promptTokensMax: number
  samples: number[]
  band: number
  compactions: number
  pendingCompaction: number
  reminders: number
  toolCalls: number
  outputsCapped: number
  outputCharsSaved: number
  errors: number
}

/** Read-only view handed to the tools; keeps the hook state private. */
export interface SessionBudgetReport {
  readonly config: SessionBudgetConfig
  readonly stats: (sessionID: string) => SessionBudgetCounters
}

export interface SessionBudget extends SessionBudgetReport {
  readonly cleanup: Plugin.Cleanup
}

const DEFAULT_CONFIG: SessionBudgetConfig = {
  session: DEFAULT_SESSION_GUARD,
  toolOutput: DEFAULT_TOOL_OUTPUT_GUARD,
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finiteNumber(value: unknown, fallback: number, min: number, where: string, warn: Warn): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    warn(`${where}: expected a number >= ${min}, got ${JSON.stringify(value)}, using ${fallback}`)
    return fallback
  }
  return value
}

function booleanOption(value: unknown, fallback: boolean, where: string, warn: Warn): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    warn(`${where}: expected a boolean, got ${JSON.stringify(value)}, using ${fallback}`)
    return fallback
  }
  return value
}

type Warn = (message: string) => void

/**
 * Parse `options.sessionGuard` / `options.toolOutputGuard` from the plugin
 * entry. Invalid fields are reported and replaced by the defaults; the guard
 * never fails setup because of a typo in the config.
 */
export function readSessionBudgetOptions(options: unknown, warn: Warn): SessionBudgetConfig {
  const root = asRecord(options)
  const sessionRaw = asRecord(root?.sessionGuard)
  const outputRaw = asRecord(root?.toolOutputGuard)
  if (root?.sessionGuard !== undefined && sessionRaw === undefined) {
    warn("options.sessionGuard: expected an object, ignored")
  }
  if (root?.toolOutputGuard !== undefined && outputRaw === undefined) {
    warn("options.toolOutputGuard: expected an object, ignored")
  }

  const session: SessionGuardConfig = {
    enabled: booleanOption(sessionRaw?.enabled, DEFAULT_SESSION_GUARD.enabled, "options.sessionGuard.enabled", warn),
    promptTokensSoft: finiteNumber(
      sessionRaw?.promptTokensSoft,
      DEFAULT_SESSION_GUARD.promptTokensSoft,
      1000,
      "options.sessionGuard.promptTokensSoft",
      warn,
    ),
    maxCompactions: Math.max(
      0,
      Math.floor(
        finiteNumber(
          sessionRaw?.maxCompactions,
          DEFAULT_SESSION_GUARD.maxCompactions,
          0,
          "options.sessionGuard.maxCompactions",
          warn,
        ),
      ),
    ),
  }

  let tools: readonly string[] = DEFAULT_TOOL_OUTPUT_GUARD.tools
  if (outputRaw?.tools !== undefined) {
    if (Array.isArray(outputRaw.tools) && outputRaw.tools.every((item) => typeof item === "string" && item !== "")) {
      tools = [...outputRaw.tools]
    } else {
      warn(
        `options.toolOutputGuard.tools: expected an array of non-empty strings, got ${JSON.stringify(outputRaw.tools)}, using ${DEFAULT_TOOL_OUTPUT_GUARD.tools.join("|")}`,
      )
    }
  }

  const maxChars = finiteNumber(
    outputRaw?.maxChars,
    DEFAULT_TOOL_OUTPUT_GUARD.maxChars,
    100,
    "options.toolOutputGuard.maxChars",
    warn,
  )
  const headChars = finiteNumber(
    outputRaw?.headChars,
    DEFAULT_TOOL_OUTPUT_GUARD.headChars,
    0,
    "options.toolOutputGuard.headChars",
    warn,
  )

  return {
    session,
    toolOutput: {
      enabled: booleanOption(
        outputRaw?.enabled,
        DEFAULT_TOOL_OUTPUT_GUARD.enabled,
        "options.toolOutputGuard.enabled",
        warn,
      ),
      maxChars,
      headChars: Math.min(headChars, maxChars),
      tools,
    },
  }
}

/** Rough token estimate of any JSON-ish value: text characters / 3.3. */
export function estimateTokens(value: unknown): number {
  return Math.round(countChars(value, new Set()) / 3.3)
}

function countChars(value: unknown, seen: Set<object>): number {
  if (typeof value === "string") return value.length
  if (typeof value !== "object" || value === null) return 0
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (seen.has(value)) return 0
  seen.add(value)
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += countChars(item, seen)
    return total
  }
  let total = 0
  for (const item of Object.values(value as Record<string, unknown>)) total += countChars(item, seen)
  return total
}

function reminderText(locale: Locale, band: number, config: SessionBudgetConfig): string {
  const soft = Math.round(config.session.promptTokensSoft / 1000)
  const max = config.toolOutput.maxChars
  if (locale === "ru") {
    return (
      `[Гигиена сессии] Оценка контекста выше бюджета (уровень ${band}×${soft}k токенов). ` +
      "Закрой срез сейчас: handoff по session-discipline.md → коммит → новая сессия. " +
      `Батчинг: ≥3 независимых команд за ход; вывод больше ${max} символов — в файл.`
    )
  }
  return (
    `[Session hygiene] Estimated context is above the budget (level ${band}×${soft}k tokens). ` +
    "Close the slice now: handoff per session-discipline.md → commit → new session. " +
    `Batch: ≥3 independent commands per turn; output over ${max} chars → file.`
  )
}

function compactionText(locale: Locale, count: number, config: SessionBudgetConfig): string {
  const max = config.session.maxCompactions
  const over = count >= max
  if (locale === "ru") {
    return (
      `[Гигиена сессии] Компакция #${count} (лимит ${max}). Компакция lossy: зафиксируй решения, риски и следующий шаг в handoff; ` +
      `не полагайся на пересказ.${over ? " Лимит исчерпан — новая сессия обязательна." : ""}`
    )
  }
  return (
    `[Session hygiene] Compaction #${count} (limit ${max}). Compaction is lossy: pin decisions, risks and the next step ` +
    `to the handoff; do not trust the summary.${over ? " Limit reached — start a new session." : ""}`
  )
}

interface ToolContentText {
  readonly type: "text"
  readonly text: string
}

interface ToolContentFile {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

type ToolContent = ToolContentText | ToolContentFile

/** Model-facing text of a tool result: a string or the text parts of an array. */
export function toolResultText(content: string | ReadonlyArray<ToolContent> | undefined): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is ToolContentText => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/** Replace the model-facing text, keeping file parts (images, attachments) intact. */
function cappedContent(
  content: string | ReadonlyArray<ToolContent>,
  stub: string,
): string | ReadonlyArray<ToolContent> {
  if (typeof content === "string") return stub
  const files = content.filter((part): part is ToolContentFile => part.type === "file")
  return [{ type: "text", text: stub }, ...files]
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "x"
}

function emptyCounters(sessionID: string): SessionBudgetCounters {
  return {
    sessionID,
    requests: 0,
    promptTokensLast: 0,
    promptTokensMax: 0,
    promptTokensMedian: 0,
    band: 0,
    compactions: 0,
    reminders: 0,
    toolCalls: 0,
    outputsCapped: 0,
    outputCharsSaved: 0,
    errors: 0,
  }
}

/** Median of a small sample window; `0` for an empty window. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!
}

/** Where a capped output is stored: a temp directory, never the workspace. */
export function outputPath(sessionID: string, callID: string): string {
  return path.join(tmpdir(), "opencode-tool-output", safeSegment(sessionID), `${safeSegment(callID)}.txt`)
}

/**
 * Register the three hooks. The returned `stats` reports one session's counters;
 * `cleanup` disposes every registration (safe to call twice). A host without the
 * V2 hook domains degrades to counters only: the guard is a policy layer, it must
 * never be the reason a plugin fails to load.
 */
export async function createSessionBudget(
  ctx: Plugin.Context,
  config: SessionBudgetConfig = DEFAULT_CONFIG,
  locale: Locale = "en",
  warn: (message: string) => void = () => {},
): Promise<SessionBudget> {
  const sessionHook = ctx.session?.hook
  const toolHook = ctx.tool?.hook
  if (typeof sessionHook !== "function" || typeof toolHook !== "function") {
    warn("session guard disabled: this OpenCode build exposes no session/tool hook API")
    return { config, cleanup: async () => {}, stats: emptyCounters }
  }

  const states = new Map<string, MutableCounters>()
  const stateFor = (sessionID: string): MutableCounters => {
    let state = states.get(sessionID)
    if (state === undefined) {
      state = {
        sessionID,
        requests: 0,
        promptTokensLast: 0,
        promptTokensMax: 0,
        samples: [],
        band: 0,
        compactions: 0,
        pendingCompaction: 0,
        reminders: 0,
        toolCalls: 0,
        outputsCapped: 0,
        outputCharsSaved: 0,
        errors: 0,
      }
      states.set(sessionID, state)
    }
    return state
  }

  const registrations: { dispose: () => Promise<void> | void }[] = []

  try {
    registrations.push(
      await ctx.session.hook("context", (input) => {
        const state = stateFor(String(input.sessionID))
        try {
          state.requests += 1
          const tokens = estimateTokens(input.system) + estimateTokens(input.messages)
          state.promptTokensLast = tokens
          if (tokens > state.promptTokensMax) state.promptTokensMax = tokens
          state.samples.push(tokens)
          if (state.samples.length > 256) state.samples.shift()
          if (!config.session.enabled) return

          const parts: string[] = []
          const band = Math.floor(tokens / config.session.promptTokensSoft)
          if (band > state.band) {
            state.band = band
            parts.push(reminderText(locale, band, config))
          }
          if (state.pendingCompaction > 0) {
            parts.push(compactionText(locale, state.pendingCompaction, config))
            state.pendingCompaction = 0
          }
          if (parts.length === 0) return
          input.system.push(...parts.map((text) => ({ type: "text" as const, text })))
          state.reminders += parts.length
        } catch {
          state.errors += 1
        }
      }),
    )

    registrations.push(
      await ctx.session.hook("compaction", (input) => {
        const state = stateFor(String(input.sessionID))
        try {
          state.compactions += 1
          state.pendingCompaction = state.compactions
        } catch {
          state.errors += 1
        }
      }),
    )

    registrations.push(
      await ctx.tool.hook("execute.after", async (input) => {
        const state = stateFor(String(input.sessionID))
        try {
          state.toolCalls += 1
          if (input.status !== "completed") return
          if (!config.toolOutput.enabled) return
          const tool = String(input.tool).toLowerCase()
          const name = tool.includes(".") ? tool.slice(tool.lastIndexOf(".") + 1) : tool
          if (!config.toolOutput.tools.includes(name)) return

          const result = input.result as {
            content?: string | ReadonlyArray<ToolContent>
            metadata?: Record<string, unknown>
          }
          const text = toolResultText(result.content)
          if (text.length <= config.toolOutput.maxChars) return

          const file = outputPath(String(input.sessionID), String(input.id))
          const head = text.slice(0, config.toolOutput.headChars)
          // Write first: a failed write must leave the original result untouched.
          try {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(file, text, "utf8")
          } catch {
            state.errors += 1
            return
          }
          const stub = `${head}\n\n[... ${text.length} chars total; showing first ${head.length}; full output: ${file}]\n`
          result.content = cappedContent(result.content as string | ReadonlyArray<ToolContent>, stub)
          result.metadata = {
            ...(result.metadata ?? {}),
            toolOutputGuard: { chars: text.length, path: file },
          }
          state.outputsCapped += 1
          state.outputCharsSaved += Math.max(0, text.length - head.length)
        } catch {
          state.errors += 1
        }
      }),
    )
  } catch (error) {
    warn(`session guard disabled: hook registration failed (${errorMessage(error)})`)
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose()
      } catch {
        // best effort: a failed disposal must not mask the original failure
      }
    }
    registrations.length = 0
  }

  let disposed = false
  const cleanup: Plugin.Cleanup = async () => {
    if (disposed) return
    disposed = true
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose()
      } catch {
        // A failing disposal must not prevent the other hooks from being removed.
      }
    }
  }

  return {
    config,
    cleanup,
    stats: (sessionID: string): SessionBudgetCounters => {
      const state = states.get(sessionID)
      if (state === undefined) return emptyCounters(sessionID)
      return {
        sessionID: state.sessionID,
        requests: state.requests,
        promptTokensLast: state.promptTokensLast,
        promptTokensMax: state.promptTokensMax,
        promptTokensMedian: median(state.samples),
        band: state.band,
        compactions: state.compactions,
        reminders: state.reminders,
        toolCalls: state.toolCalls,
        outputsCapped: state.outputsCapped,
        outputCharsSaved: state.outputCharsSaved,
        errors: state.errors,
      }
    },
  }
}
