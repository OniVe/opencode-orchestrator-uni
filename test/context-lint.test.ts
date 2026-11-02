import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type ContextLintOutcome, lintContext, readCappedFile } from "../lib/context-lint"
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

function findingsOf(result: ContextLintOutcome): readonly { severity: string; kind: string; detail: string }[] {
  if (!result.ok) throw new Error(`expected a lint result, got ${result.code}: ${result.message}`)
  return result.files.flatMap((file) => file.findings)
}

function majors(
  result: ContextLintOutcome,
  kind?: string,
): readonly { severity: string; kind: string; detail: string }[] {
  return findingsOf(result).filter(
    (finding) => finding.severity === "MAJOR" && (kind === undefined || finding.kind === kind),
  )
}

/** The SPEC acceptance table: 6 columns and one row with an empty Test cell. */
function specWithAc(testCell: string): string {
  return [
    "# SPEC-001",
    "",
    "## Requirements",
    "",
    "- **R1** — WHEN a user exports and saves, THE SYSTEM SHALL work.",
    "",
    "| AC | R | Given | When | Then | Test |",
    "|---|---|---|---|---|---|",
    `| AC1.1 | R1 | given | when | then | ${testCell} |`,
  ].join("\n")
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
      await write(root, "SPEC.md", specWithAc(""))
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
      expect(await lintContext({ root, target: 42 as unknown as string })).toMatchObject({
        ok: false,
        code: "E_INPUT",
      })
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

  test("the tool executor survives a missing tool context (no signal)", async () => {
    const harness = await createHarness()
    try {
      await writeFile(path.join(harness.directory, "AGENTS.md"), VALID_AGENTS, "utf8")
      const tool = harness.tools.get("orch_uni_context_lint")
      expect(tool).toBeDefined()
      const body = await tool?.execute({ path: "AGENTS.md" }, {})
      expect(JSON.parse(String(body?.content))).toMatchObject({ ok: true })
    } finally {
      harness.dispose()
    }
  })
})

