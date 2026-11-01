import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { lintContext } from "../lib/context-lint"
import { createHarness, runTool } from "./support/harness"

const VALID_AGENTS = [
  "# AGENTS.md",
  "",
  "## Commands",
  "",
  "| Task | Command |",
  "|---|---|",
  "| Install | bun install |",
  "| Build | bun run build |",
  "| Tests | bun test |",
  "",
  "## Boundaries",
  "",
  "- Never commit secrets.",
  "- Ask first: schema changes.",
  "",
  "## Verification",
  "",
  "Done = `bun test` is green.",
].join("\n")

async function temporary(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "context-lint-"))
}

async function write(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body, "utf8")
  return file
}

describe("lintContext", () => {
  test("a compact, testable AGENTS.md passes", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("pass")
      expect(result.closing_list).toEqual([])
      expect(result.files[0]).toMatchObject({ kind: "agents", lines: 18 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("budget, vague phrases, broken links and placeholders become MAJOR findings", async () => {
    const root = await temporary()
    try {
      const body = [
        "# AGENTS.md",
        "2026-01-01 v1.2.3",
        ...Array.from({ length: 210 }, (_, index) => `- rule ${index}: clean and robust and carefully`),
        "[missing](docs/nope.md)",
        "<...>",
      ].join("\n")
      await write(root, "AGENTS.md", body)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("fail")
      const findings = result.files[0]?.findings ?? []
      const kinds = new Set(findings.filter((finding) => finding.severity === "MAJOR").map((finding) => finding.kind))
      expect(kinds.has("budget")).toBe(true)
      expect(kinds.has("vague")).toBe(true)
      expect(kinds.has("broken_link")).toBe(true)
      expect(kinds.has("other")).toBe(true)
      expect(result.closing_list.length).toBeGreaterThanOrEqual(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a SPEC without non-goals, requirements or testable AC fails", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC-001",
          "",
          "## Requirements",
          "",
          "- **R1** — WHEN a user exports and saves, THE SYSTEM SHALL work.",
          "",
          "| AC1.1 | R1 | given | when | then | |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("fail")
      const findings = result.files[0]?.findings ?? []
      expect(findings.some((finding) => finding.severity === "MAJOR" && finding.kind === "missing_section")).toBe(true)
      expect(findings.some((finding) => finding.detail.includes("AC row"))).toBe(true)
      expect(findings.some((finding) => finding.detail.includes("multiple behaviors"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("relative links resolve from the file directory", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [docs](docs/x.md).`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files[0]?.findings.some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("typed failures: missing target, no files, invalid budget", async () => {
    const root = await temporary()
    try {
      expect(await lintContext({ root, target: "missing.md" })).toMatchObject({ ok: false, code: "E_NOT_FOUND" })
      expect(await lintContext({ root })).toMatchObject({ ok: false, code: "E_NO_FILES" })
      expect(await lintContext({ root, maxLines: 0 })).toMatchObject({ ok: false, code: "E_INPUT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the orch_uni tool exposes the lint result", async () => {
    const harness = await createHarness()
    try {
      await writeFile(path.join(harness.directory, "AGENTS.md"), VALID_AGENTS, "utf8")
      const result = await runTool(harness, "orch_uni_context_lint", { path: "AGENTS.md" })
      expect(result).toMatchObject({ ok: true, verdict: "pass" })
    } finally {
      harness.dispose()
    }
  })
})
