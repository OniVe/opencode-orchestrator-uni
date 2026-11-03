/**
 * Session-budget hooks: the protocol is enforced where it is safe and merely
 * observed everywhere else.
 *
 * The tests exercise the hooks with a fake plugin context, because the live host
 * is not available in unit tests: a context request over the token budget gets
 * one reminder per band, a completed compaction is counted and reported on the
 * next request, a failed one only increments `compactionFailures`, and a large
 * tool result is capped with the full text written to a temp file. The
 * `orch_uni_session_stats` tool is checked through the shared tools harness,
 * including the `E_UNAVAILABLE` and `E_NOT_FOUND` paths.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  compactionLimitReached,
  createSessionBudget,
  DEFAULT_SESSION_GUARD,
  DEFAULT_TOOL_OUTPUT_GUARD,
  estimateTokens,
  formatThreshold,
  outputPath,
  readSessionBudgetOptions,
  type SessionBudgetConfig,
  type SessionBudgetCounters,
  type SessionBudgetReport,
  toolResultText,
} from "../lib/session-budget"
import { createHarness } from "./support/harness"

type HookCallback = (input: unknown) => unknown

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

interface BudgetHarness {
  readonly ctx: Plugin.Context
  readonly hooks: Map<string, HookCallback>
  readonly disposed: string[]
  readonly events: EventStream
  readonly subscribed: () => boolean
  readonly aborted: () => boolean
}

interface BudgetHarnessOptions {
  readonly events?: boolean
  readonly workspace?: string
  /** Replace the push stream (a stream that ends or throws). */
  readonly stream?: AsyncIterable<unknown>
  /** Make every hook registration throw. */
  readonly failingHooks?: boolean
}

function createBudgetHarness(options: BudgetHarnessOptions = {}): BudgetHarness {
  const hooks = new Map<string, HookCallback>()
  const disposed: string[] = []
  const events = new EventStream()
  let subscribed = false
  let signal: AbortSignal | undefined
  const ctx: Record<string, unknown> = {
    location: { directory: options.workspace ?? process.cwd() },
    session: {
      hook: async (name: string, callback: HookCallback) => {
        if (options.failingHooks === true) throw new Error("hook registration failed")
        hooks.set(`session.${name}`, callback)
        return {
          dispose: async () => {
            disposed.push(`session.${name}`)
          },
        }
      },
    },
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        if (options.failingHooks === true) throw new Error("hook registration failed")
        hooks.set(`tool.${name}`, callback)
        return {
          dispose: async () => {
            disposed.push(`tool.${name}`)
          },
        }
      },
    },
  }
  if (options.events === true || options.stream !== undefined) {
    ctx.event = {
      subscribe: (requestOptions?: { signal?: AbortSignal }) => {
        subscribed = true
        signal = requestOptions?.signal
        requestOptions?.signal?.addEventListener("abort", () => events.close())
        return options.stream ?? events
      },
    }
  }
  return {
    ctx: ctx as unknown as Plugin.Context,
    hooks,
    disposed,
    events,
    subscribed: () => subscribed,
    aborted: () => signal?.aborted ?? false,
  }
}

/** Wait until every pushed event was consumed by the subscription loop. */
async function drain(harness: BudgetHarness): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (harness.events.pushed > 0 && harness.events.consumed === harness.events.pushed) {
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("event drain timed out")
}

/** Poll a condition while the subscription loop runs. */
async function waitFor(condition: () => boolean, what = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`${what} timed out`)
}

/**
 * Session ids are unique per run and their temp directories are removed after
 * each test: a crashed earlier run must not turn the next one into a retry-path
 * assertion failure, and a green run must not leak files under `%TEMP%`.
 */
const createdSessions = new Set<string>()