// E-M2: non-goals are a count, not a presence flag.
describe("non-goals 3–7", () => {
  const spec = (count: number): string =>
    [
      "# SPEC-001",
      "",
      "## Non-goals",
      "",
      ...Array.from({ length: count }, (_, index) => `- out of scope ${index + 1}`),
      "",
      "## Requirements",
      "",
      "- R1 — WHEN a user saves, THE SYSTEM SHALL persist.",
      "",
      "| AC | R | Given | When | Then | Test |",
      "|---|---|---|---|---|---|",
      "| AC1.1 | R1 | given | when | then | saves.test.ts |",
    ].join("\n")

  for (const count of [0, 1, 2, 8]) {
    test(`${count} non-goals fail`, async () => {
      const root = await temporary()
      try {
        await write(root, "SPEC.md", spec(count))
        const result = await lintContext({ root, target: "SPEC.md" })
        expect(result.ok).toBe(true)
        expect(majors(result).some((finding) => finding.detail.includes("non-goals"))).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const count of [3, 7]) {
    test(`${count} non-goals pass`, async () => {
      const root = await temporary()
      try {
        await write(root, "SPEC.md", spec(count))
        const result = await lintContext({ root, target: "SPEC.md" })
        expect(result.ok).toBe(true)
        expect(majors(result).some((finding) => finding.detail.includes("non-goals"))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test("Non-goals: None. counts as zero items", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", "# SPEC\n\nNon-goals: None.\n\n## Requirements\n\n- R1 — shall work.\n")
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(result.ok).toBe(true)
      expect(majors(result).some((finding) => finding.detail.includes("non-goals"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("AC table parsing", () => {
  test("an AC row with an empty Test cell is MAJOR", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specWithAc(""))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a requirement without an AC row is MAJOR", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "- R2 — shall import.",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | export.test.ts |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail.startsWith("R2 has no acceptance criterion"))).toBe(true)
      expect(majors(result).some((finding) => finding.detail.startsWith("R1 has no"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a traceability row is not an AC row", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | export.test.ts |",
          "",
          "## Traceability",
          "",
          "| R | AC | Task |",
          "|---|---|---|",
          "| R1 | AC1.1 | T1 |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "AC row has no test")).toBe(false)
      expect(findingsOf(result).some((finding) => finding.detail === "AC row lacks columns")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a 7-column table still finds the Test column", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "",
          "| AC | R | Given | When | Then | Test | Notes |",
          "|---|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | export.test.ts | ok |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("AC row"))).toBe(false)
      expect(majors(result).some((finding) => finding.detail.includes("acceptance criterion"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// I-M1: a UNC/backslash target must never reach existsSync.
describe("network paths", () => {
  test("a UNC link returns quickly and is not reported as broken", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [share](\\\\10.255.255.1\\share\\x.md).`)
      const started = Date.now()
      const result = await Promise.race([
        lintContext({ root, target: "AGENTS.md" }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("UNC link hung the lint")), 3000)),
      ])
      expect(Date.now() - started).toBeLessThan(3000)
      expect(findingsOf(result).some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// I-M2: caps are typed refusals or reported truncation, never a huge echo.
describe("limits", () => {
  test("a file above maxFileBytes is a typed E_LIMIT_FILE", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      const result = await lintContext({ root, target: "AGENTS.md", maxFileBytes: 100 })
      expect(result).toMatchObject({ ok: false, code: "E_LIMIT_FILE" })
      if (result.ok) return
      expect(result.bytes).toBeGreaterThan(100)
      expect(result.max).toBe(100)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the default cap refuses a 5 MB file", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", "a".repeat(5_000_001))
      expect(await lintContext({ root, target: "AGENTS.md" })).toMatchObject({ ok: false, code: "E_LIMIT_FILE" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("more files than maxFiles is E_LIMIT_FILES", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      await write(root, "docs/SPEC.md", "# SPEC")
      expect(await lintContext({ root, maxFiles: 1 })).toMatchObject({ ok: false, code: "E_LIMIT_FILES" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the per-file cap drops MINOR/INFO but keeps every MAJOR", async () => {
    const root = await temporary()
    try {
      const duplicated = Array.from({ length: 5 }, (_, index) => `- rule ${index}: ${"x".repeat(50)}`)
      const body = [...duplicated, ...duplicated, "<...>"].join("\n")
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n${body}\n`)
      const result = await lintContext({ root, target: "AGENTS.md", maxFindingsPerFile: 2 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files[0]?.findings ?? []
      const majors = findings.filter((finding) => finding.severity === "MAJOR")
      const minors = findings.filter((finding) => finding.severity === "MINOR")
      expect(majors.some((finding) => finding.detail.startsWith("placeholder"))).toBe(true)
      expect(minors.length).toBe(2)
      expect(findings.at(-1)).toMatchObject({
        severity: "INFO",
        detail: "findings truncated at 2 (MAJOR findings are kept)",
      })
      expect(result.files[0]?.truncated).toBe(true)
      expect(result.truncated).toBe(true)
      expect(result.verdict).toBe("fail")
      // The retained MAJOR ids are exactly the closing list: nothing was hidden.
      expect(result.closing_list).toEqual(majors.map((finding) => finding.id))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("more than 100 MINOR findings are capped, the MAJORs are kept and closed", async () => {
    const root = await temporary()
    try {
      const body = [
        "# SPEC",
        "",
        "## Non-goals",
        "",
        "- a",
        "- b",
        "- c",
        "",
        "## Requirements",
        "",
        ...Array.from({ length: 120 }, (_, index) => `- R${index + 1} and shall do thing ${index + 1}.`),
        "",
        "| AC | R | Given | When | Then | Test |",
        "|---|---|---|---|---|---|",
      ].join("\n")
      await write(root, "SPEC.md", body)
      const result = await lintContext({ root, target: "SPEC.md", maxFindingsPerFile: 100 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files[0]?.findings ?? []
      const majors = findings.filter((finding) => finding.severity === "MAJOR")
      expect(findings.filter((finding) => finding.severity === "MINOR").length).toBe(100)
      expect(result.files[0]?.truncated).toBe(true)
      expect(result.verdict).toBe("fail")
      // 100 MAJOR findings are listed plus one MAJOR truncation marker.
      expect(majors.length).toBe(101)
      expect(majors.at(-1)?.detail).toBe("findings truncated at 100 MAJOR (further MAJOR findings are not listed)")
      expect(result.closing_list).toEqual(majors.map((finding) => finding.id))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a 300k-placeholder file keeps a bounded finding list", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", "<...>\n".repeat(300_000))
      const result = await lintContext({ root, target: "AGENTS.md", maxFindingsPerFile: 10 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files[0]?.findings ?? []
      // Budget MAJORs + 10 kept MAJOR findings + section MINORs + one MAJOR marker;
      // never a raw 300k array.
      expect(findings.length).toBeLessThanOrEqual(16)
      const marker = findings.find(
        (finding) => finding.detail === "findings truncated at 10 MAJOR (further MAJOR findings are not listed)",
      )
      expect(marker).toMatchObject({ severity: "MAJOR" })
      expect(result.truncated).toBe(true)
      expect(result.verdict).toBe("fail")
      const majorCount = findings.filter((finding) => finding.severity === "MAJOR").length
      expect(majorCount).toBe(11)
      expect(result.closing_list.length).toBe(majorCount)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a truncated list with only MINOR findings still passes", async () => {
    const root = await temporary()
    try {
      const duplicated = Array.from({ length: 5 }, (_, index) => `- rule ${index}: ${"z".repeat(50)}`)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n${[...duplicated, ...duplicated].join("\n")}\n`)
      const result = await lintContext({ root, target: "AGENTS.md", maxFindingsPerFile: 1 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("pass")
      expect(result.closing_list).toEqual([])
      expect(result.truncated).toBe(true)
      expect(result.files[0]?.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the total cap drops MINOR/INFO but a later MAJOR is retained", async () => {
    const root = await temporary()
    try {
      const duplicated = Array.from({ length: 4 }, (_, index) => `- rule ${index}: ${"w".repeat(50)}`)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n${[...duplicated, ...duplicated].join("\n")}\n`)
      await write(root, "docs/AGENTS.md", `${VALID_AGENTS}\n<...>\n`)
      const result = await lintContext({ root, maxTotalFindings: 1 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.truncated).toBe(true)
      const major = result.files
        .flatMap((file) => file.findings)
        .filter((finding) => finding.severity === "MAJOR" && finding.detail.startsWith("placeholder"))
      expect(major.length).toBe(1)
      expect(major[0]?.evidence.startsWith("docs/AGENTS.md")).toBe(true)
      expect(result.verdict).toBe("fail")
      expect(result.closing_list).toContain(major[0]?.id ?? "")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("500 files hit the default total cap and the last MAJOR is retained", async () => {
    const root = await temporary()
    try {
      const line = `- rule: ${"q".repeat(50)}`
      const body = ["## Commands", "bun test", ...Array.from({ length: 4 }, () => line)].join("\n")
      for (let index = 0; index < 500; index += 1) {
        await write(root, `d${index}/AGENTS.md`, index === 499 ? `${body}\n<...>\n` : body)
      }
      const result = await lintContext({ root })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.length).toBe(500)
      expect(result.truncated).toBe(true)
      const retained = result.files
        .flatMap((file) => file.findings)
        .filter((finding) => finding.severity === "MAJOR" && finding.detail.startsWith("placeholder"))
      expect(retained.length).toBe(1)
      expect(retained[0]?.evidence.startsWith("d499/AGENTS.md")).toBe(true)
      expect(result.closing_list).toContain(retained[0]?.id ?? "")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// I-M3: placeholders are `<...>` and TODO/TBD/FIXME, outside code and open questions.
describe("placeholders", () => {
  test("valid markup constructs are not placeholders", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "",
          "Line break<br> and a comment <!-- TODO later --> here.",
          "See <https://example.com/...> and <user@example.com>.",
          "Types: `Array<string>`; destination: [x](<docs/x.md>).",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("<...> and TODO outside open questions are MAJOR", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n<...>\n\nTODO: write the rules.\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      const placeholders = findingsOf(result).filter((finding) => finding.detail.startsWith("placeholder"))
      expect(placeholders.length).toBe(2)
      expect(placeholders.every((finding) => finding.severity === "MAJOR")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("TODO/TBD inside Open questions are allowed", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n## Open questions\n\n- TBD: who owns the migration?\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a TODO after the open-questions section is flagged again", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        `${VALID_AGENTS}\n\n## Open questions\n\n- TBD: owner?\n\n## Rules\n\n- TODO: finish this.\n`,
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      const placeholders = findingsOf(result).filter((finding) => finding.detail.startsWith("placeholder"))
      expect(placeholders.length).toBe(1)
      expect(placeholders[0]?.detail).toContain("TODO")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// I-M4: only local, in-root links are checked; nested badges are both checked.
describe("link parser", () => {
  test("non-local links and inline code are skipped", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(root, "docs/my file.md", "# Space")
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "",
          "[ftp](ftp://example.com/x.md) [ssh](ssh://host/x) [file](file:///tmp/x.md)",
          "[cdn](//cdn.example.com/x.md) [space](docs/my%20file.md)",
          "[query](docs/x.md?raw=1) [anchor](docs/x.md#section)",
          "Call `and/or` and `client/server` helpers.",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a nested badge checks the outer target", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n[![alt](docs/x.md)](docs/missing.md)\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = findingsOf(result).filter((finding) => finding.kind === "broken_link")
      expect(broken.length).toBe(1)
      expect(broken[0]?.detail).toContain("docs/missing.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// E-M4 / I-M7: BOM, CRLF and the trailing newline are not content lines.
describe("line counting", () => {
  const body = (count: number, eol: string): string =>
    `${Array.from({ length: count }, (_, index) => `- rule ${index}`).join(eol)}${eol}`

  for (const [count, expected] of [
    [199, 199],
    [200, 200],
    [201, 201],
  ] as const) {
    for (const [name, eol] of [
      ["LF", "\n"],
      ["CRLF", "\r\n"],
    ] as const) {
      test(`${count} lines with ${name} and a trailing newline`, async () => {
        const root = await temporary()
        try {
          await write(root, "AGENTS.md", body(count, eol))
          const result = await lintContext({ root, target: "AGENTS.md" })
          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.files[0]?.lines).toBe(expected)
          const budgetMajor = majors(result, "budget").length > 0
          expect(budgetMajor).toBe(expected > 200)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }

  test("a BOM is not counted as content", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `\uFEFF${body(200, "\n")}`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files[0]?.lines).toBe(200)
      expect(result.files[0]?.chars).toBe(body(200, "\n").length)
      expect(majors(result, "budget").length).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// E-M6 / I-M6: the section matchers understand Russian headings and are not
// satisfied by a word that merely contains the token.
describe("section detection", () => {
  test("a Russian commands heading is recognized", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", "# AGENTS\n\n## Команды\n\n- Смотри документацию проекта.\n")
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "no commands section")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const heading of ["## Verification", "## Определение готовности"]) {
    test(`${heading} satisfies the verification check`, async () => {
      const root = await temporary()
      try {
        await write(root, "AGENTS.md", `# AGENTS\n\n## Commands\n\n- bun test\n\n${heading}\n\n- everything green.\n`)
        const result = await lintContext({ root, target: "AGENTS.md" })
        expect(findingsOf(result).some((finding) => finding.detail.includes("verification"))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test("a Russian «Не цели» section is recognized", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Не цели",
          "",
          "- без экспорта",
          "- без импорта",
          "- без миграций",
          "",
          "## Requirements",
          "",
          "- R1 — shall persist.",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | persist.test.ts |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "no non-goals")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prose tokens `r1` and `AC power` do not satisfy the SPEC sections", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", "# SPEC\n\nr1 is a unit; AC power is a thing.\n")
      const result = await lintContext({ root, target: "SPEC.md" })
      const details = findingsOf(result).map((finding) => finding.detail)
      expect(details).toContain("no numbered requirements")
      expect(details).toContain("no acceptance criteria")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// I-M8: a file symlink to AGENTS.md is linted; a directory link cycle stops.
describe("symlinked targets", () => {
  test("a symlinked AGENTS.md is collected and a directory cycle does not hang", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      let linked = true
      try {
        await symlink(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"), "file")
      } catch {
        linked = false // the OS/user cannot create symlinks
      }
      if (!linked) return
      await mkdir(path.join(root, "loop"), { recursive: true })
      try {
        await symlink(root, path.join(root, "loop", "self"), "dir")
      } catch {
        // directory links may be unavailable; the file-link part is enough
      }
      const result = await Promise.race([
        lintContext({ root }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("symlink scan hung")), 3000)),
      ])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((file) => file.path).sort()).toContain("CLAUDE.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== "win32")("a directory junction cycle does not hang or duplicate files", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      await mkdir(path.join(root, "loop"), { recursive: true })
      const junction = path.join(root, "loop", "self")
      const created = Bun.spawnSync(["cmd", "/c", "mklink", "/J", junction, root])
      if (created.exitCode !== 0) return // junctions unavailable: nothing to prove here
      const result = await Promise.race([
        lintContext({ root }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("junction scan hung")), 3000)),
      ])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const paths = result.files.map((file) => file.path)
      expect(paths.filter((file) => file === "AGENTS.md").length).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// I-M9: identical lines inside a code fence are samples, not duplicates.
describe("duplicates", () => {
  const repeated = "bun run tools/kit-verify.ts --proj ../some/project/directory"

  test("a fenced copy is not a duplicate", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n${repeated}\n\n\`\`\`sh\n${repeated}\n\`\`\`\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "duplicate")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a repeated line outside a fence is a duplicate", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n${repeated}\n\n${repeated}\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "duplicate")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// I-M14: the workspace root is the boundary for explicit targets and links.
describe("root confinement", () => {
  test("an explicit target outside the root is E_OUT_OF_ROOT", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      expect(await lintContext({ root, target: path.join(root, "..", "outside", "AGENTS.md") })).toMatchObject({
        ok: false,
        code: "E_OUT_OF_ROOT",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a link resolving outside the root is not checked", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [outside](../missing.md).`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** A directory link: `symlink(type: "junction")` or `mklink /J` on Windows. */
async function directoryLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    // fall through to mklink
  }
  if (process.platform !== "win32") return false
  const created = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, target])
  return created.exitCode === 0
}

const AC_TABLE = [
  "| AC | R | Given | When | Then | Test |",
  "|---|---|---|---|---|---|",
  "| AC1.1 | R1 | given | when | then | row.test.ts |",
]

// R2-M1: the real path, not the lexical one, is the containment boundary.
describe("real-path containment", () => {
  test("a directory link outside the root is skipped, refused as a target and not link-checked", async () => {
    const root = await temporary()
    const outside = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      await write(outside, "AGENTS.md", VALID_AGENTS)
      if (!(await directoryLink(outside, path.join(root, "out")))) return
      const scanned = await lintContext({ root })
      expect(scanned.ok).toBe(true)
      if (!scanned.ok) return
      expect(scanned.files.map((file) => file.path)).toEqual(["AGENTS.md"])
      expect(await lintContext({ root, target: "out/AGENTS.md" })).toMatchObject({
        ok: false,
        code: "E_OUT_OF_ROOT",
      })
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [out](out/AGENTS.md).`)
      const linked = await lintContext({ root, target: "AGENTS.md" })
      expect(linked.ok).toBe(true)
      if (!linked.ok) return
      expect(linked.files[0]?.findings.some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("a file link outside the root is not collected", async () => {
    const root = await temporary()
    const outside = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      await write(outside, "AGENTS.md", VALID_AGENTS)
      try {
        await symlink(path.join(outside, "AGENTS.md"), path.join(root, "CLAUDE.md"), "file")
      } catch {
        return // the OS/user cannot create file links
      }
      const result = await lintContext({ root })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((file) => file.path)).toEqual(["AGENTS.md"])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("a ..foo directory inside the root is allowed", async () => {
    const root = await temporary()
    try {
      await write(root, "..foo/AGENTS.md", VALID_AGENTS)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [x](..foo/AGENTS.md).`)
      const direct = await lintContext({ root, target: "..foo/AGENTS.md" })
      expect(direct.ok).toBe(true)
      const scanned = await lintContext({ root })
      expect(scanned.ok).toBe(true)
      if (!scanned.ok) return
      expect(scanned.files.map((file) => file.path).sort()).toEqual(["..foo/AGENTS.md", "AGENTS.md"])
      const linked = await lintContext({ root, target: "AGENTS.md" })
      expect(linked.ok).toBe(true)
      if (!linked.ok) return
      expect(linked.files[0]?.findings.some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R2-M4: one line-preserving mask for fences, inline code and HTML comments.
describe("code mask", () => {
  test("links, vague terms and placeholders in code or comments are ignored", async () => {
    const root = await temporary()
    try {
      const body = [
        VALID_AGENTS,
        "",
        "Inline `[gone](docs/inline-gone.md)` and `TODO <...> robust properly carefully`.",
        "```md",
        "[fenced](docs/fenced-gone.md)",
        "TODO <...>",
        "clean and robust and properly",
        "```",
        "",
        "<!--",
        "[comment](docs/comment-gone.md)",
        "TODO <...>",
        "-->",
      ].join("\n")
      await write(root, "AGENTS.md", body)
      const result = await lintContext({ root, target: "AGENTS.md" })
      const findings = findingsOf(result)
      expect(findings.some((finding) => finding.kind === "broken_link")).toBe(false)
      expect(findings.some((finding) => finding.kind === "vague")).toBe(false)
      expect(findings.some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a fenced requirements/AC block does not close SPEC sections", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "```md",
          "## Requirements",
          "- R1 — shall work.",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | row.test.ts |",
          "```",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      const details = findingsOf(result).map((finding) => finding.detail)
      expect(details).toContain("no numbered requirements")
      expect(details).toContain("no acceptance criteria")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("real content outside the fence is still checked", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        `${VALID_AGENTS}\n\n\`\`\`\n[inside](docs/inside.md)\n\`\`\`\n[outside](docs/outside.md)\n`,
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = findingsOf(result).filter((finding) => finding.kind === "broken_link")
      expect(broken.length).toBe(1)
      expect(broken[0]?.detail).toContain("docs/outside.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R2-M3: the AC/R parser reads table blocks by header, not by row shape.
describe("AC/R table parser", () => {
  const spec = (extra: string[]): string =>
    [
      "# SPEC",
      "",
      "## Non-goals",
      "",
      "- a",
      "- b",
      "- c",
      "",
      "## Requirements",
      "",
      "- R1 — shall work.",
      ...extra,
    ].join("\n")

  test("a heading without an AC table does not satisfy acceptance", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", spec(["", "## Acceptance criteria", "", "TBD."]))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "no acceptance criteria")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a headerless AC row with an empty Test cell is MAJOR", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", spec(["", "| AC1.1 | R1 | given | when | then |  |"]))
      const result = await lintContext({ root, target: "SPEC.md" })
      const findings = findingsOf(result)
      expect(findings.some((finding) => finding.severity === "MAJOR" && finding.detail === "AC row has no test")).toBe(
        true,
      )
      expect(findings.some((finding) => finding.detail === "AC table lacks header")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a traceability table before the AC table does not mask it", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        spec([
          "",
          "| R | AC | Task |",
          "|---|---|---|",
          "| R1 | AC1.1 | T1 |",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then |  |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
      expect(findingsOf(result).some((finding) => finding.detail === "AC row lacks columns")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an escaped pipe does not shift the Test column", async () => {
    const root = await temporary()
    try {
      const backslash = String.fromCharCode(92)
      const row = `| AC1.1 | R1 | a ${backslash}| b | when | then |  |`
      await write(root, "SPEC.md", spec(["", ...AC_TABLE.slice(0, 2), row]))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an AC table without an R column reports the gap once, not per requirement", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        spec(["", "| AC | Given | When | Then | Test |", "|---|---|---|---|---|", "| AC1.1 | g | w | t | t.test.ts |"]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      const findings = findingsOf(result)
      expect(findings.some((finding) => finding.detail === "AC table lacks R column")).toBe(true)
      expect(findings.some((finding) => finding.detail.includes("has no acceptance criterion"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a traceability-only table is not an AC table", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", spec(["", "| R | AC | Task |", "|---|---|---|", "| R1 | AC1.1 | T1 |"]))
      const details = findingsOf(await lintContext({ root, target: "SPEC.md" })).map((finding) => finding.detail)
      expect(details).toContain("no acceptance criteria")
      expect(details.some((detail) => detail.includes("has no acceptance criterion"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a Notes column before Test does not hide Test", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        spec([
          "",
          "| AC | R | Given | When | Then | Notes | Test |",
          "|---|---|---|---|---|---|---|",
          "| AC1.1 | R1 | g | w | t | note |  |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N5/N13: non-goals accept every documented form; the count stays 3–7.
describe("non-goals forms", () => {
  const spec = (section: string[]): string =>
    ["# SPEC", "", ...section, "", "## Requirements", "", "- R1 — shall work.", "", ...AC_TABLE].join("\n")

  const nonGoalMajor = (outcome: ContextLintOutcome): boolean =>
    majors(outcome).some((finding) => finding.detail.includes("non-goals"))

  for (const [name, section] of [
    ["numbered heading + bullets", ["## 1. Non-goals", "", "- a", "- b", "- c"]],
    ["numbered Russian heading + numbered list", ["## 2. Не цели", "", "1. a", "2. b", "3. c"]],
    ["headerless table rows", ["## Non-goals", "", "| a |", "| b |", "| c |"]],
    ["paragraphs separated by blank lines", ["## Non-goals", "", "the first", "", "the second", "", "the third"]],
    ["inline semicolons", ["Non-goals: a; b; c"]],
    ["inline comma and conjunction", ["Non-goals: a, b and c"]],
    ["inline numbered", ["Non-goals: 1) a 2) b 3) c"]],
  ] as const) {
    test(`${name} count as 3 non-goals`, async () => {
      const root = await temporary()
      try {
        await write(root, "SPEC.md", spec([...section]))
        expect(nonGoalMajor(await lintContext({ root, target: "SPEC.md" }))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test("an out-of-range numbered heading still fails", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", spec(["## 3. Non-goals", "", "- a", "- b"]))
      expect(nonGoalMajor(await lintContext({ root, target: "SPEC.md" }))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N6/N7: numbered section headings, DoD wording, table requirements and subheadings.
describe("section heading forms", () => {
  test("numbered Requirements and Acceptance criteria headings are recognized", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## 1. Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## 4. Requirements",
          "",
          "- R1 — shall work.",
          "",
          "## 5. Acceptance criteria",
          "",
          ...AC_TABLE,
        ].join("\n"),
      )
      const details = findingsOf(await lintContext({ root, target: "SPEC.md" })).map((finding) => finding.detail)
      expect(details).not.toContain("no numbered requirements")
      expect(details).not.toContain("no acceptance criteria")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("requirements table rows count as R", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "| ID | Requirement |",
          "|---|---|",
          "| R1 | shall work |",
          "",
          ...AC_TABLE,
        ].join("\n"),
      )
      const details = findingsOf(await lintContext({ root, target: "SPEC.md" })).map((finding) => finding.detail)
      expect(details).not.toContain("no numbered requirements")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("«готовност» satisfies the definition of done", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "- R1 — shall work.",
          "",
          ...AC_TABLE,
          "",
          "## Готовность",
          "",
          "- всё зелёное",
        ].join("\n"),
      )
      const details = findingsOf(await lintContext({ root, target: "SPEC.md" })).map((finding) => finding.detail)
      expect(details).not.toContain("no definition of done")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a numbered open-questions heading with subheadings allows TBD", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        `${VALID_AGENTS}\n\n## 10. Открытые вопросы\n\n### Q1\n\n- TBD: owner?\n\n### Q2\n\n- TODO: date?\n`,
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N10: only `<...>` (three or more dots) and TODO/TBD/FIXME are placeholders.
describe("placeholder policy", () => {
  test("tags and named slots are not placeholders", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\nUse <DoD> and <name> in the template.\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N8: a caller abort must win over a completed large read.
describe("abort", () => {
  test("an abort observed right after the read is E_ABORTED", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n`)
      // Structural AbortSignal double: the first two checks (entry, loop head) pass,
      // the third (after readFile) reports the abort. Base has no third check.
      let calls = 0
      const signal = {
        get aborted() {
          calls += 1
          return calls > 2
        },
      } as unknown as AbortSignal
      const result = await lintContext({ root, target: "AGENTS.md", signal })
      expect(result).toMatchObject({ ok: false, code: "E_ABORTED" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("abort during a 1.9 MB file returns E_ABORTED", async () => {
    const root = await temporary()
    try {
      const line = `- rule ${"x".repeat(90)}`
      await write(root, "docs/x.md", "# X")
      await write(root, "AGENTS.md", `${Array.from({ length: 19_000 }, () => line).join("\n")}\n[x](docs/x.md)\n`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1)
      const result = await lintContext({
        root,
        target: "AGENTS.md",
        maxFileBytes: 5_000_000,
        signal: controller.signal,
      })
      clearTimeout(timer)
      expect(result).toMatchObject({ ok: false, code: "E_ABORTED" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Contract: schema id, empty-path parity and the new tool limits.
describe("contract", () => {
  test("the result carries its schema id and the raw tool output validates", async () => {
    const harness = await createHarness()
    try {
      await writeFile(path.join(harness.directory, "AGENTS.md"), VALID_AGENTS, "utf8")
      const body = await runTool(harness, "orch_uni_context_lint", { path: "AGENTS.md" })
      expect(body).toMatchObject({ schema: "context-lint/v1", ok: true, verdict: "pass" })
      const text = ["Report.", "```json", JSON.stringify(body), "```"].join("\n")
      const validated = await runTool(harness, "orch_uni_validate_report", { text, schema: "context-lint/v1" })
      expect(validated).toMatchObject({ valid: true, schema: "context-lint/v1" })
    } finally {
      harness.dispose()
    }
  })

  test("an empty target is E_INPUT in the library, like the tool", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      expect(await lintContext({ root, target: "" })).toMatchObject({ ok: false, code: "E_INPUT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the tool passes max_file_bytes and max_findings through", async () => {
    const harness = await createHarness()
    try {
      await writeFile(path.join(harness.directory, "AGENTS.md"), VALID_AGENTS, "utf8")
      expect(await runTool(harness, "orch_uni_context_lint", { path: "AGENTS.md", max_file_bytes: 100 })).toMatchObject(
        {
          ok: false,
          code: "E_LIMIT_FILE",
        },
      )
      await writeFile(
        path.join(harness.directory, "AGENTS.md"),
        `${VALID_AGENTS}\n${Array.from({ length: 3 }, () => `- rule: ${"v".repeat(50)}`).join("\n")}\n`,
        "utf8",
      )
      const capped = await runTool(harness, "orch_uni_context_lint", { path: "AGENTS.md", max_findings: 1 })
      expect(capped).toMatchObject({ ok: true, truncated: true })
    } finally {
      harness.dispose()
    }
  })
})

/** A valid SPEC skeleton with a caller-supplied AC table body. */
function specWith(table: string, extra: string[] = []): string {
  return [
    "# SPEC",
    "",
    "## Non-goals",
    "",
    "- a",
    "- b",
    "- c",
    "",
    "## Requirements",
    "",
    "- R1 — shall export.",
    "- R2 — shall import.",
    "",
    ...table.split("\n"),
    ...extra,
  ].join("\n")
}

const AC_HEADER_ROW = "| AC | R | Given | When | Then | Test |"
const AC_SEPARATOR_ROW = "|---|---|---|---|---|---|"

// R3-A: inline code is markup, not an empty cell; AC/R ids keep their text.
describe("R3-A backtick AC cells", () => {
  const assertClean = (result: ContextLintOutcome): void => {
    const findings = findingsOf(result)
    expect(findings.some((finding) => finding.detail === "AC row has no test")).toBe(false)
    expect(findings.some((finding) => finding.detail.startsWith("R1 has no"))).toBe(false)
  }

  test("backticked AC, R and Test cells parse cleanly and map ids", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specWith(
          `${AC_HEADER_ROW}\n${AC_SEPARATOR_ROW}\n| \`AC1.1\` | \`R1\` | given | when | then | \`test_export\` |`,
        ),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      assertClean(result)
      expect(majors(result).some((finding) => finding.detail.startsWith("R2 has no"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("plain, mixed and headerless rows all keep their Test value", async () => {
    const root = await temporary()
    try {
      const rows = [
        `${AC_HEADER_ROW}`,
        `${AC_SEPARATOR_ROW}`,
        "| AC1.1 | R1 | given | when | then | export.test.ts |",
        "| `AC1.2` | R1 | given | when | then | import.test.ts |",
        "| AC1.3 | R1 | given | when | then | `roundtrip.test.ts` |",
        "",
        "| AC2.1 | R2 | given | when | then | `headerless.test.ts` |",
      ].join("\n")
      await write(root, "SPEC.md", specWith(rows))
      const result = await lintContext({ root, target: "SPEC.md" })
      assertClean(result)
      expect(findingsOf(result).some((finding) => finding.detail === "AC table lacks header")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the docs AC template row (a backticked test_... placeholder) is not an empty test", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specWith(`${AC_HEADER_ROW}\n${AC_SEPARATOR_ROW}\n| AC1.1 | R1 | <...> | <...> | <...> | \`test_...\` |`),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "AC row has no test")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N44: link candidates are capped; probes are bounded by candidates.
describe("R3-B link loop bounds", () => {
  test("20k links finish and every candidate is checked under the candidate cap", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      const links = Array.from({ length: 20_000 }, (_, index) => `[x](docs/missing-${index}.md)`)
      await write(
        root,
        "AGENTS.md",
        ["# AGENTS", "", "## Commands", "", "bun test", "", "## Verification", "", "bun test", "", ...links].join("\n"),
      )
      const started = Date.now()
      const result = await lintContext({ root, target: "AGENTS.md", maxLines: 100_000, maxTokens: 1_000_000 })
      const elapsed = Date.now() - started
      // N54: measured ~1.4-1.5 s standalone (bun 1.4.2, Windows) for 20k distinct
      // broken targets after the streaming rewrite; 3000 ms keeps a ~2x margin.
      expect(elapsed).toBeLessThan(3000)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Exactly 20k candidates fit under the cap: the list is complete, so the
      // candidate marker must not fire.
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("link candidates truncated"))).toBe(false)
      // Broken links are bounded by the per-file finding sink: the excess is
      // replaced by a MAJOR truncated marker, never dropped silently.
      expect(findingsOf(result).filter((finding) => finding.kind === "broken_link").length).toBe(100)
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("findings truncated at 100 MAJOR"))).toBe(
        true,
      )
      expect(result.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an abort during the link loop is E_ABORTED", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      const links = Array.from({ length: 20_000 }, (_, index) => `[x](docs/missing-${index}.md)`)
      await write(
        root,
        "AGENTS.md",
        ["# AGENTS", "", "## Commands", "", "bun test", "", "## Verification", "", "bun test", "", ...links].join("\n"),
      )
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1)
      const result = await lintContext({ root, target: "AGENTS.md", signal: controller.signal })
      clearTimeout(timer)
      expect(result).toMatchObject({ ok: false, code: "E_ABORTED" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a junction outside the root plus a missing link is not a MAJOR", async () => {
    const root = await temporary()
    const outside = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      if (!(await directoryLink(outside, path.join(root, "out")))) return
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [out](out/missing.md).`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("a network-like target is skipped and normal links still work", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(
        root,
        "AGENTS.md",
        `${VALID_AGENTS}\n[share](//10.255.255.1/share/x.md) [docs](docs/x.md) [gone](docs/gone.md)\n`,
      )
      const started = Date.now()
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(Date.now() - started).toBeLessThan(2000)
      const broken = findingsOf(result).filter((finding) => finding.kind === "broken_link")
      expect(broken.length).toBe(1)
      expect(broken[0]?.detail).toContain("docs/gone.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R8-1/R8-2/R8-3: the link scanner is a forward state machine (linear, no
// stack, title-aware) and HTML close tags tolerate whitespace before `>`.
describe("R8 link scanner and HTML close tags", () => {
  const brokenLinks = (result: ContextLintOutcome): string[] =>
    findingsOf(result)
      .filter((finding) => finding.kind === "broken_link")
      .map((finding) => finding.detail)

  test("closed `](`+`)` lines at 5k/10k/20k/40k stay linear", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      const budget = new Map([
        [5_000, 500],
        [10_000, 750],
        [20_000, 1_000],
        [40_000, 2_000],
      ])
      for (const size of [5_000, 10_000, 20_000, 40_000]) {
        await write(root, "AGENTS.md", `${VALID_AGENTS}\n${"](".repeat(size)}${")".repeat(size)}\n`)
        const started = performance.now()
        const result = await lintContext({ root, target: "AGENTS.md", maxLines: 200_000, maxTokens: 5_000_000 })
        const elapsed = performance.now() - started
        expect(result.ok).toBe(true)
        expect(elapsed, `${size} \`](\`+\`)\` in ${elapsed} ms`).toBeLessThan(budget.get(size)!)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("40k unclosed `](` and an 80k `<` line stay linear", async () => {
    const root = await temporary()
    try {
      for (const line of ["](".repeat(40_000), "<".repeat(80_000)]) {
        await write(root, "AGENTS.md", `${VALID_AGENTS}\n${line}\n`)
        const started = performance.now()
        const result = await lintContext({ root, target: "AGENTS.md", maxLines: 200_000, maxTokens: 5_000_000 })
        const elapsed = performance.now() - started
        expect(result.ok).toBe(true)
        expect(elapsed).toBeLessThan(2_000)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an unclosed angle does not swallow a later angle link", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      for (const first of ["missing.md", "docs/keep.md"]) {
        await write(root, "AGENTS.md", `${VALID_AGENTS}\n[v](<${first} [w](<missing2.md>)\n`)
        const result = await lintContext({ root, target: "AGENTS.md" })
        expect(result.ok).toBe(true)
        const broken = result.ok
          ? result.files[0]?.findings
              .filter((finding) => finding.kind === "broken_link")
              .map((finding) => finding.detail)
          : []
        expect(broken, first).toContain('missing path "missing2.md"')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an angle destination may contain a literal `](`", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n[v](<docs/a](b.md>)\n`)
      const missing = await lintContext({ root, target: "AGENTS.md" })
      expect(missing.ok).toBe(true)
      const broken = missing.ok
        ? missing.files[0]?.findings
            .filter((finding) => finding.kind === "broken_link")
            .map((finding) => finding.detail)
        : []
      expect(broken).toContain('missing path "docs/a](b.md"')

      await write(root, "docs/a](b.md", "# keep")
      const present = await lintContext({ root, target: "AGENTS.md" })
      expect(present.ok).toBe(true)
      const stillBroken = present.ok
        ? present.files[0]?.findings.filter((finding) => finding.kind === "broken_link")
        : []
      expect(stillBroken).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("titles hide `)` and `](`; escaped quotes and angle destinations parse", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "[a](missing.md 'a)b')",
          '[b](missing.md "a)b")',
          "[c](missing.md 'a](b')",
          "[d](docs/keep.md 'a](b) c')",
          '[e](docs/keep.md "it\\"s) ok")',
          "[f](<docs/keep.md>)",
          "[g](<docs/missing-angle.md>)",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = brokenLinks(result)
      expect(broken.filter((detail) => detail.includes('"missing.md"')).length).toBe(3)
      expect(broken.filter((detail) => detail.includes("docs/keep.md")).length).toBe(0)
      expect(broken.filter((detail) => detail.includes("missing-angle.md")).length).toBe(1)
      expect(broken.length).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an already-aborted signal is E_ABORTED before scanning", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n[x](docs/missing.md)\n`)
      const controller = new AbortController()
      controller.abort()
      const result = await lintContext({ root, target: "AGENTS.md", signal: controller.signal })
      expect(result).toMatchObject({ ok: false, code: "E_ABORTED" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("`</code >` and `</pre >` close on whitespace; the exact close still works", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "See <code>x</code > [code](missing-code.md).",
          "See <pre>x</pre > [pre](missing-pre.md).",
          "See <CODE>x</CODE\t> [upper](missing-upper.md).",
          "See <code>x</code> [exact](missing-exact.md).",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = brokenLinks(result)
      for (const target of ["missing-code.md", "missing-pre.md", "missing-upper.md", "missing-exact.md"]) {
        expect(broken.some((detail) => detail.includes(target))).toBe(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("non-goals: a whitespace-closed `<code >` span is content, so `a, b` is one item", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        ["# SPEC", "", "## Goal", "", "x", "", "Non-goals: <code>a, b</code >, c", ""].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "2 non-goals; expected 3–7 items")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N52/N54: an unclosed angle or title rejects only its own candidate — a later
// link on the same line is still checked — and an angle destination may carry
// raw spaces, which are percent-encoded before the existence probe.
describe("N52/N54 unclosed link recovery and raw-space angle targets", () => {
  const brokenLinks = (result: ContextLintOutcome): string[] =>
    findingsOf(result)
      .filter((finding) => finding.kind === "broken_link")
      .map((finding) => finding.detail)

  test("unclosed angle and title recover, so later valid links are checked", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "[v](<missing.md [w](missing2.md)",
          "[v](missing.md 'open [w](missing2.md)",
          "[a](<gone.md [b](missing3.md) [c](missing4.md)",
        ].join("\n"),
      )
      const broken = brokenLinks(await lintContext({ root, target: "AGENTS.md" }))
      expect(broken.filter((detail) => detail.includes("missing2.md")).length).toBe(2)
      expect(broken.filter((detail) => detail.includes("missing3.md")).length).toBe(1)
      expect(broken.filter((detail) => detail.includes("missing4.md")).length).toBe(1)
      expect(broken.filter((detail) => detail.includes("gone.md")).length).toBe(0)
      expect(broken.length).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("angle target with a raw space is broken; existing and %20 targets pass", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/my file.md", "# spaced")
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "[v](<missing file.md>)",
          "[ok](<docs/my file.md>)",
          "[pad](< docs/my file.md >)",
          "[enc](docs/my%20file.md)",
          "[angle](<docs/my%20file.md>)",
        ].join("\n"),
      )
      const broken = brokenLinks(await lintContext({ root, target: "AGENTS.md" }))
      expect(broken).toEqual(['missing path "missing file.md"'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("40k unclosed angle candidates plus a valid tail stay linear", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        [VALID_AGENTS, `${"[x](<docs/keep.md ".repeat(40_000)}[ok](missing-tail.md)`].join("\n"),
      )
      const started = performance.now()
      const result = await lintContext({ root, target: "AGENTS.md", maxLines: 200_000, maxTokens: 5_000_000 })
      const elapsed = performance.now() - started
      expect(result.ok).toBe(true)
      expect(elapsed, `40k unclosed angle in ${elapsed} ms`).toBeLessThan(2_000)
      expect(brokenLinks(result)).toEqual(['missing path "missing-tail.md"'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// R3-C: one global cap over every finding, MAJOR first, overflow marked and closed.
describe("R3-C global finding cap", () => {
  test("500 files with 101 MAJOR each stay bounded and keep a MAJOR marker in closing_list", async () => {
    const root = await temporary()
    try {
      const body = [
        "# AGENTS",
        "",
        "## Commands",
        "",
        "bun test",
        "",
        "## Verification",
        "",
        "bun test",
        "",
        ...Array.from({ length: 101 }, () => "<...>"),
      ].join("\n")
      for (let index = 0; index < 500; index += 1) await write(root, `d${index}/AGENTS.md`, body)
      const result = await lintContext({ root })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files.flatMap((file) => file.findings)
      expect(findings.length).toBeLessThanOrEqual(1001)
      expect(JSON.stringify(result).length).toBeLessThan(1_500_000)
      expect(result.truncated).toBe(true)
      expect(result.verdict).toBe("fail")
      const marker = findings.find((finding) => finding.detail.includes("further MAJOR findings are not listed"))
      expect(marker).toMatchObject({ severity: "MAJOR" })
      expect(result.closing_list).toContain(marker?.id ?? "")
      expect(result.closing_list.length).toBe(findings.filter((finding) => finding.severity === "MAJOR").length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("MAJOR fits: MINOR are dropped first and an INFO marker is added", async () => {
    const root = await temporary()
    try {
      const tokens = Array.from({ length: 40 }, (_, index) => `- rule ${index}: ${"q".repeat(50)}`)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n${[...tokens, ...tokens].join("\n")}\n<...>\n`)
      const result = await lintContext({ root, target: "AGENTS.md", maxTotalFindings: 3 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files.flatMap((file) => file.findings)
      expect(findings.length).toBe(4) // maxTotal (1 MAJOR + 2 MINOR) + one INFO marker
      expect(findings.filter((finding) => finding.severity === "MAJOR").length).toBe(1)
      expect(findings.at(-1)?.detail).toContain("findings truncated at 3")
      expect(result.truncated).toBe(true)
      expect(result.verdict).toBe("fail")
      expect(result.closing_list).toEqual(
        findings.filter((finding) => finding.severity === "MAJOR").map((finding) => finding.id),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ids stay contiguous after the global cap", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n<...>\nTODO: x.\n`)
      const result = await lintContext({ root, target: "AGENTS.md", maxTotalFindings: 1 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const ids = result.files.flatMap((file) => file.findings).map((finding) => finding.id)
      expect(ids).toEqual(ids.map((_id, index) => `CTX-${String(index + 1).padStart(3, "0")}`))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R3-D: headerless rows are inspected even next to a valid AC table.
describe("R3-D headerless AC rows", () => {
  test("a headerless empty Test is MAJOR even when a normal AC table exists", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specWith(
          `${AC_HEADER_ROW}\n${AC_SEPARATOR_ROW}\n| AC1.1 | R1 | given | when | then | export.test.ts |\n\n| AC2.1 | R2 | given | when | then |  |`,
        ),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
      expect(majors(result).some((finding) => finding.detail.startsWith("R2 has no"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a headerless R2 row covers R2 and a 5-cell row is MAJOR, not a pass", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specWith(
          `${AC_HEADER_ROW}\n${AC_SEPARATOR_ROW}\n| AC1.1 | R1 | given | when | then | export.test.ts |\n\n| AC2.1 | R2 | given | when | then |`,
        ),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
      expect(majors(result).some((finding) => finding.detail.startsWith("R2 has no"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a Tests plural header and an ID-first shape still find Test", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "",
          "| ID | AC | R | Given | When | Then | Notes | Tests |",
          "|---|---|---|---|---|---|---|---|",
          "| 1 | AC1.1 | R1 | given | when | then | note |  |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "AC row has no test")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N13 / R3-5: every documented non-goals form, counting top-level items only.
describe("non-goals forms (N13)", () => {
  const spec = (section: string[]): string =>
    ["# SPEC", "", ...section, "", "## Requirements", "", "- R1 — shall work.", "", ...AC_TABLE].join("\n")

  const nonGoalMajor = (outcome: ContextLintOutcome): boolean =>
    majors(outcome).some((finding) => finding.detail.includes("non-goals"))

  for (const [name, section] of [
    ["inline after heading", ["## Non-goals: a; b; c"]],
    ["combined goal and non-goals heading", ["## 2. Goal and non-goals", "", "- a", "- b", "- c"]],
    ["wrapped label with bullets", ["**Non-goals:**", "", "- a", "- b", "- c"]],
    ["sub-bullets belong to the parent", ["## Non-goals", "", "- a", "  - a1", "- b", "- c"]],
    ["continuation lines are not items", ["## Non-goals", "", "- a", "  continued detail", "- b", "- c"]],
  ] as const) {
    test(`${name} count as 3 non-goals`, async () => {
      const root = await temporary()
      try {
        await write(root, "SPEC.md", spec([...section]))
        expect(nonGoalMajor(await lintContext({ root, target: "SPEC.md" }))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test("two top-level items plus sub-bullets still fail", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", spec(["## Non-goals", "", "- a", "  - a1", "  - a2", "- b"]))
      expect(nonGoalMajor(await lintContext({ root, target: "SPEC.md" }))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N16: nested fences, indented code and <pre> are code; duplicates read the mask.
describe("code mask (N16)", () => {
  test("a 4-backtick fence is not closed by 3 backticks", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "",
          "````md",
          "```",
          "[gone](docs/gone.md)",
          "TODO <...>",
          "```",
          "````",
          "[outside](docs/missing.md)",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = findingsOf(result).filter((finding) => finding.kind === "broken_link")
      expect(broken.length).toBe(1)
      expect(broken[0]?.detail).toContain("docs/missing.md")
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("indented code and <pre> are masked", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/x.md", "# X")
      await write(
        root,
        "AGENTS.md",
        [
          VALID_AGENTS,
          "",
          "## Rules",
          "",
          "    [gone](docs/gone.md)",
          "    TODO <...>",
          "",
          "<pre>",
          "[pre](docs/pre-gone.md)",
          "</pre>",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "broken_link")).toBe(false)
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("placeholder"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a duplicate inside indented code is not a duplicate", async () => {
    const root = await temporary()
    try {
      const repeated = "bun run tools/kit-verify.ts --proj ../some/project/directory"
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n${repeated}\n\n    ${repeated}\n`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.kind === "duplicate")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N18 / N19: Russian verification heading and requirements need real R lines.
describe("sections and requirements (N18/N19)", () => {
  test("## Проверка satisfies verification", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", "# AGENTS\n\n## Команды\n\n- bun test\n\n## Проверка\n\n- всё зелёное.\n")
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail.includes("verification"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a Requirements heading without an R line is MAJOR", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        ["# SPEC", "", "## Non-goals", "", "- a", "- b", "- c", "", "## Requirements", "", "TBD."].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "no numbered requirements")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N17: date/version placement in the first three lines.
describe("first lines (N17)", () => {
  test("a date in the first three lines is MINOR", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `# AGENTS\n2026-01-01 v1.2.3\n${VALID_AGENTS}`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(
        findingsOf(result).some(
          (finding) => finding.severity === "MINOR" && finding.detail === "date or version in the first three lines",
        ),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a date below the third line is not reported", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `# AGENTS\n\n\n2026-01-01 v1.2.3\n${VALID_AGENTS}`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "date or version in the first three lines")).toBe(
        false,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Contract: SPEC word budget and the CTX-000 / truncated report shapes.
describe("contract: max_words and CTX-000", () => {
  const words = (count: number): string => Array.from({ length: count }, () => "word").join(" ")

  const wordSpec = (count: number): string =>
    [
      "# SPEC",
      "",
      "## Non-goals",
      "",
      "- a",
      "- b",
      "- c",
      "",
      "## Requirements",
      "",
      "- R1 — shall export.",
      "",
      ...AC_TABLE,
      "",
      words(count),
    ].join("\n")

  test("the default SPEC budget is 1500 words; maxWords raises it to the ceiling", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", wordSpec(1600))
      const strict = await lintContext({ root, target: "SPEC.md" })
      expect(majors(strict, "budget").some((finding) => finding.detail.includes("1500"))).toBe(true)
      const lenient = await lintContext({ root, target: "SPEC.md", maxWords: 2000 })
      expect(majors(lenient, "budget")).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the tool passes max_words through", async () => {
    const harness = await createHarness()
    try {
      await writeFile(path.join(harness.directory, "SPEC.md"), wordSpec(1600), "utf8")
      const strict = (await runTool(harness, "orch_uni_context_lint", { path: "SPEC.md" })) as {
        files: { findings: { detail: string }[] }[]
      }
      expect(strict.files[0]?.findings.some((finding) => finding.detail.includes("1500"))).toBe(true)
      const lenient = (await runTool(harness, "orch_uni_context_lint", { path: "SPEC.md", max_words: 2000 })) as {
        files: { findings: { detail: string }[] }[]
      }
      expect(lenient.files[0]?.findings.some((finding) => finding.detail.includes("1500"))).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  test("a synthetic CTX-000 SGR validates and a truncated pass is warned", async () => {
    const harness = await createHarness()
    try {
      const failure = {
        schema: "context-lint/v1",
        ok: true,
        verdict: "fail",
        closing_list: ["CTX-000"],
        truncated: true,
        files: [
          {
            path: "-",
            kind: "other",
            lines: 0,
            words: 0,
            chars: 0,
            tokens_est: 0,
            findings: [
              {
                id: "CTX-000",
                severity: "MAJOR",
                kind: "missing_section",
                evidence: "E_NO_FILES",
                detail: "no target files",
                fix: "pass a path",
              },
            ],
          },
        ],
        summary: "E_NO_FILES",
      }
      const text = ["Report.", "```json", JSON.stringify(failure), "```"].join("\n")
      const validated = await runTool(harness, "orch_uni_validate_report", { text, schema: "context-lint/v1" })
      expect(validated).toMatchObject({ valid: true })
      expect((validated as { warnings: string[] }).warnings.some((warning) => warning.includes("truncated"))).toBe(true)

      const passing = { ...failure, verdict: "pass", closing_list: [], files: [{ ...failure.files[0], findings: [] }] }
      const passText = ["Report.", "```json", JSON.stringify(passing), "```"].join("\n")
      const passValidated = await runTool(harness, "orch_uni_validate_report", {
        text: passText,
        schema: "context-lint/v1",
      })
      expect(passValidated).toMatchObject({ valid: true })
      expect(
        (passValidated as { warnings: string[] }).warnings.some((warning) =>
          warning.includes("truncated=true with verdict=pass"),
        ),
      ).toBe(true)
    } finally {
      harness.dispose()
    }
  })
})

// R4-1: no per-file broken-link cap; 21/25 broken links stay MAJOR, never 20.
describe("R4-1 broken links are not capped", () => {
  const links = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `[x](docs/missing-${index}.md)`)

  for (const count of [21, 25]) {
    test(`${count} broken links yield ${count} MAJOR closing ids`, async () => {
      const root = await temporary()
      try {
        await write(root, "AGENTS.md", [VALID_AGENTS, ...links(count)].join("\n"))
        const result = await lintContext({ root, target: "AGENTS.md", maxLines: 10_000, maxTokens: 1_000_000 })
        expect(result.ok).toBe(true)
        if (!result.ok) return
        const broken = result.files.flatMap((file) => file.findings).filter((finding) => finding.kind === "broken_link")
        expect(broken.length).toBe(count)
        expect(broken.every((finding) => finding.severity === "MAJOR")).toBe(true)
        expect(result.closing_list.length).toBe(count)
        expect(result.verdict).toBe("fail")
        expect(result.truncated).toBeFalsy()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

// R4-2/R6-2: the candidate cap is 20 000, so 2001 links are not a false fail;
// above the cap a capped list is an incomplete result: MAJOR marker, no pass.
describe("R4-2/R6-2 link candidate cap", () => {
  const marker = (
    result: ContextLintOutcome,
  ): { severity: string; detail: string; id: string; evidence: string } | undefined => {
    if (!result.ok) return undefined
    return result.files
      .flatMap((file) => file.findings)
      .find((finding) => finding.detail.startsWith("link candidates truncated")) as
      | { severity: string; detail: string; id: string; evidence: string }
      | undefined
  }
  const lint = async (root: string) =>
    await lintContext({ root, target: "AGENTS.md", maxLines: 100_000, maxTokens: 1_000_000 })

  test("2001 valid links pass: the old 2000 cap no longer false-fails", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      const links = Array.from({ length: 2001 }, (_, index) => `[v](docs/keep.md#${index})`)
      await write(root, "AGENTS.md", [VALID_AGENTS, ...links].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("pass")
      expect(result.truncated).toBeFalsy()
      expect(marker(result)).toBeUndefined()
      expect(result.files.flatMap((file) => file.findings).length).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("2001 broken links fail on broken links, not on a candidate marker", async () => {
    const root = await temporary()
    try {
      const links = Array.from({ length: 2001 }, (_, index) => `[x](docs/missing-${index}.md)`)
      await write(root, "AGENTS.md", [VALID_AGENTS, ...links].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("fail")
      expect(marker(result)).toBeUndefined()
      // The sink caps the list at 100 MAJOR and replaces the rest with one marker.
      expect(
        result.files.flatMap((file) => file.findings).filter((finding) => finding.kind === "broken_link").length,
      ).toBe(100)
      expect(
        result.files[0]?.findings.some((finding) => finding.detail.startsWith("findings truncated at 100 MAJOR")),
      ).toBe(true)
      expect(result.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("20 001 valid links pass under the 50k cap", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      const links = Array.from({ length: 20_001 }, (_, index) => `[v](docs/keep.md#${index})`)
      await write(root, "AGENTS.md", [VALID_AGENTS, ...links].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("pass")
      expect(result.truncated).toBeFalsy()
      expect(marker(result)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("50 001 valid links are capped and documented: MAJOR marker with file:1 evidence", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      const links = Array.from({ length: 50_001 }, (_, index) => `[v](docs/keep.md#${index})`)
      await write(root, "AGENTS.md", [VALID_AGENTS, ...links].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("fail")
      expect(result.truncated).toBe(true)
      const found = marker(result)
      expect(found?.severity).toBe("MAJOR")
      expect(found?.evidence).toBe("AGENTS.md:1")
      expect(found?.detail).toContain("50000")
      expect(result.closing_list).toContain(found?.id ?? "")
      // A deterministic rerun is identical: the marker must not promise a rerun.
      expect(found?.detail).not.toContain("next run")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

// N53/N56: link targets are streamed from the scanner one at a time (no
// candidate array) and the signal is checked per line and inside a long line,
// so one huge line is capped deterministically and a timer abort wins.
describe("N53/N56 streamed link checks", () => {
  const linkMarker = (result: ContextLintOutcome): string | undefined =>
    result.ok
      ? result.files
          .flatMap((file) => file.findings)
          .find((finding) => finding.detail.startsWith("link candidates truncated"))?.detail
      : undefined

  test("50 000 links on one line pass; the 50 001st truncates the list", async () => {
    const root = await temporary()
    try {
      await write(root, "docs/keep.md", "# keep")
      for (const [count, truncated] of [
        [50_000, false],
        [50_001, true],
      ] as const) {
        const links = Array.from({ length: count }, (_, index) => `[v](docs/keep.md#${index})`).join(" ")
        await write(root, "AGENTS.md", `${VALID_AGENTS}\n${links}\n`)
        const result = await lintContext({ root, target: "AGENTS.md", maxLines: 100_000, maxTokens: 2_000_000 })
        expect(result.ok, `${count} links on one line`).toBe(true)
        if (!result.ok) return
        expect(result.verdict, `${count} links on one line`).toBe(truncated ? "fail" : "pass")
        expect(linkMarker(result) !== undefined, `${count} links on one line`).toBe(truncated)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("abort(100 ms) on 20k short links is E_ABORTED in about the pre-link time", async () => {
    const root = await temporary()
    try {
      const links = Array.from({ length: 20_000 }, (_, index) => `[x](d${index}.md)`)
      await write(root, "AGENTS.md", [VALID_AGENTS, ...links].join("\n"))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 100)
      const started = performance.now()
      const result = await lintContext({ root, target: "AGENTS.md", signal: controller.signal })
      const elapsed = performance.now() - started
      clearTimeout(timer)
      expect(result).toMatchObject({ ok: false, code: "E_ABORTED" })
      // Measured ~300 ms standalone (100 ms timer + the pre-link mask/checks
      // that run before checkLinks); 1000 ms only fails a real regression.
      expect(elapsed, `abort(100 ms) returned in ${Math.round(elapsed)} ms`).toBeLessThan(1000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// R4-3/R4-5: AC tables need Given/When/Then + Test; R ids never come from AC R cells.
describe("R4-3 acceptance criteria and traceability", () => {
  const specBody = (lines: string[]): string => ["# SPEC", "", ...lines].join("\n")
  const details = (result: ContextLintOutcome): string[] => findingsOf(result).map((finding) => finding.detail)

  test("a headed AC table without a Test column is MAJOR even next to a headerless row", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "- R2 — shall import.",
          "",
          "| AC | R | Given | When | Then | Notes |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | note |",
          "",
          "| AC2.1 | R2 | given | when | then | import.test.ts |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "AC table lacks Test column")).toBe(true)
      expect(details(result)).not.toContain("no acceptance criteria")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an AC-first traceability table is not an AC table", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "",
          "| AC | R | Task | Test |",
          "|---|---|---|---|",
          "| AC1 | R1 | task | export.test.ts |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "no acceptance criteria")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an R-first traceability table declares requirements but not acceptance", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "| R | AC | Task | Test |",
          "|---|---|---|---|",
          "| R1 | AC1 | task | export.test.ts |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).not.toContain("no numbered requirements")
      expect(majors(result).some((finding) => finding.detail === "no acceptance criteria")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a Requirements heading with only an AC table has no numbered requirements", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | export.test.ts |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "no numbered requirements")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prose under Requirements is not a numbered requirement set", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "The system shall export and import.",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then | export.test.ts |",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(majors(result).some((finding) => finding.detail === "no numbered requirements")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a backticked headerless AC row is acceptance evidence", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
          "",
          "| `AC1.1` | R1 | given | when | then | export.test.ts |",
          "",
          "## Definition of done",
          "",
          "- checks green",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).not.toContain("no acceptance criteria")
      expect(details(result)).toContain("AC table lacks header")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R4-4: structural checks read the full mask; AC/requirements read the fence mask.
describe("R4-4 mask split", () => {
  const details = (result: ContextLintOutcome): string[] => findingsOf(result).map((finding) => finding.detail)
  const specBody = (lines: string[]): string => ["# SPEC", "", ...lines].join("\n")
  const cleanSpec = (requirement: string): string =>
    specBody([
      "## Non-goals",
      "",
      "- a",
      "- b",
      "- c",
      "",
      "## Requirements",
      "",
      requirement,
      "",
      "| AC | R | Given | When | Then | Test |",
      "|---|---|---|---|---|---|",
      "| AC1.1 | R1 | given | when | then | export.test.ts |",
      "",
      "## Definition of done",
      "",
      "- checks green",
    ])

  test("an inline `and` inside backticks is not a requirement chain", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", cleanSpec("- R1 — shall `export and import`."))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).not.toContain("requirement joins multiple behaviors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a real `and` outside code is still a MINOR chain", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", cleanSpec("- R1 — shall export and import."))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).toContain("requirement joins multiple behaviors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("`and` inside parentheses is not a top-level chain", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", cleanSpec("- R1 — shall export (fast and safe)."))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).not.toContain("requirement joins multiple behaviors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("`and` inside square brackets is not a top-level chain", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", cleanSpec("- R1 — shall export [alpha and beta]."))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).not.toContain("requirement joins multiple behaviors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("`и` inside parentheses is not a top-level chain", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", cleanSpec("- R1 — умеет экспорт (быстро и надёжно)."))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).not.toContain("requirement joins multiple behaviors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a top-level `и` is still a MINOR chain", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", cleanSpec("- R1 — умеет экспорт и импорт."))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(details(result)).toContain("requirement joins multiple behaviors")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("verification that exists only as inline code is a MINOR, not pass", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        [
          "# AGENTS.md",
          "",
          "## Commands",
          "",
          "bun test",
          "",
          "## Boundaries",
          "",
          "- Never commit secrets.",
          "",
          "## Checks",
          "",
          "`verification` and `definition of done` live in code.",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(details(result)).toContain("no verification / definition of done")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a real heading with a fenced body passes", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        [
          "# AGENTS.md",
          "",
          "## Commands",
          "",
          "bun test",
          "",
          "## Boundaries",
          "",
          "- Never commit secrets.",
          "",
          "## Verification",
          "",
          "```sh",
          "bun test",
          "```",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      expect(details(result)).not.toContain("no verification / definition of done")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R4-6: a paragraph is one item; inline splitting is top-level only; a wrapped
// 2-space list under a bold label is top-level.
describe("R4-6 non-goals counting", () => {
  const specBody = (lines: string[]): string => ["# SPEC", "", ...lines].join("\n")
  const countFinding = (result: ContextLintOutcome): string | undefined =>
    majors(result).find((finding) => finding.detail.includes("non-goals"))?.detail

  test("an 8-line paragraph is one item and fails the 3–7 contract", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "This feature deliberately does not track analytics,",
          "does not send notifications,",
          "does not sync across devices,",
          "does not support offline mode,",
          "does not provide a mobile app,",
          "does not export to PDF,",
          "does not integrate with third parties,",
          "does not include a dashboard.",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(countFinding(result)).toBe("1 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("inline `X and Y` is two items", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody(["## Non-goals: a and b", "", "## Requirements", "", "- R1 — shall export."]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(countFinding(result)).toBe("2 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a wrapped 2-space list under a bold label is three top-level items", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody(["**Non-goals:**", "", "  - a", "  - b", "  - c", "", "## Requirements", "", "- R1 — shall export."]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(countFinding(result)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("deeper sub-bullets stay part of their parent", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specBody([
          "## Non-goals",
          "",
          "- a",
          "  - a1",
          "  - a2",
          "- b",
          "  - b1",
          "- c",
          "",
          "## Requirements",
          "",
          "- R1 — shall export.",
        ]),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(countFinding(result)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R4-7/R6-1: inner caps are reported, never silent. Long lines are no longer
// skipped: 4000 and 4001 behave the same and neither gets a marker.
describe("R4-7 inner caps are reported", () => {
  test("4000 and 4001-char clean lines both pass without a long-line marker", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", [VALID_AGENTS, "q".repeat(4000)].join("\n"))
      const atLimit = await lintContext({ root, target: "AGENTS.md", maxLines: 10_000, maxTokens: 1_000_000 })
      expect(atLimit.ok).toBe(true)
      if (!atLimit.ok) return
      expect(atLimit.verdict).toBe("pass")
      await write(root, "AGENTS.md", [VALID_AGENTS, "q".repeat(4001)].join("\n"))
      const overLimit = await lintContext({ root, target: "AGENTS.md", maxLines: 10_000, maxTokens: 1_000_000 })
      expect(overLimit.ok).toBe(true)
      if (!overLimit.ok) return
      expect(overLimit.verdict).toBe("pass")
      expect(findingsOf(overLimit).some((finding) => finding.detail.startsWith("long line"))).toBe(false)
      expect(overLimit.truncated).toBeFalsy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("20 duplicate lines produce 20 MINOR findings", async () => {
    const root = await temporary()
    try {
      const rules = Array.from({ length: 20 }, (_, index) => `- duplicate rule ${index}: ${"q".repeat(40)}`)
      await write(root, "AGENTS.md", [VALID_AGENTS, ...rules, ...rules].join("\n"))
      const result = await lintContext({ root, target: "AGENTS.md", maxLines: 10_000, maxTokens: 1_000_000 })
      expect(findingsOf(result).filter((finding) => finding.kind === "duplicate").length).toBe(20)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R6-1: long lines are scanned in full; a broken link or placeholder on a
// 4100-char line is the real finding, not a "long line skipped" marker.
describe("R6-1 long lines are parsed", () => {
  const lint = async (root: string) =>
    await lintContext({ root, target: "AGENTS.md", maxLines: 100_000, maxTokens: 1_000_000 })

  test("a 4100-char line with a broken link is a broken_link MAJOR", async () => {
    const root = await temporary()
    try {
      const link = "[bad](missing.md)"
      await write(root, "AGENTS.md", [VALID_AGENTS, "q".repeat(4100 - link.length) + link].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const broken = result.files[0]?.findings.find((finding) => finding.kind === "broken_link")
      expect(broken?.severity).toBe("MAJOR")
      expect(broken?.detail).toContain("missing.md")
      expect(result.verdict).toBe("fail")
      expect(result.closing_list).toContain(broken?.id ?? "")
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("long line"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a 4100-char line with a placeholder is a placeholder MAJOR", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", [VALID_AGENTS, `${"q".repeat(4100 - "<...>".length)}<...>`].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const placeholder = result.files[0]?.findings.find((finding) => finding.detail.startsWith('placeholder "<...>"'))
      expect(placeholder?.severity).toBe("MAJOR")
      expect(result.verdict).toBe("fail")
      expect(result.closing_list).toContain(placeholder?.id ?? "")
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("long line"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a 4100-char clean line passes with no marker", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", [VALID_AGENTS, "q".repeat(4100)].join("\n"))
      const result = await lint(root)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("pass")
      expect(result.truncated).toBeFalsy()
      expect(findingsOf(result).some((finding) => finding.detail.startsWith("long line"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an 80k `<` line is scanned quickly and its placeholder is found", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", [VALID_AGENTS, `${"<".repeat(80_000)}<...>`].join("\n"))
      const started = Date.now()
      const result = await lint(root)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files[0]?.findings.some((finding) => finding.detail.includes('placeholder "<...>"'))).toBe(true)
      expect(result.verdict).toBe("fail")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N28: inline non-goals split on `;`, `,`, `and`/`и` and numbered markers only at
// the top level, never inside brackets or backticks.
describe("N28 inline non-goals separators", () => {
  const specBody = (nonGoals: string): string =>
    ["# SPEC", "", `## Non-goals: ${nonGoals}`, "", "## Requirements", "", "- R1 — shall work.", "", ...AC_TABLE].join(
      "\n",
    )
  const countDetail = (result: ContextLintOutcome): string | undefined =>
    majors(result).find((finding) => finding.detail.includes("non-goals"))?.detail
  const count = async (nonGoals: string): Promise<string | undefined> => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specBody(nonGoals))
      return countDetail(await lintContext({ root, target: "SPEC.md" }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test("a comma list inside backticks is one item", async () => {
    expect(await count("only `a, b, c`")).toBe("1 non-goals; expected 3–7 items")
  })

  test("a semicolon inside parentheses is not a separator", async () => {
    expect(await count("a (b; c); d")).toBe("2 non-goals; expected 3–7 items")
  })

  test("a comma inside backticks does not split, a top-level semicolon does", async () => {
    expect(await count("a `b, c`; d")).toBe("2 non-goals; expected 3–7 items")
  })

  test("a plain comma list is three items and passes", async () => {
    expect(await count("a, b, c")).toBeUndefined()
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specBody("a, b, c"))
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.verdict).toBe("pass")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R6-6: a code span opens with a run of N backticks and closes with exactly N;
// `<code>`/`<pre>` spans are masked too, so their separators are content.
describe("R6-6 multi-backtick and HTML code spans", () => {
  const specBody = (nonGoals: string): string =>
    ["# SPEC", "", `## Non-goals: ${nonGoals}`, "", "## Requirements", "", "- R1 — shall work.", "", ...AC_TABLE].join(
      "\n",
    )
  const countDetail = (result: ContextLintOutcome): string | undefined =>
    majors(result).find((finding) => finding.detail.includes("non-goals"))?.detail
  const count = async (nonGoals: string): Promise<string | undefined> => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specBody(nonGoals))
      return countDetail(await lintContext({ root, target: "SPEC.md" }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test("a double-backtick span hides its comma: two items", async () => {
    expect(await count("``a, b``, c")).toBe("2 non-goals; expected 3–7 items")
  })

  test("a `<code>` span hides its comma: two items", async () => {
    expect(await count("<code>a, b</code>, c")).toBe("2 non-goals; expected 3–7 items")
  })

  test("a single-backtick span still hides its comma", async () => {
    expect(await count("`a, b`, c")).toBe("2 non-goals; expected 3–7 items")
  })

  test("a shorter backtick run stays inside a longer span", async () => {
    expect(await count("``a`b, c``")).toBe("1 non-goals; expected 3–7 items")
  })
})

// N32: a defective AC table (no Test column) is an R→AC mapping; it cannot
// declare requirements of its own.
describe("N32 defective AC table requirements", () => {
  test("no R list + defective AC table → both no-requirements and lacks-Test", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Non-goals",
          "",
          "- a",
          "- b",
          "- c",
          "",
          "| AC | R | Given | When | Then |",
          "|---|---|---|---|---|",
          "| AC1.1 | R1 | given | when | then |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      const details = findingsOf(result).map((finding) => finding.detail)
      expect(details).toContain("no numbered requirements")
      expect(details).toContain("AC table lacks Test column")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// N36/R6-8: cap markers are additional to `max_findings`; both may appear in a
// run, and neither promises a different result on a deterministic rerun.
describe("N36 cap markers are additional and honest", () => {
  test("50 001 broken links with maxFindings=2 show both markers: 2 kept + 2 markers", async () => {
    const root = await temporary()
    try {
      const links = Array.from({ length: 50_001 }, () => "[x](docs/missing.md)")
      await write(root, "AGENTS.md", [VALID_AGENTS, ...links].join("\n"))
      const result = await lintContext({
        root,
        target: "AGENTS.md",
        maxLines: 100_000,
        maxTokens: 1_000_000,
        maxFindingsPerFile: 2,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files[0]?.findings ?? []
      const linkMarker = findings.find((finding) => finding.detail.startsWith("link candidates truncated"))
      const findingsMarker = findings.find((finding) => finding.detail.startsWith("findings truncated at 2 MAJOR"))
      expect(result.verdict).toBe("fail")
      expect(result.files[0]?.truncated).toBe(true)
      expect(linkMarker?.severity).toBe("MAJOR")
      expect(linkMarker?.evidence).toBe("AGENTS.md:1")
      expect(findingsMarker?.severity).toBe("MAJOR")
      // Two kept broken links plus two markers: markers do not consume the
      // `max_findings` budget and are not counted as findings.
      expect(findings.filter((finding) => finding.kind === "broken_link").length).toBe(2)
      expect(findings.length).toBe(4)
      const markers = findings.filter(
        (finding) =>
          finding.detail.startsWith("link candidates truncated") || finding.detail.startsWith("findings truncated"),
      )
      expect(markers.length).toBe(2)
      expect(result.closing_list).toContain(linkMarker?.id ?? "")
      expect(result.closing_list).toContain(findingsMarker?.id ?? "")
      expect(result.closing_list.length).toBe(4)
      expect(result.closing_list).toEqual(
        findings.filter((finding) => finding.severity === "MAJOR").map((finding) => finding.id),
      )
      expect(result.truncated).toBe(true)
      expect(findingsMarker?.fix).toContain("same prefix")
      for (const marker of [linkMarker, findingsMarker]) expect(marker?.fix).not.toContain("next run")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

// N33/R6-3: a paragraph is one non-goal item; 4-space bullets under the label
// are top-level items, not indented code.
describe("N33 paragraph and 4-space documentation", () => {
  const countDetail = (result: ContextLintOutcome): string | undefined =>
    majors(result).find((finding) => finding.detail.includes("non-goals"))?.detail

  test("a three-line paragraph is one item", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        ["# SPEC", "", "## Non-goals", "", "does not track,", "does not notify,", "does not sync.", ""].join("\n"),
      )
      expect(countDetail(await lintContext({ root, target: "SPEC.md" }))).toBe("1 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("4-space-indented bullets under a bold label are three items and pass the count", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", ["# SPEC", "", "**Non-goals:**", "", "    - a", "    - b", "    - c", ""].join("\n"))
      expect(countDetail(await lintContext({ root, target: "SPEC.md" }))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("zero items under the label is `0 non-goals` and MAJOR", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", ["# SPEC", "", "**Non-goals:**", ""].join("\n"))
      expect(countDetail(await lintContext({ root, target: "SPEC.md" }))).toBe("0 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** A SPEC whose only variable is the inline non-goals list. */
function specWithNonGoals(label: string): string {
  return [
    "# SPEC",
    "",
    "## Goal",
    "",
    label,
    "",
    "## Requirements",
    "",
    "- **R1** — WHEN x, THE SYSTEM SHALL y.",
    "",
    "## Acceptance criteria",
    "",
    "| AC | R | Given | When | Then | Test |",
    "|---|---|---|---|---|---|",
    "| AC1.1 | R1 | g | w | t | `test_x` |",
  ].join("\n")
}

const nonGoalsDetail = (result: ContextLintOutcome): string | undefined =>
  findingsOf(result).find((finding) => finding.detail.includes("non-goals"))?.detail

// R7-1: the link scanner is a single linear pass, so a long run of `](` without
// a closing `)` cannot backtrack quadratically.
describe("R7-1 linear link scanner", () => {
  const timed = async (tail: string): Promise<{ elapsed: number; result: ContextLintOutcome }> => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", [VALID_AGENTS, "", tail].join("\n"))
      const started = Date.now()
      const result = await lintContext({ root, target: "AGENTS.md", maxLines: 100_000, maxTokens: 2_000_000 })
      return { elapsed: Date.now() - started, result }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test("10k/20k/40k `](` without `)` stay linear", async () => {
    const budget = new Map([
      [10_000, 750],
      [20_000, 1_000],
      [40_000, 2_000],
    ])
    for (const count of [10_000, 20_000, 40_000]) {
      const { elapsed, result } = await timed("](".repeat(count))
      expect(result.ok, `${count} candidates: lint completed`).toBe(true)
      expect(elapsed, `${count} \`](\` in ${elapsed} ms`).toBeLessThan(budget.get(count)!)
    }
  }, 20_000)

  test("40k `](` with a single closing `)` stays linear", async () => {
    const { elapsed, result } = await timed(`${"](".repeat(40_000)})`)
    expect(result.ok).toBe(true)
    expect(elapsed, `40k \`](\` + \`)\` in ${elapsed} ms`).toBeLessThan(2_000)
  }, 20_000)

  test("80k `<` stays linear", async () => {
    const { elapsed, result } = await timed("<".repeat(80_000))
    expect(result.ok).toBe(true)
    expect(elapsed, `80k \`<\` in ${elapsed} ms`).toBeLessThan(2_000)
  }, 20_000)
})

// R7-2: `<pre>` masks its own span only; the text before and after it stays
// visible to every check, and an unclosed `<pre>` masks following lines only.
describe("R7-2 pre span", () => {
  test("a broken link and a placeholder before and after an inline <pre> are MAJOR", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        `${VALID_AGENTS}\n[a](missing-a.md) <...> <pre>x</pre>\n<pre>x</pre> [b](missing-b.md) <...>`,
      )
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = findingsOf(result).filter((finding) => finding.kind === "broken_link")
      expect(broken.map((finding) => finding.detail).sort()).toEqual([
        'missing path "missing-a.md"',
        'missing path "missing-b.md"',
      ])
      expect(findingsOf(result).filter((finding) => finding.detail === 'placeholder "<...>"').length).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an R line with an inline <pre> still counts as a requirement", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        [
          "# SPEC",
          "",
          "## Goal",
          "",
          "**Non-goals:** a, b, c",
          "",
          "## Requirements",
          "",
          "- **R1** — WHEN x, THE SYSTEM SHALL y.",
          "- **R2** — WHEN q, THE SYSTEM SHALL z <pre>code</pre>.",
          "",
          "## Acceptance criteria",
          "",
          "| AC | R | Given | When | Then | Test |",
          "|---|---|---|---|---|---|",
          "| AC1.1 | R1 | g | w | t | `test_x` |",
        ].join("\n"),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "no numbered requirements")).toBe(false)
      expect(findingsOf(result).some((finding) => finding.detail === "R2 has no acceptance criterion")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("non-goals around an inline <pre> count the surrounding text", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specWithNonGoals("**Non-goals:** alpha, beta, gamma <pre>a, b</pre>"))
      expect(nonGoalsDetail(await lintContext({ root, target: "SPEC.md" }))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an unclosed <pre> masks following lines only, not the current prefix", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n[a](missing-a.md) <pre>open\n[b](missing-b.md) after`)
      const result = await lintContext({ root, target: "AGENTS.md" })
      const broken = findingsOf(result).filter((finding) => finding.kind === "broken_link")
      expect(broken.length).toBe(1)
      expect(broken[0]?.detail).toContain("missing-a.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R7-3: an HTML `<code …>` open tag with attributes is a code span.
describe("R7-3 code tag attributes", () => {
  test("<code class=x>a, b</code>, c is two items (MAJOR)", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specWithNonGoals("**Non-goals:** <code class=x>a, b</code>, c"))
      expect(nonGoalsDetail(await lintContext({ root, target: "SPEC.md" }))).toBe("2 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("<code id=y>a, b</code>, c is two items (MAJOR)", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specWithNonGoals("**Non-goals:** <code id=y>a, b</code>, c"))
      expect(nonGoalsDetail(await lintContext({ root, target: "SPEC.md" }))).toBe("2 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// R7-6: balanced braces group inline list items and hide an inner `and`.
describe("R7-6 brace grouping", () => {
  test("{a, b}, c is two items (MAJOR)", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", specWithNonGoals("**Non-goals:** {a, b}, c"))
      expect(nonGoalsDetail(await lintContext({ root, target: "SPEC.md" }))).toBe("2 non-goals; expected 3–7 items")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A1: 20k/40k/80k whitespace runs stay within 3x per doubling", async () => {
    const root = await temporary()
    try {
      const times: number[] = []
      for (const size of [20_000, 40_000, 80_000]) {
        await write(root, "SPEC.md", `${" ".repeat(size)}\n`)
        const started = performance.now()
        const result = await lintContext({ root, target: "SPEC.md" })
        times.push(performance.now() - started)
        expect(result.ok).toBe(true)
      }
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]!, `${times.map((value) => value.toFixed(1)).join("/")} ms`).toBeLessThanOrEqual(
          Math.max(25, times[index - 1]! * 3),
        )
      }
      // The quadratic path took ~11.8 s at 80k; the linear one stays orders below.
      expect(times[2]!).toBeLessThan(1000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A1: a heading with an 80k space run and no label stays linear", async () => {
    const root = await temporary()
    try {
      await write(root, "SPEC.md", `#${" ".repeat(80_000)}\n`)
      const started = performance.now()
      const result = await lintContext({ root, target: "SPEC.md" })
      const elapsed = performance.now() - started
      expect(result.ok).toBe(true)
      expect(elapsed, `${elapsed.toFixed(1)} ms`).toBeLessThan(1000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A1: abort during the section checks returns E_ABORTED, never a verdict", async () => {
    const root = await temporary()
    try {
      const lines = ["# SPEC", "", "## Requirements", ""]
      for (let index = 1; index <= 100_000; index += 1) lines.push(`- R${index} — x.`)
      lines.push("", `#${" ".repeat(200_000)}`)
      await writeFile(path.join(root, "SPEC.md"), `${lines.join("\n")}\n`, "utf8")
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10)
      const result = await lintContext({ root, target: "SPEC.md", signal: controller.signal })
      clearTimeout(timer)
      expect(result).toMatchObject({ ok: false, code: "E_ABORTED" })
      expect("files" in result).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("PR audit A2: an escaped `[` is literal, so `\\[o1](m1.md)` is not a broken link", async () => {
    const root = await temporary()
    try {
      const backslash = String.fromCharCode(92)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n${backslash}[o1](m1.md) and [real](missing-real.md)`)
      const broken = findingsOf(await lintContext({ root, target: "AGENTS.md" })).filter(
        (finding) => finding.kind === "broken_link",
      )
      expect(broken.map((finding) => finding.detail)).toEqual(['missing path "missing-real.md"'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: an even backslash run keeps the link", async () => {
    const root = await temporary()
    try {
      const backslash = String.fromCharCode(92)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n${backslash}${backslash}[o2](m2.md)`)
      const broken = findingsOf(await lintContext({ root, target: "AGENTS.md" })).filter(
        (finding) => finding.kind === "broken_link",
      )
      expect(broken.map((finding) => finding.detail)).toEqual(['missing path "m2.md"'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: an unclosed inline backtick is literal, so the rest of the line is checked", async () => {
    const root = await temporary()
    try {
      const tick = String.fromCharCode(96)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nunclosed ${tick} [real](missing.md)`)
      const broken = findingsOf(await lintContext({ root, target: "AGENTS.md" })).filter(
        (finding) => finding.kind === "broken_link",
      )
      expect(broken.map((finding) => finding.detail)).toEqual(['missing path "missing.md"'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: a closed inline code span still masks its link", async () => {
    const root = await temporary()
    try {
      const tick = String.fromCharCode(96)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nsee ${tick}[gone](nope.md)${tick} here`)
      const broken = findingsOf(await lintContext({ root, target: "AGENTS.md" })).filter(
        (finding) => finding.kind === "broken_link",
      )
      expect(broken).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: an unclosed fence is reported as INFO; a closed one is not", async () => {
    const root = await temporary()
    try {
      const fence = String.fromCharCode(96).repeat(3)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n${fence}\n[hidden](missing.md)\n`)
      const open = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      expect(open.some((finding) => finding.detail.includes("unclosed fence at line"))).toBe(true)
      expect(open.some((finding) => finding.kind === "broken_link")).toBe(false)

      await write(root, "AGENTS.md", `${VALID_AGENTS}\n\n${fence}\n[hidden](missing.md)\n${fence}\n`)
      const closed = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      expect(closed.some((finding) => finding.detail.includes("unclosed fence"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: a link outside the workspace root is an INFO finding, not silence", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\nSee [outside](../missing.md).`)
      const findings = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      const skipped = findings.filter((finding) => finding.detail.includes("outside the workspace root"))
      expect(skipped.length).toBe(1)
      expect(skipped[0]).toMatchObject({ severity: "INFO" })
      expect(skipped[0]?.detail).toContain("missing.md")
      expect(findings.some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: a UNC or protocol-relative target is INFO, never probed and never silent", async () => {
    const root = await temporary()
    try {
      const backslash = String.fromCharCode(92)
      const network = `${backslash}${backslash}server${backslash}share${backslash}x.md`
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n[share](${network}) and [cdn](//host/x.js)`)
      const started = performance.now()
      const findings = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      expect(performance.now() - started).toBeLessThan(2000)
      const skipped = findings.filter((finding) =>
        finding.detail.includes("network path is outside the workspace root"),
      )
      expect(skipped.length).toBe(2)
      for (const finding of skipped) expect(finding.severity).toBe("INFO")
      expect(findings.some((finding) => finding.kind === "broken_link")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A2: a directory below depth 3 is reported instead of dropped", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", VALID_AGENTS)
      await write(root, "a/b/c/d/AGENTS.md", VALID_AGENTS)
      const result = await lintContext({ root })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.length).toBe(1)
      const depth = findingsOf(result).filter((finding) => finding.detail.includes("depth limit 3"))
      expect(depth.length).toBe(1)
      expect(depth[0]).toMatchObject({ severity: "INFO" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A3: prose `Make sure to be careful` does not satisfy the commands check", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        "# AGENTS\n\n## Boundaries\n\n- Never commit secrets.\n\n## Verification\n\nDone = green.\n\nMake sure to be careful.\n",
      )
      const findings = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      expect(findings.some((finding) => finding.detail === "no commands section")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A3: a fenced `make test` satisfies the commands check", async () => {
    const root = await temporary()
    try {
      const fence = String.fromCharCode(96).repeat(3)
      await write(
        root,
        "AGENTS.md",
        `# AGENTS\n\n## Boundaries\n\n- Never commit secrets.\n\n## Verification\n\nDone = green.\n\n${fence}\nmake test\n${fence}\n`,
      )
      const findings = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      expect(findings.some((finding) => finding.detail === "no commands section")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A3: prose `bun test` outside a Commands section is not a command surface", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "AGENTS.md",
        "# AGENTS\n\n## Boundaries\n\n- Never commit secrets.\n\n## Verification\n\nDone = green.\n\nYou can run bun test any time.\n",
      )
      const findings = findingsOf(await lintContext({ root, target: "AGENTS.md" }))
      expect(findings.some((finding) => finding.detail === "no commands section")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A4: the read path refuses maxFileBytes+1 bytes without trusting stat", async () => {
    const root = await temporary()
    try {
      const file = await write(root, "AGENTS.md", "a".repeat(5_000))
      expect(await readCappedFile(file, 1_000)).toEqual({ bytes: 1_001 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A4: the read path accepts a file exactly at the cap", async () => {
    const root = await temporary()
    try {
      const body = "a".repeat(1_000)
      const file = await write(root, "AGENTS.md", body)
      expect(await readCappedFile(file, 1_000)).toEqual({ text: body })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A7: maxFileBytes is inclusive: equal passes, one byte more is E_LIMIT_FILE", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", "a".repeat(100))
      expect(await lintContext({ root, target: "AGENTS.md", maxFileBytes: 100 })).toMatchObject({ ok: true })
      await write(root, "AGENTS.md", "a".repeat(101))
      expect(await lintContext({ root, target: "AGENTS.md", maxFileBytes: 100 })).toMatchObject({
        ok: false,
        code: "E_LIMIT_FILE",
        bytes: 101,
        max: 100,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A7: exactly maxTotalFindings MAJOR add no marker; one more adds it", async () => {
    const root = await temporary()
    try {
      const three = `${VALID_AGENTS}\n<...>\n<...>\n<...>\n`
      await write(root, "AGENTS.md", three)
      const exact = await lintContext({ root, target: "AGENTS.md", maxTotalFindings: 3 })
      expect(exact).toMatchObject({ ok: true, verdict: "fail" })
      if (!exact.ok) return
      expect(findingsOf(exact).length).toBe(3)
      expect(exact.truncated).toBeFalsy()

      await write(root, "AGENTS.md", `${three}<...>\n`)
      const over = await lintContext({ root, target: "AGENTS.md", maxTotalFindings: 3 })
      expect(over.ok).toBe(true)
      if (!over.ok) return
      expect(findingsOf(over).length).toBe(4)
      expect(over.truncated).toBe(true)
      expect(over.closing_list.length).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A7: the token estimate is Cyrillic/3 + the rest/4 for mixed text", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${"я".repeat(30)}${"a".repeat(40)}`)
      const mixed = await lintContext({ root, target: "AGENTS.md", maxLines: 1_000, maxTokens: 1_000_000 })
      expect(mixed.ok).toBe(true)
      if (!mixed.ok) return
      expect(mixed.files[0]?.chars).toBe(70)
      expect(mixed.files[0]?.tokens_est).toBe(20) // 30/3 + 40/4

      await write(root, "AGENTS.md", "a".repeat(40))
      const latin = await lintContext({ root, target: "AGENTS.md", maxLines: 1_000, maxTokens: 1_000_000 })
      expect(latin.ok && latin.files[0]?.tokens_est).toBe(10)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A7: an escaped `]` `(` pair is prose, not a link", async () => {
    const root = await temporary()
    try {
      const backslash = String.fromCharCode(92)
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n[x]${backslash}(missing.md)`)
      const broken = findingsOf(await lintContext({ root, target: "AGENTS.md" })).filter(
        (finding) => finding.kind === "broken_link",
      )
      expect(broken).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A8: maxFiles stops the walk at the first file above the limit", async () => {
    const root = await temporary()
    try {
      for (let index = 0; index < 5; index += 1) await write(root, `d${index}/AGENTS.md`, VALID_AGENTS)
      const result = await lintContext({ root, maxFiles: 1 })
      expect(result).toMatchObject({ ok: false, code: "E_LIMIT_FILES", files: 2, max: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("PR audit A8: the tool description documents depth 3, the root scan and the payload fields", async () => {
    const harness = await createHarness()
    try {
      const description = harness.tools.get("orch_uni_context_lint")?.description ?? ""
      for (const token of ["depth 3", "eval/", "ok:false", "chars", "Cyrillic/3"]) {
        expect(description, token).toContain(token)
      }
    } finally {
      harness.dispose()
    }
  })

  test("{A and B} in an R line is not a top-level and-chain", async () => {
    const root = await temporary()
    try {
      await write(
        root,
        "SPEC.md",
        specWithNonGoals("**Non-goals:** a, b, c").replace(
          "- **R1** — WHEN x, THE SYSTEM SHALL y.",
          "- **R1** — WHEN {A and B}, THE SYSTEM SHALL work.",
        ),
      )
      const result = await lintContext({ root, target: "SPEC.md" })
      expect(findingsOf(result).some((finding) => finding.detail === "requirement joins multiple behaviors")).toBe(
        false,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
