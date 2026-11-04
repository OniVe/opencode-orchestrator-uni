import { describe, expect, test } from "bun:test"
import { createWriteGuard, decideEdit, WRITE_GUARD_MESSAGE } from "../lib/write-guard"

/** Location used by every case unless the resource is absolute and outside it. */
const LOCATION = "E:/proj"

const ALLOWED = [
  // Artifact roots: the whole subtree is an artifact.
  "reports/summary.md",
  "reports/src/deep/x.ts",
  "lab/audit-pfx/reports/x",
  // Root artifact files.
  "case-x.md",
  "risks-x.md",
  "handoff-x.md",
  "decisions-x.md",
  "state.md",
  // Planning documents (nested `.md` is allowed at any depth).
  "docs/planning/state.md",
  "docs/planning/handoff-x.md",
  "docs/planning/sub/x.md",
  "docs/planning/sub/deep/x.md",
  // Artifact files under an audit-* directory (any depth).
  "audit-abc/case-x.md",
  "audit-abc/sub/state.md",
  "lab/audit-pfx/risks-x.md",
  // Absolute paths inside the location.
  "E:/proj/reports/x",
  "E:/proj/docs/planning/x.md",
  "E:/proj/state.md",
  "E:/proj/audit-abc/state.md",
]

const DENIED = [
  // Source roots.
  "src/index.ts",
  "lib/x.ts",
  "test/x.ts",
  "agents/x.md",
  "tools/x.ts",
  "schemas/x.json",
  "eval/x.ts",
  ".github/workflows/ci.yml",
  "docs/ru/x.md",
  // Project files.
  "README.md",
  "package.json",
  // A source root wins even under an artifact-looking continuation. There is one
  // case per root in SOURCE_ROOTS (9 entries), so dropping any of them turns its
  // case into an allow. `docs` is not in that set: it has a dedicated branch, and
  // the `docs/reports/x.ts` / `docs/ru/x.md` cases pin that branch instead.
  "src/reports/x.ts",
  "src/docs/planning/x.md",
  "test/docs/planning/x.md",
  "tests/docs/planning/x.md",
  "lib/reports/x.ts",
  "agents/reports/x.ts",
  "agents/docs/planning/x.md",
  "tools/docs/planning/x.md",
  "schemas/reports/x.json",
  "eval/docs/planning/x.ts",
  "eval/docs/planning/x.md",
  "docs/reports/x.ts",
  ".github/docs/planning/x.md",
  // Artifact files outside an artifact location.
  "app/state.md",
  "server/state.md",
  "notes/state.md",
  // Normalized paths cannot escape into a source root.
  "reports/../src/x.ts",
  "docs/planning/../../src/x.md",
  // Not a Markdown planning file.
  "docs/planning/tool.ts",
  "docs/planning/sub/tool.ts",
  // The location is the workspace boundary: artifact roots and artifact files
  // are writable only inside it, never through `..`, an absolute path or UNC.
  "../state.md",
  "../reports/x",
  "../reports/src/x.ts",
  "../docs/planning/x.md",
  "C:/other/reports/x",
  "C:/other/docs/planning/x.md",
  "C:/Users/u/audit-abc/state.md",
  "//server/share/reports/x",
  "//server/share/src/x.ts",
  "E:/outside/state.md",
  "E:/proj/../outside/reports/x",
  // Absolute one-segment and malformed artifacts do not become location-root files.
  "/state.md",
  "state.md/bad",
  "state.md:evil",
  // Absolute paths resolve the same way.
  "E:/proj/src/reports/x",
  "E:/proj/src/docs/planning/x.md",
  "C:/Users/u/project/state.md",
]

