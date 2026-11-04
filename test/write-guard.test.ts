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
  // Absolute paths inside and outside the location.
  "E:/proj/reports/x",
  "E:/proj/docs/planning/x.md",
  "C:/Users/u/audit-abc/state.md",
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
  // Escaping the location leaves no artifact location behind.
  "../state.md",
  // Absolute paths resolve the same way.
  "E:/proj/src/reports/x",
  "E:/proj/src/docs/planning/x.md",
  "C:/Users/u/project/state.md",
]

describe("decideEdit", () => {
  test("allows artifact roots and artifact files in artifact locations", () => {
    for (const resource of ALLOWED) expect(decideEdit(resource, LOCATION), resource).toBe("allow")
  })

  test("denies source roots, project files and misplaced artifacts", () => {
    for (const resource of DENIED) expect(decideEdit(resource, LOCATION), resource).toBe("deny")
  })

  test("normalizes separators and dot segments before deciding", () => {
    expect(decideEdit("reports\\src\\x.ts", LOCATION)).toBe("allow")
    expect(decideEdit("src\\reports\\x.ts", LOCATION)).toBe("deny")
    expect(decideEdit("./reports/./x.md", LOCATION)).toBe("allow")
  })

  test("folds case on Windows", () => {
    if (process.platform !== "win32") return
    expect(decideEdit("SRC/reports/x.ts", LOCATION)).toBe("deny")
    expect(decideEdit("REPORTS/x.md", LOCATION)).toBe("allow")
  })
})

interface EvaluateEventDraft {
  agent?: string
  action: string
  resources: readonly string[]
  effect: string
  message?: string
}

describe("createWriteGuard", () => {
  const fakeContext = (ctx: unknown) => ctx as unknown as Parameters<typeof createWriteGuard>[0]

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

  test("denies non-artifact resources and disposes the registration", async () => {
    let disposed = 0
    let registered: ((event: EvaluateEventDraft) => void) | undefined
    const ctx = {
      permission: {
        hook: async (_name: string, callback: (event: EvaluateEventDraft) => void) => {
          registered = callback
          return {
            dispose: async () => {
              disposed += 1
            },
          }
        },
      },
    }
    const guard = await createWriteGuard(fakeContext(ctx), {
      locationDirectory: LOCATION,
      warn: () => {},
    })
    expect(guard.available).toBe(true)
    expect(registered).toBeDefined()
    const event: EvaluateEventDraft = {
      agent: "orchestrator",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    }
    registered?.(event)
    expect(event.effect).toBe("deny")
    expect(event.message).toBe(WRITE_GUARD_MESSAGE)
    await guard.cleanup()
    expect(disposed).toBe(1)
  })
})