function sessionFor(prefix: string): string {
  const id = `ses_${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  createdSessions.add(id)
  return id
}

afterEach(async () => {
  for (const id of createdSessions) {
    await rm(path.dirname(outputPath(id, "cleanup")), { recursive: true, force: true })
  }
  createdSessions.clear()
})

/**
 * A stream that fails on its first read: an async iterable, not a generator, so
 * the "no yield" lint rule does not reject a deliberately broken stream.
 */
function failingStream(message: string): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return { next: () => Promise.reject(new Error(message)) }
    },
  }
}

/** A stream that ends before its first event. */
const emptyStream: AsyncIterable<unknown> = {
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return { next: async () => ({ done: true, value: undefined }) }
  },
}

function config(overrides: Partial<SessionBudgetConfig> = {}): SessionBudgetConfig {
  return {
    session: { ...DEFAULT_SESSION_GUARD, ...overrides.session },
    toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, ...overrides.toolOutput },
  }
}

/** A context request with `chars` text characters in one user message. */
function contextInput(sessionID: string, chars: number) {
  return {
    sessionID,
    system: [] as { type: "text"; text: string }[],
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(chars) }] }],
  }
}

function toolCall(sessionID: string, id: string, tool: string, result: Record<string, unknown>, status = "completed") {
  return {
    tool,
    sessionID,
    agent: "build",
    messageID: "msg",
    id,
    input: {},
    status,
    result,
    ...(status === "completed" ? {} : { error: { message: "boom" } }),
  }
}

describe("options", () => {
  test("defaults are used when no options are given", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(undefined, (message) => warnings.push(message))
    expect(parsed).toEqual(config())
    expect(warnings).toEqual([])
  })

  test("valid overrides are applied; head is clamped to maxChars; compaction count is floored", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(
      {
        sessionGuard: { promptTokensSoft: 1000, maxCompactions: 1.9 },
        toolOutputGuard: { maxChars: 500, headChars: 900, tools: ["shell"] },
      },
      (message) => warnings.push(message),
    )
    expect(parsed.session.promptTokensSoft).toBe(1000)
    expect(parsed.session.maxCompactions).toBe(1)
    expect(parsed.toolOutput.maxChars).toBe(500)
    expect(parsed.toolOutput.headChars).toBe(500)
    expect(parsed.toolOutput.tools).toEqual(["shell"])
    expect(warnings).toEqual([])
  })

  test("invalid fields fall back with a warning instead of failing setup", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(
      { sessionGuard: { enabled: "yes", promptTokensSoft: -1, maxCompactions: "two" } },
      (message) => warnings.push(message),
    )
    expect(parsed.session.enabled).toBe(DEFAULT_SESSION_GUARD.enabled)
    expect(parsed.session.promptTokensSoft).toBe(DEFAULT_SESSION_GUARD.promptTokensSoft)
    expect(parsed.session.maxCompactions).toBe(DEFAULT_SESSION_GUARD.maxCompactions)
    expect(warnings).toHaveLength(3)
  })

  test("a non-object guard section is reported and replaced by defaults", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions({ sessionGuard: true, toolOutputGuard: "on" }, (message) =>
      warnings.push(message),
    )
    expect(parsed).toEqual(config())
    expect(warnings).toHaveLength(2)
  })

  test("tool names are normalized and protected names are dropped with a warning", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(
      { toolOutputGuard: { tools: [" SHELL ", "shell", "", "read", "orch_uni_session_stats", "webfetch"] } },
      (message) => warnings.push(message),
    )
    expect(parsed.toolOutput.tools).toEqual(["shell", "webfetch"])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("read")
    expect(warnings[1]).toContain("orch_uni_session_stats")
  })

  test("a namespace prefix is stripped from configured and runtime tool names", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(
      { toolOutputGuard: { tools: ["functions.SHELL", "orch_uni.session_stats"] } },
      (message) => warnings.push(message),
    )
    expect(parsed.toolOutput.tools).toEqual(["shell"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("orch_uni.session_stats")
    expect(warnings[0]).toContain("protected")
  })

  test("an all-empty tools list disables capping with a warning; an explicit empty list is silent", () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions({ toolOutputGuard: { tools: ["", "  ", "\t"] } }, (message) =>
      warnings.push(message),
    )
    expect(parsed.toolOutput.tools).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("capping is disabled")

    const silent: string[] = []
    const explicit = readSessionBudgetOptions({ toolOutputGuard: { tools: [] } }, (message) => silent.push(message))
    expect(explicit.toolOutput.tools).toEqual([])
    expect(silent).toEqual([])
  })

  test("a hostile option value is formatted without throwing", () => {
    const warnings: string[] = []
    const hostile = {
      toJSON() {
        throw new Error("toJSON exploded")
      },
      toString() {
        throw new Error("toString exploded")
      },
    }
    const parsed = readSessionBudgetOptions(
      {
        sessionGuard: { enabled: hostile },
        toolOutputGuard: { tools: [hostile, "shell"] },
      },
      (message) => warnings.push(message),
    )
    expect(parsed.session.enabled).toBe(DEFAULT_SESSION_GUARD.enabled)
    expect(parsed.toolOutput.tools).toEqual(DEFAULT_TOOL_OUTPUT_GUARD.tools)
    expect(warnings.filter((line) => line.includes("[unserializable]"))).toHaveLength(2)
  })

  test("BigInt and cyclic option values do not break parsing", () => {
    const warnings: string[] = []
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const parsed = readSessionBudgetOptions(
      {
        sessionGuard: { enabled: cyclic, promptTokensSoft: 10n, maxCompactions: 10n },
        toolOutputGuard: { enabled: cyclic, tools: cyclic, maxChars: 10n, headChars: 10n },
      },
      (message) => warnings.push(message),
    )
    expect(parsed).toEqual(config())
    expect(warnings).toHaveLength(7)
    expect(warnings.every((line) => line.includes("options."))).toBe(true)
  })
})

describe("estimateTokens", () => {
  test("walks arrays and objects and counts text characters", () => {
    expect(estimateTokens("12345")).toBe(2)
    // Object keys (`type`, `role`, …) are counted too: 33 + 4 chars ≈ 11 tokens.
    expect(estimateTokens([{ type: "text", text: "x".repeat(33) }])).toBe(11)
  })

  test("does not loop on a repeated object", () => {
    const shared = { text: "abcd" }
    expect(estimateTokens([shared, shared])).toBe(1)
  })
})

describe("hooks", () => {
  test("one reminder per budget band, none below the budget", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const hook = harness.hooks.get("session.context") as HookCallback

    const quiet = contextInput("ses_a", 1000)
    await hook(quiet)
    expect(quiet.system).toHaveLength(0)

    const first = contextInput("ses_a", 600_000)
    await hook(first)
    expect(first.system).toHaveLength(1)
    expect(first.system[0]?.text).toContain("Гигиена сессии")
    expect(first.system[0]?.text).toContain("уровень 1×150k")

    const sameBand = contextInput("ses_a", 620_000)
    await hook(sameBand)
    expect(sameBand.system).toHaveLength(0)

    const secondBand = contextInput("ses_a", 1_100_000)
    await hook(secondBand)
    expect(secondBand.system).toHaveLength(1)
    expect(secondBand.system[0]?.text).toContain("уровень 2×150k")

    expect(budget.stats("ses_a").reminders).toBe(2)
    expect(budget.stats("ses_a").band).toBe(2)
    await budget.cleanup()
  })

  test("exactly the soft threshold is not over budget; one token above starts the level", async () => {
    const harness = createBudgetHarness()
    const probe = contextInput("ses_band", 1000)
    const soft = estimateTokens(probe.system) + estimateTokens(probe.messages)
    const budget = await createSessionBudget(
      harness.ctx,
      config({ session: { ...DEFAULT_SESSION_GUARD, promptTokensSoft: soft } }),
      "ru",
    )
    const hook = harness.hooks.get("session.context") as HookCallback

    const atSoft = contextInput("ses_band", 1000)
    expect(estimateTokens(atSoft.system) + estimateTokens(atSoft.messages)).toBe(soft)
    await hook(atSoft)
    expect(atSoft.system).toHaveLength(0)

    const above = contextInput("ses_band", 1004)
    expect(estimateTokens(above.system) + estimateTokens(above.messages)).toBeGreaterThan(soft)
    await hook(above)
    expect(above.system).toHaveLength(1)
    await budget.cleanup()
  })

  test("the threshold label keeps the configured precision", async () => {
    expect(formatThreshold(999)).toBe("999")
    expect(formatThreshold(1000)).toBe("1k")
    expect(formatThreshold(1500)).toBe("1.5k")
    expect(formatThreshold(150_000)).toBe("150k")

    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ session: { ...DEFAULT_SESSION_GUARD, promptTokensSoft: 1500 } }),
      "ru",
    )
    const input = contextInput("ses_format", 6000)
    await (harness.hooks.get("session.context") as HookCallback)(input)
    expect(input.system[0]?.text).toContain("уровень 1×1.5k")
    await budget.cleanup()
  })

  test("without an event stream the hook counts attempts but confirms no compaction", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    expect(harness.subscribed()).toBe(false)
    expect(harness.hooks.has("session.compaction")).toBe(true)
    const compaction = harness.hooks.get("session.compaction") as HookCallback
    const context = harness.hooks.get("session.context") as HookCallback
    const s = sessionFor("fallback")

    await compaction({ sessionID: s, system: [], messages: [] })

    const stats = budget.stats(s)
    expect(stats.compactionAttempts).toBe(1)
    expect(stats.compactions).toBe(0)
    expect(stats.compactionFailures).toBe(0)
    expect(stats.compactionSource).toBe("hook")
    expect(compactionLimitReached(budget.config, stats.compactions)).toBe(false)

    // No success is known on this host, so no lossy note and no false stop.
    const after = contextInput(s, 100)
    await context(after)
    expect(after.system).toHaveLength(0)
    expect(budget.guard()).toMatchObject({
      available: true,
      hooksRegistered: true,
      sessionEnabled: true,
      toolOutputEnabled: true,
      compactionSource: "hook",
      eventLive: false,
    })
    await budget.cleanup()
  })

  test("compaction events: ended counts, failed only increments failures", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    expect(harness.subscribed()).toBe(true)
    // The hook is registered even on an event host: it counts attempts.
    expect(harness.hooks.has("session.compaction")).toBe(true)
    expect(budget.guard()).toMatchObject({ eventLive: true, compactionSource: "event" })

    const s = sessionFor("ev")
    harness.events.push({ id: "evt_f1", type: "session.compaction.failed", data: { sessionID: s } })
    harness.events.push({ id: "evt_e1", type: "session.compaction.ended", data: { sessionID: s } })
    await drain(harness)

    const stats = budget.stats(s)
    expect(stats.compactions).toBe(1)
    expect(stats.compactionFailures).toBe(1)
    expect(stats.compactionSource).toBe("event")
    expect(compactionLimitReached(budget.config, stats.compactions)).toBe(true)

    const after = contextInput(s, 100)
    await (harness.hooks.get("session.context") as HookCallback)(after)
    expect(after.system).toHaveLength(1)
    expect(after.system[0]?.text).toContain("Компакция #1")
    expect(after.system[0]?.text).toContain("Лимит исчерпан")

    // The note is one-shot: the next request carries no compaction text.
    const next = contextInput(s, 100)
    await (harness.hooks.get("session.context") as HookCallback)(next)
    expect(next.system).toHaveLength(0)

    await budget.cleanup()
    expect(harness.aborted()).toBe(true)
  })

  test("a repeated compaction event is counted once per event id or durable position", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const s = sessionFor("dup")

    // The same event delivered twice by a reconnecting stream.
    for (let copy = 0; copy < 2; copy += 1) {
      harness.events.push({ id: "evt_dup_ended", type: "session.compaction.ended", data: { sessionID: s } })
      harness.events.push({ id: "evt_dup_failed", type: "session.compaction.failed", data: { sessionID: s } })
    }
    await drain(harness)
    expect(budget.stats(s)).toMatchObject({ compactions: 1, compactionFailures: 1 })

    // Without `id`, the durable envelope identifies the event.
    for (let copy = 0; copy < 2; copy += 1) {
      harness.events.push({
        type: "session.compaction.ended",
        data: { sessionID: s },
        durable: { aggregateID: s, seq: 7 },
      })
    }
    await drain(harness)
    expect(budget.stats(s)).toMatchObject({ compactions: 2, compactionFailures: 1 })
    await budget.cleanup()
  })

  test("a hook attempt between events puts a tentative note on the nearest request", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const s = sessionFor("race")

    // The compaction hook fires before the `ended` event arrives.
    await (harness.hooks.get("session.compaction") as HookCallback)({ sessionID: s, system: [], messages: [] })
    expect(budget.stats(s)).toMatchObject({ compactionAttempts: 1, compactions: 0 })

    const race = contextInput(s, 100)
    await (harness.hooks.get("session.context") as HookCallback)(race)
    expect(race.system).toHaveLength(1)
    expect(race.system[0]?.text).toContain("Компакция #1")

    // The event confirms the compaction; the next request carries the real note.
    harness.events.push({ id: "evt_race", type: "session.compaction.ended", data: { sessionID: s } })
    await drain(harness)
    expect(budget.stats(s)).toMatchObject({ compactionAttempts: 1, compactions: 1 })
    const confirmed = contextInput(s, 100)
    await (harness.hooks.get("session.context") as HookCallback)(confirmed)
    expect(confirmed.system).toHaveLength(1)
    expect(confirmed.system[0]?.text).toContain("Компакция #1")
    await budget.cleanup()
  })

  test("a failed compaction clears the tentative note and confirms nothing", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const s = sessionFor("failed")
    await (harness.hooks.get("session.compaction") as HookCallback)({ sessionID: s, system: [], messages: [] })
    harness.events.push({ id: "evt_failed", type: "session.compaction.failed", data: { sessionID: s } })
    await drain(harness)

    const stats = budget.stats(s)
    expect(stats.compactions).toBe(0)
    expect(stats.compactionFailures).toBe(1)
    expect(stats.compactionAttempts).toBe(1)

    const after = contextInput(s, 100)
    await (harness.hooks.get("session.context") as HookCallback)(after)
    expect(after.system).toHaveLength(0)
    expect(compactionLimitReached(budget.config, stats.compactions)).toBe(false)
    await budget.cleanup()
  })

  test("an ended or throwing event stream flips the guard to the hook without inventing compactions", async () => {
    for (const [label, stream] of [
      ["empty", emptyStream],
      ["throwing", failingStream("transport closed")],
    ] as const) {
      const harness = createBudgetHarness({ stream })
      const budget = await createSessionBudget(harness.ctx, config(), "ru")
      expect(harness.subscribed()).toBe(true)
      await waitFor(() => !budget.guard().eventLive, `${label} stream death`)
      expect(budget.guard()).toMatchObject({ eventLive: false, compactionSource: "hook", available: true })
      expect(harness.hooks.has("session.compaction")).toBe(true)

      const s = sessionFor(`dead_${label}`)
      await (harness.hooks.get("session.compaction") as HookCallback)({ sessionID: s, system: [], messages: [] })
      const stats = budget.stats(s)
      expect(stats.compactionAttempts).toBe(1)
      expect(stats.compactions).toBe(0)
      expect(stats.errors).toBe(1)
      expect(compactionLimitReached(budget.config, stats.compactions)).toBe(false)
      const input = contextInput(s, 100)
      await (harness.hooks.get("session.context") as HookCallback)(input)
      expect(input.system).toHaveLength(0)
      await budget.cleanup()
    }
  })

  test("maxCompactions=0 disables the limit and never claims it is reached", async () => {
    expect(compactionLimitReached(config({ session: { ...DEFAULT_SESSION_GUARD, maxCompactions: 0 } }), 0)).toBe(false)
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(
      harness.ctx,
      config({ session: { ...DEFAULT_SESSION_GUARD, maxCompactions: 0 } }),
      "ru",
    )
    harness.events.push({ type: "session.compaction.ended", data: { sessionID: "ses_zero" } })
    await drain(harness)

    const input = contextInput("ses_zero", 100)
    await (harness.hooks.get("session.context") as HookCallback)(input)
    const note = input.system[0]?.text ?? ""
    expect(note).toContain("лимит отключён")
    expect(note).not.toContain("Лимит исчерпан")
    expect(compactionLimitReached(budget.config, budget.stats("ses_zero").compactions)).toBe(false)
    await budget.cleanup()
  })

  test("a large configured tool result is capped and the full text is written to a file", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 1000, headChars: 100 } }),
      "ru",
    )
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("large")

    const result: Record<string, unknown> = { content: "y".repeat(5000), metadata: { previous: true } }
    await hook(toolCall(s, "call_1", "shell", result))

    const content = result.content as string
    expect(content.startsWith("y".repeat(100))).toBe(true)
    expect(content).toContain("5000 chars total")
    expect(content).toContain("full output:")
    expect(result.metadata).toEqual({
      previous: true,
      toolOutputGuard: { chars: 5000, path: outputPath(s, "call_1") },
    })

    const file = outputPath(s, "call_1")
    expect(await readFile(file, "utf8")).toBe("y".repeat(5000))

    expect(budget.stats(s).outputsCapped).toBe(1)
    // The saved count is the whole original text minus the stub actually injected,
    // including its head, marker and path.
    expect(budget.stats(s).outputCharsSaved).toBe(5000 - content.length)
    await budget.cleanup()
  })

  test("array results keep file parts and replace only the text", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 1000, headChars: 100 } }),
      "ru",
    )
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("array")

    const filePart = { type: "file", uri: "data:image/png;base64,xx", mime: "image/png" }
    const result: Record<string, unknown> = {
      content: [{ type: "text", text: "y".repeat(5000) }, filePart],
      metadata: {},
    }
    await hook(toolCall(s, "call_array", "shell", result))

    const parts = result.content as { type: string; text?: string; uri?: string; mime?: string }[]
    expect(parts).toHaveLength(2)
    expect(parts[0]?.type).toBe("text")
    expect(parts[0]?.text).toContain("5000 chars total")
    expect(parts[1]).toEqual(filePart)

    const file = outputPath(s, "call_array")
    expect(await readFile(file, "utf8")).toBe("y".repeat(5000))
    await budget.cleanup()
  })

  test("the head never ends on a lone surrogate", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 1000, headChars: 10 } }),
      "ru",
    )
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("surrogate")

    const text = `${"a".repeat(9)}\u{1F600}${"b".repeat(1500)}`
    const result: Record<string, unknown> = { content: text, metadata: {} }
    await hook(toolCall(s, "call_surrogate", "shell", result))

    const stub = result.content as string
    const head = stub.slice(0, stub.indexOf("\n\n"))
    expect(head).toBe(`${"a".repeat(9)}\u{1F600}`)
    expect(head.length).toBe(11)
    expect(/[\uD800-\uDBFF]$/.test(head)).toBe(false)
    await budget.cleanup()
  })

  test("a stub that is not shorter than the text is never applied", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 100, headChars: 100 } }),
      "ru",
    )
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("stub")

    for (const [id, length] of [
      ["call_exact", 100],
      ["call_over", 101],
    ] as const) {
      const result: Record<string, unknown> = { content: "z".repeat(length), metadata: {} }
      await hook(toolCall(s, id, "shell", result))
      expect(result.content).toHaveLength(length)
      expect(result.metadata).toEqual({})
      await expect(readFile(outputPath(s, id), "utf8")).rejects.toThrow()
    }

    expect(budget.stats(s).outputsCapped).toBe(0)
    expect(budget.stats(s).errors).toBe(0)
    await budget.cleanup()
  })

  test("other tools, small outputs and failed calls are untouched", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("other")

    const readResult = { content: "z".repeat(50_000) }
    await hook(toolCall(s, "call_2", "read", readResult))
    expect(readResult.content).toHaveLength(50_000)

    const smallResult = { content: "short" }
    await hook(toolCall(s, "call_3", "shell", smallResult))
    expect(smallResult.content).toBe("short")

    const failed = { content: "e".repeat(50_000) }
    await hook(toolCall(s, "call_4", "shell", failed, "error"))
    expect(failed.content).toHaveLength(50_000)

    expect(budget.stats(s).toolCalls).toBe(3)
    expect(budget.stats(s).outputsCapped).toBe(0)
    expect(budget.stats(s).toolCallsByTool).toEqual({ read: 1, shell: 2 })
    expect(budget.stats(s).toolOutputsCappedByTool).toEqual({ read: 0, shell: 0 })
    await budget.cleanup()
  })

  test("per-tool counters split calls and capped outputs by normalized name", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 100, headChars: 10 } }),
      "ru",
    )
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("per_tool")

    const capped = { content: "q".repeat(500), metadata: {} }
    const small = { content: "short", metadata: {} }
    const read = { content: "r".repeat(500), metadata: {} }
    await hook(toolCall(s, "per_1", "shell", capped))
    await hook(toolCall(s, "per_2", "shell", small))
    await hook(toolCall(s, "per_3", "read", read))

    const stats = budget.stats(s)
    expect(stats.toolCallsByTool).toEqual({ shell: 2, read: 1 })
    expect(stats.toolOutputsCappedByTool).toEqual({ shell: 1, read: 0 })
    expect(stats.toolCalls).toBe(3)
    expect(stats.outputsCapped).toBe(1)
    await budget.cleanup()
  })

  test("a namespaced tool name in the config is normalized to the runtime tool", async () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(
      { toolOutputGuard: { tools: ["functions.SHELL"], maxChars: 100, headChars: 10 } },
      (message) => warnings.push(message),
    )
    expect(parsed.toolOutput.tools).toEqual(["shell"])
    expect(warnings).toEqual([])
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, parsed, "ru")
    const s = sessionFor("upper")
    const result: Record<string, unknown> = { content: "q".repeat(500), metadata: {} }
    await (harness.hooks.get("tool.execute.after") as HookCallback)(
      toolCall(s, "call_upper", "functions.shell", result),
    )
    expect(result.metadata).toMatchObject({ toolOutputGuard: { chars: 500, path: expect.any(String) } })
    expect(budget.stats(s).toolCallsByTool).toEqual({ shell: 1 })
    expect(budget.stats(s).toolOutputsCappedByTool).toEqual({ shell: 1 })
    await budget.cleanup()
  })

  test("cleanup disposes every registration and is idempotent", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    await budget.cleanup()
    await budget.cleanup()
    expect(harness.disposed.sort()).toEqual(["session.compaction", "session.context", "tool.execute.after"])
  })

  test("undefined or null hook input is ignored without throwing or counting", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    for (const name of ["session.context", "session.compaction", "tool.execute.after"]) {
      const hook = harness.hooks.get(name) as HookCallback
      await hook(undefined)
      await hook(null)
    }
    expect(budget.tracked("")).toBe(false)
    expect(budget.stats("")).toMatchObject({ requests: 0, compactions: 0, toolCalls: 0, errors: 0 })
    await budget.cleanup()
  })

  test("a host without hook domains degrades to counters with a warning", async () => {
    const warnings: string[] = []
    const budget = await createSessionBudget({} as unknown as Plugin.Context, config(), "ru", (message) =>
      warnings.push(message),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("session guard disabled")
    expect(budget.available).toBe(false)
    expect(budget.tracked("ses_missing")).toBe(false)
    expect(budget.guard()).toEqual({
      available: false,
      hooksRegistered: false,
      sessionEnabled: true,
      toolOutputEnabled: true,
      compactionSource: "hook",
      eventLive: false,
    })
    expect(budget.stats("ses_missing")).toMatchObject({
      sessionID: "ses_missing",
      requests: 0,
      errors: 0,
      compactionSource: "hook",
    })
    await budget.cleanup()
  })

  test("a failing hook registration reports an unavailable guard and disposes what was registered", async () => {
    const warnings: string[] = []
    const harness = createBudgetHarness({ failingHooks: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru", (message) => warnings.push(message))
    expect(budget.available).toBe(false)
    expect(budget.guard()).toMatchObject({ available: false, hooksRegistered: false })
    expect(warnings.some((line) => line.includes("hook registration failed"))).toBe(true)
    expect(harness.hooks.size).toBe(0)
    await budget.cleanup()
  })

  test("a disabled guard counts tools but never injects or caps", async () => {
    const harness = createBudgetHarness()
    const disabled = config({
      session: { ...DEFAULT_SESSION_GUARD, enabled: false },
      toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, enabled: false },
    })
    const budget = await createSessionBudget(harness.ctx, disabled, "ru")
    const s = sessionFor("disabled")

    const input = contextInput(s, 600_000)
    await (harness.hooks.get("session.context") as HookCallback)(input)
    expect(input.system).toHaveLength(0)

    const result: Record<string, unknown> = { content: "q".repeat(50_000) }
    await (harness.hooks.get("tool.execute.after") as HookCallback)(toolCall(s, "call_5", "shell", result))
    expect(result.content).toHaveLength(50_000)
    await expect(readFile(outputPath(s, "call_5"), "utf8")).rejects.toThrow()

    const stats = budget.stats(s)
    expect(stats.requests).toBe(1)
    expect(stats.toolCalls).toBe(1)
    expect(stats.outputsCapped).toBe(0)
    expect(stats.toolCallsByTool).toEqual({ shell: 1 })
    expect(stats.toolOutputsCappedByTool).toEqual({ shell: 0 })
    expect(budget.guard()).toEqual({
      available: true,
      hooksRegistered: true,
      sessionEnabled: false,
      toolOutputEnabled: false,
      compactionSource: "hook",
      eventLive: false,
    })
    await budget.cleanup()
  })

  test("tracked follows events: session.created marks, session.deleted forgets", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const s = sessionFor("tracked")

    harness.events.push({ type: "session.created", data: { sessionID: s } })
    await drain(harness)
    expect(budget.tracked(s)).toBe(true)

    harness.events.push({ type: "session.deleted", data: { sessionID: s } })
    await drain(harness)
    expect(budget.tracked(s)).toBe(false)
    expect(budget.stats(s).requests).toBe(0)
    await budget.cleanup()
  })

  test("a tmpdir inside the workspace is reported once at setup", async () => {
    // The workspace must contain os.tmpdir() for the warning branch.
    const workspace = path.dirname(path.resolve(tmpdir()))
    const warnings: string[] = []
    const harness = createBudgetHarness({ workspace })
    const budget = await createSessionBudget(harness.ctx, config(), "ru", (message) => warnings.push(message))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("inside the workspace")
    await budget.cleanup()
  })

  test("a write failure leaves the frozen tool result untouched and counts one error", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(
      harness.ctx,
      config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 100, headChars: 10 } }),
      "ru",
    )
    const hook = harness.hooks.get("tool.execute.after") as HookCallback
    const s = sessionFor("frozen")
    // Block the session directory with a regular file: mkdir() cannot create it.
    await writeFile(path.dirname(outputPath(s, "blocked")), "blocker", "utf8")

    const result: Record<string, unknown> = { content: "w".repeat(5000), metadata: { previous: true } }
    await hook(toolCall(s, "call_frozen", "shell", result))

    expect(result.content).toBe("w".repeat(5000))
    expect(result.metadata).toEqual({ previous: true })
    expect(budget.stats(s).errors).toBe(1)
    expect(budget.stats(s).outputsCapped).toBe(0)
    await budget.cleanup()
  })
})

/**
 * A platform either allows a directory link (Windows junction with no extra
 * rights, or a POSIX symlink) or it does not; the containment test reports a
 * skip with the reason instead of failing where creation is impossible.
 */
async function detectLinkStyle(): Promise<"junction" | "symlink" | undefined> {
  const base = await mkdtemp(path.join(tmpdir(), "audit-link-probe-"))
  const source = path.join(base, "source")
  const link = path.join(base, "link")
  await mkdir(source)
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, source])
      return proc.exitCode === 0 ? "junction" : undefined
    }
    await symlink(source, link, "dir")
    return "symlink"
  } catch {
    return undefined
  } finally {
    await rm(link, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
}

const linkStyle = await detectLinkStyle()

describe("temp output paths", () => {
  test("outputPath keeps every segment inside the temp root", () => {
    const root = path.resolve(tmpdir(), "opencode-tool-output")
    for (const [sessionID, callID] of [
      ["..", "call"],
      ["a/b", "c\\d"],
      ["...", "."],
      ["CON", "call"],
      ["lpt1.txt", "nul"],
    ] as const) {
      const file = path.resolve(outputPath(sessionID, callID))
      expect(file).not.toBe(root)
      expect(file.startsWith(`${root}${path.sep}`)).toBe(true)
    }
    expect(outputPath("CON", "call")).toBe(path.join(root, "_CON", "call.txt"))
    expect(outputPath(".hidden", "call")).toBe(path.join(root, "hidden", "call.txt"))
  })

  test.skipIf(linkStyle === undefined)("a symlink or junction under the temp root is refused", async () => {
    const root = path.resolve(tmpdir(), "opencode-tool-output")
    const outside = await mkdtemp(path.join(tmpdir(), "audit-outside-"))
    const s = sessionFor("link")
    const link = path.join(root, s)
    try {
      if (linkStyle === "junction") {
        const proc = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, outside])
        expect(proc.exitCode).toBe(0)
      } else {
        await symlink(outside, link, "dir")
      }

      const harness = createBudgetHarness()
      const budget = await createSessionBudget(
        harness.ctx,
        config({ toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, maxChars: 100, headChars: 10 } }),
        "ru",
      )
      const result: Record<string, unknown> = { content: "s".repeat(5000), metadata: {} }
      await (harness.hooks.get("tool.execute.after") as HookCallback)(toolCall(s, "call_link", "shell", result))

      // The link is refused fail-open: the result is untouched and nothing lands outside.
      expect(result.content).toBe("s".repeat(5000))
      expect(result.metadata).toEqual({})
      await expect(readFile(path.join(outside, "call_link.txt"), "utf8")).rejects.toThrow()
      expect(budget.stats(s).errors).toBe(1)
      expect(budget.stats(s).outputsCapped).toBe(0)
      await budget.cleanup()
    } finally {
      await rm(link, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("toolResultText", () => {
  test("joins text parts and ignores files", () => {
    expect(
      toolResultText([
        { type: "text", text: "a" },
        { type: "file", uri: "data:image/png;base64,xx", mime: "image/png" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb")
    expect(toolResultText(undefined)).toBe("")
  })
})

describe("orch_uni_session_stats", () => {
  const counters: SessionBudgetCounters = {
    sessionID: "ses_test",
    requests: 3,
    promptTokensLast: 170_000,
    promptTokensMax: 190_000,
    promptTokensMedian: 170_000,
    band: 1,
    compactions: 1,
    compactionAttempts: 1,
    compactionFailures: 0,
    compactionSource: "event",
    reminders: 1,
    toolCalls: 9,
    outputsCapped: 2,
    outputCharsSaved: 40_000,
    errors: 0,
    toolCallsByTool: { shell: 5, read: 4 },
    toolOutputsCappedByTool: { shell: 2, read: 0 },
  }

  const guard = {
    available: true,
    hooksRegistered: true,
    sessionEnabled: true,
    toolOutputEnabled: true,
    compactionSource: "event" as const,
    eventLive: true,
  }

  function report(overrides: Partial<SessionBudgetReport> = {}): SessionBudgetReport {
    return {
      available: true,
      config: config(),
      stats: (sessionID) => ({ ...counters, sessionID }),
      tracked: (sessionID) => sessionID === "ses_test",
      guard: () => guard,
      ...overrides,
    }
  }

  test("reports counters, limits, toolsPerTurn, tracked and the guard state", async () => {
    const harness = await createHarness({ sessionBudget: report() })
    const tool = harness.tools.get("orch_uni_session_stats")
    expect(tool).toBeDefined()
    const response = await tool?.execute({}, { sessionID: "ses_test", signal: new AbortController().signal })
    const body = JSON.parse(String(response?.content)) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.sessionID).toBe("ses_test")
    expect(body.overBudget).toBe(true)
    expect(body.compactionLimitReached).toBe(true)
    expect(body.toolsPerTurn).toBe(3)
    expect(body.tracked).toBe(true)
    expect(body.guard).toEqual({
      available: true,
      hooksRegistered: true,
      sessionEnabled: true,
      toolOutputEnabled: true,
      compactionSource: "event",
      eventLive: true,
    })
    expect(body.schema).toBeUndefined()
    expect(body.counters).toMatchObject({
      requests: 3,
      outputsCapped: 2,
      compactionSource: "event",
      compactionAttempts: 1,
      toolCallsByTool: { shell: 5, read: 4 },
      toolOutputsCappedByTool: { shell: 2, read: 0 },
    })
    expect(body.limits).toMatchObject({ promptTokensSoft: 150_000, maxCompactions: 1 })
    harness.dispose()
  })

  test("maxCompactions=0 is not a reached limit", async () => {
    const zero = report({
      config: config({ session: { ...DEFAULT_SESSION_GUARD, maxCompactions: 0 } }),
      stats: (sessionID) => ({ ...counters, sessionID, compactions: 0 }),
    })
    const harness = await createHarness({ sessionBudget: zero })
    const body = JSON.parse(
      String(
        (
          await harness.tools.get("orch_uni_session_stats")?.execute(
            {},
            {
              sessionID: "ses_test",
              signal: new AbortController().signal,
            },
          )
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(body.compactionLimitReached).toBe(false)
    harness.dispose()
  })

  test("is unavailable without the guard", async () => {
    const harness = await createHarness()
    const tool = harness.tools.get("orch_uni_session_stats")
    const response = await tool?.execute({}, { sessionID: "ses_test", signal: new AbortController().signal })
    const body = JSON.parse(String(response?.content)) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe("E_UNAVAILABLE")
    harness.dispose()
  })

  test("is unavailable when the guard could not register its hooks", async () => {
    const harness = await createHarness({ sessionBudget: report({ available: false }) })
    const body = JSON.parse(
      String(
        (
          await harness.tools.get("orch_uni_session_stats")?.execute(
            {},
            {
              sessionID: "ses_test",
              signal: new AbortController().signal,
            },
          )
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe("E_UNAVAILABLE")
    harness.dispose()
  })

  test("an unknown session is E_NOT_FOUND when the store rejects it too", async () => {
    const harness = await createHarness({
      sessions: {
        get: async () => {
          throw new Error("session not found")
        },
      },
      sessionBudget: report(),
    })
    const body = JSON.parse(
      String(
        (
          await harness.tools.get("orch_uni_session_stats")?.execute(
            { sessionID: "ses_unknown" },
            {
              sessionID: "ses_caller",
              signal: new AbortController().signal,
            },
          )
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe("E_NOT_FOUND")
    harness.dispose()
  })

  test("a session known to the store but not tracked is a valid tracked:false report", async () => {
    const harness = await createHarness({
      sessions: { get: async (input: { sessionID: string }) => ({ id: input.sessionID }) },
      sessionBudget: report({
        tracked: () => false,
        stats: (sessionID) => ({ ...counters, sessionID, requests: 0, toolCalls: 0, compactions: 0 }),
      }),
    })
    const body = JSON.parse(
      String(
        (
          await harness.tools.get("orch_uni_session_stats")?.execute(
            { sessionID: "ses_known" },
            {
              sessionID: "ses_caller",
              signal: new AbortController().signal,
            },
          )
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.tracked).toBe(false)
    expect(body.toolsPerTurn).toBe(0)
    expect((body.session as { sessionID?: string }).sessionID).toBe("ses_known")
    harness.dispose()
  })

  test("a transient session.get failure is E_INTERNAL, a missing session is E_NOT_FOUND", async () => {
    for (const [message, code] of [
      ["database is locked", "E_INTERNAL"],
      ["permission denied", "E_INTERNAL"],
      ["session not found", "E_NOT_FOUND"],
      ["unknown session", "E_NOT_FOUND"],
    ] as const) {
      const harness = await createHarness({
        sessions: {
          get: async () => {
            throw new Error(message)
          },
        },
        sessionBudget: report(),
      })
      const body = JSON.parse(
        String(
          (
            await harness.tools
              .get("orch_uni_session_stats")
              ?.execute({ sessionID: "ses_unknown" }, { sessionID: "ses_caller", signal: new AbortController().signal })
          )?.content,
        ),
      ) as Record<string, unknown>
      expect(body.ok, message).toBe(false)
      expect(body.code, message).toBe(code)
      expect(String(body.message)).toContain(message)
      harness.dispose()
    }
  })

  test("without session.get an untracked session is E_NO_API; a tracked one reports session:null", async () => {
    const harness = await createHarness({ sessions: {}, sessionBudget: report() })

    const untracked = JSON.parse(
      String(
        (
          await harness.tools
            .get("orch_uni_session_stats")
            ?.execute({ sessionID: "ses_unknown" }, { sessionID: "ses_caller", signal: new AbortController().signal })
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(untracked).toMatchObject({ ok: false, code: "E_NO_API" })

    const tracked = JSON.parse(
      String(
        (
          await harness.tools
            .get("orch_uni_session_stats")
            ?.execute({ sessionID: "ses_test" }, { sessionID: "ses_caller", signal: new AbortController().signal })
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(tracked.ok).toBe(true)
    expect(tracked.session).toBeNull()
    expect(tracked.limitations).toEqual(["session.get is unavailable in this build"])
    harness.dispose()
  })

  test("a tracked session survives a failing session.get", async () => {
    const harness = await createHarness({
      sessions: {
        get: async () => {
          throw new Error("session not found")
        },
      },
      sessionBudget: report({ tracked: (sessionID) => sessionID === "ses_known" }),
    })
    const body = JSON.parse(
      String(
        (
          await harness.tools.get("orch_uni_session_stats")?.execute(
            { sessionID: "ses_known" },
            {
              sessionID: "ses_caller",
              signal: new AbortController().signal,
            },
          )
        )?.content,
      ),
    ) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.tracked).toBe(true)
    expect(body.session).toBeUndefined()
    harness.dispose()
  })
})