describe("decideEdit", () => {
  test("allows artifact roots and artifact files in artifact locations", () => {
    for (const resource of ALLOWED) expect(decideEdit(resource, LOCATION), resource).toBe("allow")
  })

  test("denies source roots, project files and anything outside the location", () => {
    for (const resource of DENIED) expect(decideEdit(resource, LOCATION), resource).toBe("deny")
  })

  test("normalizes separators and dot segments before deciding", () => {
    expect(decideEdit("reports\\src\\x.ts", LOCATION)).toBe("allow")
    expect(decideEdit("src\\reports\\x.ts", LOCATION)).toBe("deny")
    expect(decideEdit("./reports/./x.md", LOCATION)).toBe("allow")
  })

  test("folds case when the platform folds case (Windows)", () => {
    expect(decideEdit("SRC/reports/x.ts", LOCATION, "win32")).toBe("deny")
    expect(decideEdit("REPORTS/x.md", LOCATION, "win32")).toBe("allow")
    expect(decideEdit("E:/PROJ/reports/x", LOCATION, "win32")).toBe("allow")
    expect(decideEdit("State.md", LOCATION, "win32")).toBe("allow")
  })

  test("does not fold case on a case-sensitive platform (POSIX)", () => {
    // `SRC`/`REPORTS` are ordinary segments there, so this is not an artifact.
    expect(decideEdit("SRC/reports/x.ts", LOCATION, "linux")).toBe("allow")
    expect(decideEdit("REPORTS/x.md", LOCATION, "linux")).toBe("deny")
    expect(decideEdit("State.md", LOCATION, "linux")).toBe("deny")
    // Inside-location and source-root behavior is platform-independent.
    expect(decideEdit("E:/proj/reports/x", LOCATION, "linux")).toBe("allow")
    expect(decideEdit("E:/proj/src/x", LOCATION, "linux")).toBe("deny")
    // The location prefix is compared the same way the segments are folded.
    expect(decideEdit("e:/proj/reports/x", LOCATION, "win32")).toBe("allow")
    expect(decideEdit("e:/proj/reports/x", LOCATION, "linux")).toBe("deny")
  })
})

interface EvaluateEventDraft {
  sessionID?: string
  agent?: string
  action: string
  resources: readonly unknown[] | null
  effect: string
  message?: string
}

