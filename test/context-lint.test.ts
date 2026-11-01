import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type ContextLintOutcome, lintContext } from "../lib/context-lint"
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

  test("per-file findings are capped and the truncation is reported", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n<...>\nTODO\n[gone](docs/gone.md)\n`)
      const result = await lintContext({ root, target: "AGENTS.md", maxFindingsPerFile: 2 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const findings = result.files[0]?.findings ?? []
      expect(findings.length).toBe(3)
      expect(findings.at(-1)).toMatchObject({ severity: "INFO", detail: "findings truncated at 2" })
      expect(result.files[0]?.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the total finding cap stops the scan and reports it", async () => {
    const root = await temporary()
    try {
      await write(root, "AGENTS.md", `${VALID_AGENTS}\n<...>\n`)
      await write(root, "docs/SPEC.md", "# SPEC\n<...>\n")
      const result = await lintContext({ root, maxTotalFindings: 1 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.flatMap((file) => file.findings).length).toBe(1)
      expect(result.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
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
