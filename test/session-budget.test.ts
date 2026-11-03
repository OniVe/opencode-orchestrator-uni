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
import { describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
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

function createBudgetHarness(options: { events?: boolean; workspace?: string } = {}): BudgetHarness {
  const hooks = new Map<string, HookCallback>()
  const disposed: string[] = []
  const events = new EventStream()
  let subscribed = false
  let signal: AbortSignal | undefined
  const ctx: Record<string, unknown> = {
    location: { directory: options.workspace ?? process.cwd() },
    session: {
      hook: async (name: string, callback: HookCallback) => {
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
        hooks.set(`tool.${name}`, callback)
        return {
          dispose: async () => {
            disposed.push(`tool.${name}`)
          },
        }
      },
    },
  }
  if (options.events === true) {
    ctx.event = {
      subscribe: (requestOptions?: { signal?: AbortSignal }) => {
        subscribed = true
        signal = requestOptions?.signal
        requestOptions?.signal?.addEventListener("abort", () => events.close())
        return events
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

  test("without an event stream the compaction hook is the fallback source", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    expect(harness.subscribed()).toBe(false)
    const compaction = harness.hooks.get("session.compaction") as HookCallback
    const context = harness.hooks.get("session.context") as HookCallback

    await compaction({ sessionID: "ses_b", system: [], messages: [] })
    await compaction({ sessionID: "ses_b", system: [], messages: [] })

    const after = contextInput("ses_b", 100)
    await context(after)
    expect(after.system).toHaveLength(1)
    expect(after.system[0]?.text).toContain("Компакция #2")
    expect(after.system[0]?.text).toContain("Лимит исчерпан")

    const next = contextInput("ses_b", 100)
    await context(next)
    expect(next.system).toHaveLength(0)

    const stats = budget.stats("ses_b")
    expect(stats.compactions).toBe(2)
    expect(stats.compactionFailures).toBe(0)
    expect(stats.compactionSource).toBe("hook")
    expect(stats.requests).toBe(2)
    await budget.cleanup()
  })

  test("compaction events: ended counts, failed only increments failures", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    expect(harness.subscribed()).toBe(true)
    expect(harness.hooks.get("session.compaction")).toBeUndefined()

    harness.events.push({ type: "session.compaction.failed", data: { sessionID: "ses_ev" } })
    harness.events.push({ type: "session.compaction.ended", data: { sessionID: "ses_ev" } })
    await drain(harness)

    const stats = budget.stats("ses_ev")
    expect(stats.compactions).toBe(1)
    expect(stats.compactionFailures).toBe(1)
    expect(stats.compactionSource).toBe("event")
    expect(compactionLimitReached(budget.config, stats.compactions)).toBe(true)

    const after = contextInput("ses_ev", 100)
    await (harness.hooks.get("session.context") as HookCallback)(after)
    expect(after.system).toHaveLength(1)
    expect(after.system[0]?.text).toContain("Компакция #1")
    expect(after.system[0]?.text).toContain("Лимит исчерпан")

    // The note is one-shot: the next request carries no compaction text.
    const next = contextInput("ses_ev", 100)
    await (harness.hooks.get("session.context") as HookCallback)(next)
    expect(next.system).toHaveLength(0)

    await budget.cleanup()
    expect(harness.aborted()).toBe(true)
  })

  test("a failed compaction leaves the counters and pending note alone", async () => {
    const harness = createBudgetHarness({ events: true })
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    harness.events.push({ type: "session.compaction.failed", data: { sessionID: "ses_failed" } })
    await drain(harness)

    const stats = budget.stats("ses_failed")
    expect(stats.compactions).toBe(0)
    expect(stats.compactionFailures).toBe(1)

    const after = contextInput("ses_failed", 100)
    await (harness.hooks.get("session.context") as HookCallback)(after)
    expect(after.system).toHaveLength(0)
    await budget.cleanup()
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

    const result: Record<string, unknown> = { content: "y".repeat(5000), metadata: { previous: true } }
    await hook(toolCall("ses_c", "call_1", "shell", result))

    const content = result.content as string
    expect(content.startsWith("y".repeat(100))).toBe(true)
    expect(content).toContain("5000 chars total")
    expect(content).toContain("full output:")
    expect(result.metadata).toEqual({
      previous: true,
      toolOutputGuard: { chars: 5000, path: outputPath("ses_c", "call_1") },
    })

    const file = outputPath("ses_c", "call_1")
    expect(await readFile(file, "utf8")).toBe("y".repeat(5000))
    await rm(path.dirname(file), { recursive: true, force: true })

    expect(budget.stats("ses_c").outputsCapped).toBe(1)
    // The saved count is the whole original text minus the stub actually injected,
    // including its head, marker and path.
    expect(budget.stats("ses_c").outputCharsSaved).toBe(5000 - content.length)
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

    const filePart = { type: "file", uri: "data:image/png;base64,xx", mime: "image/png" }
    const result: Record<string, unknown> = {
      content: [{ type: "text", text: "y".repeat(5000) }, filePart],
      metadata: {},
    }
    await hook(toolCall("ses_array", "call_array", "shell", result))

    const parts = result.content as { type: string; text?: string; uri?: string; mime?: string }[]
    expect(parts).toHaveLength(2)
    expect(parts[0]?.type).toBe("text")
    expect(parts[0]?.text).toContain("5000 chars total")
    expect(parts[1]).toEqual(filePart)

    const file = outputPath("ses_array", "call_array")
    expect(await readFile(file, "utf8")).toBe("y".repeat(5000))
    await rm(path.dirname(file), { recursive: true, force: true })
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

    const text = `${"a".repeat(9)}\u{1F600}${"b".repeat(1500)}`
    const result: Record<string, unknown> = { content: text, metadata: {} }
    await hook(toolCall("ses_surrogate", "call_surrogate", "shell", result))

    const stub = result.content as string
    const head = stub.slice(0, stub.indexOf("\n\n"))
    expect(head).toBe(`${"a".repeat(9)}\u{1F600}`)
    expect(head.length).toBe(11)
    expect(/[\uD800-\uDBFF]$/.test(head)).toBe(false)

    const file = outputPath("ses_surrogate", "call_surrogate")
    await rm(path.dirname(file), { recursive: true, force: true })
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
    // The property is "no file is written", so a stale file from an earlier run
    // must not mask it.
    await rm(path.dirname(outputPath("ses_stub", "call_exact")), { recursive: true, force: true })

    for (const [id, length] of [
      ["call_exact", 100],
      ["call_over", 101],
    ] as const) {
      const result: Record<string, unknown> = { content: "z".repeat(length), metadata: {} }
      await hook(toolCall("ses_stub", id, "shell", result))
      expect(result.content).toHaveLength(length)
      expect(result.metadata).toEqual({})
      await expect(readFile(outputPath("ses_stub", id), "utf8")).rejects.toThrow()
    }

    expect(budget.stats("ses_stub").outputsCapped).toBe(0)
    expect(budget.stats("ses_stub").errors).toBe(0)
    await budget.cleanup()
  })

  test("other tools, small outputs and failed calls are untouched", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const hook = harness.hooks.get("tool.execute.after") as HookCallback

    const readResult = { content: "z".repeat(50_000) }
    await hook(toolCall("ses_d", "call_2", "read", readResult))
    expect(readResult.content).toHaveLength(50_000)

    const smallResult = { content: "short" }
    await hook(toolCall("ses_d", "call_3", "shell", smallResult))
    expect(smallResult.content).toBe("short")

    const failed = { content: "e".repeat(50_000) }
    await hook(toolCall("ses_d", "call_4", "shell", failed, "error"))
    expect(failed.content).toHaveLength(50_000)

    expect(budget.stats("ses_d").toolCalls).toBe(3)
    expect(budget.stats("ses_d").outputsCapped).toBe(0)
    await budget.cleanup()
  })

  test("a normalized uppercase tool name is capped at runtime", async () => {
    const warnings: string[] = []
    const parsed = readSessionBudgetOptions(
      { toolOutputGuard: { tools: ["SHELL"], maxChars: 100, headChars: 10 } },
      (message) => warnings.push(message),
    )
    expect(parsed.toolOutput.tools).toEqual(["shell"])
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, parsed, "ru")
    const result: Record<string, unknown> = { content: "q".repeat(500), metadata: {} }
    await (harness.hooks.get("tool.execute.after") as HookCallback)(
      toolCall("ses_upper", "call_upper", "shell", result),
    )
    expect(result.metadata).toMatchObject({ toolOutputGuard: { chars: 500, path: expect.any(String) } })
    await budget.cleanup()
  })

  test("cleanup disposes every fallback registration and is idempotent", async () => {
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
    expect(budget.stats("ses_missing")).toMatchObject({
      sessionID: "ses_missing",
      requests: 0,
      errors: 0,
      compactionSource: "hook",
    })
    await budget.cleanup()
  })

  test("a disabled guard counts but never injects or caps", async () => {
    const harness = createBudgetHarness()
    const disabled = config({
      session: { ...DEFAULT_SESSION_GUARD, enabled: false },
      toolOutput: { ...DEFAULT_TOOL_OUTPUT_GUARD, enabled: false },
    })
    const budget = await createSessionBudget(harness.ctx, disabled, "ru")

    const input = contextInput("ses_e", 600_000)
    await (harness.hooks.get("session.context") as HookCallback)(input)
    expect(input.system).toHaveLength(0)

    const result: Record<string, unknown> = { content: "q".repeat(50_000) }
    await (harness.hooks.get("tool.execute.after") as HookCallback)(toolCall("ses_e", "call_5", "shell", result))
    expect(result.content).toHaveLength(50_000)
    await expect(readFile(outputPath("ses_e", "call_5"), "utf8")).rejects.toThrow()

    const stats = budget.stats("ses_e")
    expect(stats.requests).toBe(1)
    expect(stats.toolCalls).toBe(1)
    expect(stats.outputsCapped).toBe(0)
    await budget.cleanup()
  })
})

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
    compactionFailures: 0,
    compactionSource: "event",
    reminders: 1,
    toolCalls: 9,
    outputsCapped: 2,
    outputCharsSaved: 40_000,
    errors: 0,
  }

  function report(overrides: Partial<SessionBudgetReport> = {}): SessionBudgetReport {
    return {
      available: true,
      config: config(),
      stats: (sessionID) => ({ ...counters, sessionID }),
      tracked: (sessionID) => sessionID === "ses_test",
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
    expect(body.guard).toEqual({ available: true, hooksRegistered: true })
    expect(body.schema).toBeUndefined()
    expect(body.counters).toMatchObject({ requests: 3, outputsCapped: 2, compactionSource: "event" })
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