describe("createWriteGuard", () => {
  const fakeContext = (ctx: unknown) => ctx as unknown as Parameters<typeof createWriteGuard>[0]

  interface HookHarnessOptions {
    readonly sessions?: unknown
    readonly warn?: (message: string) => void
  }

  /** Register the guard against a fake host and return the captured callback. */
  async function hookHarness(options: HookHarnessOptions = {}) {
    const warnings: string[] = []
    const warn = (message: string) => {
      warnings.push(message)
      options.warn?.(message)
    }
    let disposed = 0
    let registered: ((event: EvaluateEventDraft) => Promise<void>) | undefined
    let sessionGets = 0
    const sessionsOption = options.sessions as { get?: (input: { sessionID: string }) => Promise<unknown> } | undefined
    const baseGet = sessionsOption?.get
    const sessions =
      baseGet === undefined
        ? {
            get: async (input: { sessionID: string }) => {
              sessionGets += 1
              return { id: input.sessionID }
            },
          }
        : {
            get: async (input: { sessionID: string }) => {
              sessionGets += 1
              return baseGet(input)
            },
          }
    const ctx = {
      session: sessions,
      permission: {
        hook: async (_name: string, callback: (event: EvaluateEventDraft) => Promise<void>) => {
          registered = callback
          return {
            dispose: async () => {
              disposed += 1
            },
          }
        },
      },
    }
    const guard = await createWriteGuard(fakeContext(ctx), { locationDirectory: LOCATION, warn })
    const evaluate = async (event: EvaluateEventDraft) => {
      await registered?.(event)
      return event
    }
    return {
      guard,
      evaluate,
      warnings,
      get disposed() {
        return disposed
      },
      get sessionGets() {
        return sessionGets
      },
    }
  }

  test("is a warned no-op without ctx.permission.hook", async () => {
    const warnings: string[] = []
    const guard = await createWriteGuard(fakeContext({}), {
      locationDirectory: LOCATION,
      warn: (message) => warnings.push(message),
    })
    expect(guard.available).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("permission.hook")
    await guard.cleanup()
  })

  test("is a warned no-op when the hook registration throws", async () => {
    const warnings: string[] = []
    const ctx = {
      permission: {
        hook: async () => {
          throw new Error("registration failed")
        },
      },
    }
    const guard = await createWriteGuard(fakeContext(ctx), {
      locationDirectory: LOCATION,
      warn: (message) => warnings.push(message),
    })
    expect(guard.available).toBe(false)
    expect(warnings.some((line) => line.includes("registration failed"))).toBe(true)
    await guard.cleanup()
  })

  test("denies non-artifact resources and disposes the registration exactly once", async () => {
    const host = await hookHarness()
    expect(host.guard.available).toBe(true)
    const event = await host.evaluate({
      agent: "orchestrator",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    expect(event.effect).toBe("deny")
    expect(event.message).toBe(WRITE_GUARD_MESSAGE)
    expect(host.disposed).toBe(0)
    await host.guard.cleanup()
    await host.guard.cleanup()
    expect(host.disposed).toBe(1)
  })

  test("resolves the location of the event's session, not the setup location", async () => {
    const host = await hookHarness({
      sessions: {
        get: async (input: { sessionID: string }) => ({ id: input.sessionID, location: { directory: "F:/moved" } }),
      },
    })
    expect(host.sessionGets).toBe(0)
    // The absolute path is outside the setup location, so the setup base would deny it.
    expect(decideEdit("F:/moved/reports/x", LOCATION)).toBe("deny")
    const moved = await host.evaluate({
      sessionID: "ses_moved",
      agent: "orchestrator",
      action: "edit",
      resources: ["F:/moved/reports/x", "F:/moved/docs/planning/state.md"],
      effect: "allow",
    })
    expect(moved.effect).toBe("allow")
    expect(host.sessionGets).toBe(1)
    const denied = await host.evaluate({
      sessionID: "ses_moved",
      agent: "orchestrator",
      action: "edit",
      resources: ["F:/moved/src/x"],
      effect: "allow",
    })
    expect(denied.effect).toBe("deny")
    expect(host.sessionGets).toBe(2)
    await host.guard.cleanup()
  })

  test("falls back to the setup location and warns once when session.get fails", async () => {
    const host = await hookHarness({
      sessions: {
        get: async () => {
          throw new Error("session store offline")
        },
      },
    })
    const allowed = await host.evaluate({
      sessionID: "ses_moved",
      agent: "orchestrator",
      action: "edit",
      resources: ["reports/x"],
      effect: "allow",
    })
    expect(allowed.effect).toBe("allow")
    const denied = await host.evaluate({
      sessionID: "ses_moved",
      agent: "orchestrator",
      action: "edit",
      resources: ["src/x"],
      effect: "allow",
    })
    expect(denied.effect).toBe("deny")
    expect(host.warnings.filter((line) => line.includes("session directory"))).toHaveLength(1)
    expect(host.warnings.some((line) => line.includes("session store offline"))).toBe(true)
    await host.guard.cleanup()
  })

  test("a failing event leaves the effect untouched (fail-open, warning, no throw)", async () => {
    const host = await hookHarness()
    const nullResources: EvaluateEventDraft = {
      agent: "orchestrator",
      action: "edit",
      resources: null,
      effect: "allow",
    }
    await host.evaluate(nullResources)
    expect(nullResources.effect).toBe("allow")
    expect(nullResources.message).toBeUndefined()

    const noAgent: EvaluateEventDraft = { action: "edit", resources: ["src/x.ts"], effect: "allow" }
    await host.evaluate(noAgent)
    expect(noAgent.effect).toBe("allow")

    const throwing = {
      replaceAll: () => {
        throw new Error("resource exploded")
      },
    }
    const brokenResource: EvaluateEventDraft = {
      agent: "orchestrator",
      action: "edit",
      resources: [throwing],
      effect: "allow",
    }
    await host.evaluate(brokenResource)
    expect(brokenResource.effect).toBe("allow")
    expect(brokenResource.message).toBeUndefined()

    const failures = host.warnings.filter((line) => line.includes("evaluation failed"))
    expect(failures).toHaveLength(2)
    expect(failures.some((line) => line.includes("resource exploded"))).toBe(true)
    await host.guard.cleanup()
  })
})
