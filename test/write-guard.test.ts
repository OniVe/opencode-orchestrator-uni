import { describe, expect, test } from "bun:test"
import { decideEdit } from "../lib/write-guard"

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
  // Planning documents.
  "docs/planning/state.md",
  "docs/planning/handoff-x.md",
  // Artifact files under an audit-* directory.
  "audit-abc/case-x.md",
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
  // A source root wins even under an artifact-looking prefix.
  "src/reports/x.ts",
  "src/docs/planning/x.md",
  "test/docs/planning/x.md",
  // Artifact files outside an artifact location.
  "app/state.md",
  "server/state.md",
  "notes/state.md",
  // Normalized paths cannot escape into a source root.
  "reports/../src/x.ts",
  "docs/planning/../../src/x.md",
  // Not a Markdown planning file.
  "docs/planning/tool.ts",
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
})
