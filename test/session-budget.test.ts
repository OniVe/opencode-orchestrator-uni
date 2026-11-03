/**
 * Session-budget hooks: the protocol is enforced where it is safe and merely
 * observed everywhere else.
 *
 * The tests exercise the three hooks with a fake plugin context, because the
 * live host is not available in unit tests: a context request over the token
 * budget gets one reminder per band, a compaction is counted and reported on the
 * next request, and a large tool result is capped with the full text written to
 * a temp file. The `orch_uni_session_stats` tool is checked through the shared
 * tools harness, including the `E_UNAVAILABLE` path when the guard is absent.
 */
import { describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  createSessionBudget,
  DEFAULT_SESSION_GUARD,
  DEFAULT_TOOL_OUTPUT_GUARD,
  estimateTokens,
  outputPath,
  readSessionBudgetOptions,
  type SessionBudgetConfig,
  toolResultText,
} from "../lib/session-budget"
import { createHarness } from "./support/harness"

type HookCallback = (input: unknown) => unknown

interface BudgetHarness {
  readonly ctx: Plugin.Context
  readonly hooks: Map<string, HookCallback>
  readonly disposed: string[]
}

function createBudgetHarness(): BudgetHarness {
  const hooks = new Map<string, HookCallback>()
  const disposed: string[] = []
  const ctx = {
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
  return { ctx: ctx as unknown as Plugin.Context, hooks, disposed }
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
    expect(first.system[0]?.text).toContain("уровень 1")

    const sameBand = contextInput("ses_a", 620_000)
    await hook(sameBand)
    expect(sameBand.system).toHaveLength(0)

    const secondBand = contextInput("ses_a", 1_100_000)
    await hook(secondBand)
    expect(secondBand.system).toHaveLength(1)
    expect(secondBand.system[0]?.text).toContain("уровень 2")

    expect(budget.stats("ses_a").reminders).toBe(2)
    expect(budget.stats("ses_a").band).toBe(2)
    await budget.cleanup()
  })

  test("a compaction is counted and reported once on the next request", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
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
    expect(stats.requests).toBe(2)
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

    const result = { content: "y".repeat(5000) }
    await hook({
      tool: "shell",
      sessionID: "ses_c",
      agent: "build",
      messageID: "msg",
      id: "call_1",
      input: {},
      status: "completed",
      result,
    })

    expect(typeof result.content).toBe("string")
    const content = result.content as string
    expect(content.startsWith("y".repeat(100))).toBe(true)
    expect(content).toContain("5000 chars total")
    expect(content).toContain("full output:")

    const file = outputPath("ses_c", "call_1")
    expect(await readFile(file, "utf8")).toBe("y".repeat(5000))
    await rm(path.dirname(file), { recursive: true, force: true })

    expect(budget.stats("ses_c").outputsCapped).toBe(1)
    expect(budget.stats("ses_c").outputCharsSaved).toBe(4900)
    await budget.cleanup()
  })

  test("other tools, small outputs and failed calls are untouched", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    const hook = harness.hooks.get("tool.execute.after") as HookCallback

    const readResult = { content: "z".repeat(50_000) }
    await hook({
      tool: "read",
      sessionID: "ses_d",
      agent: "build",
      messageID: "msg",
      id: "call_2",
      input: {},
      status: "completed",
      result: readResult,
    })
    expect(readResult.content).toHaveLength(50_000)

    const smallResult = { content: "short" }
    await hook({
      tool: "shell",
      sessionID: "ses_d",
      agent: "build",
      messageID: "msg",
      id: "call_3",
      input: {},
      status: "completed",
      result: smallResult,
    })
    expect(smallResult.content).toBe("short")

    const failed = { content: "e".repeat(50_000) }
    await hook({
      tool: "shell",
      sessionID: "ses_d",
      agent: "build",
      messageID: "msg",
      id: "call_4",
      input: {},
      status: "error",
      error: { message: "boom" },
      result: failed,
    })
    expect(failed.content).toHaveLength(50_000)

    expect(budget.stats("ses_d").outputsCapped).toBe(0)
    await budget.cleanup()
  })

  test("cleanup disposes every registration and is idempotent", async () => {
    const harness = createBudgetHarness()
    const budget = await createSessionBudget(harness.ctx, config(), "ru")
    await budget.cleanup()
    await budget.cleanup()
    expect(harness.disposed.sort()).toEqual(["session.compaction", "session.context", "tool.execute.after"])
  })

  test("a host without hook domains degrades to counters with a warning", async () => {
    const warnings: string[] = []
    const budget = await createSessionBudget({} as unknown as Plugin.Context, config(), "ru", (message) =>
      warnings.push(message),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("session guard disabled")
    expect(budget.stats("ses_missing")).toMatchObject({ sessionID: "ses_missing", requests: 0, errors: 0 })
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

    const result = { content: "q".repeat(50_000) }
    await (harness.hooks.get("tool.execute.after") as HookCallback)({
      tool: "shell",
      sessionID: "ses_e",
      agent: "build",
      messageID: "msg",
      id: "call_5",
      input: {},
      status: "completed",
      result,
    })
    expect(result.content).toHaveLength(50_000)
    expect(budget.stats("ses_e").outputsCapped).toBe(0)
    await budget.cleanup()
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
  test("reports counters and the configured limits", async () => {
    const counters = {
      sessionID: "ses_test",
      requests: 3,
      promptTokensLast: 170_000,
      promptTokensMax: 190_000,
      promptTokensMedian: 170_000,
      band: 1,
      compactions: 1,
      reminders: 1,
      toolCalls: 9,
      outputsCapped: 2,
      outputCharsSaved: 40_000,
      errors: 0,
    }
    const harness = await createHarness({
      sessionBudget: { config: config(), stats: (sessionID) => ({ ...counters, sessionID }) },
    })
    const tool = harness.tools.get("orch_uni_session_stats")
    expect(tool).toBeDefined()
    const response = await tool?.execute({}, { sessionID: "ses_test", signal: new AbortController().signal })
    const body = JSON.parse(String(response?.content)) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.sessionID).toBe("ses_test")
    expect(body.overBudget).toBe(true)
    expect(body.compactionLimitReached).toBe(true)
    expect(body.counters).toMatchObject({ requests: 3, outputsCapped: 2 })
    expect(body.limits).toMatchObject({ promptTokensSoft: 150_000, maxCompactions: 1 })
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
})
