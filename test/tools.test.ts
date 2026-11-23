/**
 * Registration and executor tests for the `orch_uni_*` tools, driven by a mock
 * plugin context (same style as `plugin.test.ts`: the harness mimics the engine
 * editors as observed in OpenCode 2.0.x).
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventJournal } from "../lib/event-journal"
import { COMPATIBILITY_VALIDATE_REPORT, TOOL_EFFECTIVE_IDS, TOOL_IDS, TOOL_NAMESPACE } from "../lib/tools"
import { createHarness, memoryStorage, runTool } from "./support/harness"

describe("audit tool registration", () => {
  test("registers six namespaced tools and the one flat compatibility alias", async () => {
    const harness = await createHarness()
    expect([...harness.tools.keys()].sort()).toEqual([...TOOL_EFFECTIVE_IDS].sort())
    expect(harness.namespaces.map((entry) => entry.name)).toEqual([TOOL_NAMESPACE])
    for (const id of TOOL_IDS) {
      const tool = harness.tools.get(id)!
      expect(tool.options?.namespace).toBe(TOOL_NAMESPACE)
      expect(tool.description.length).toBeGreaterThan(40)
      expect(typeof tool.execute).toBe("function")
    }
    const alias = harness.tools.get(COMPATIBILITY_VALIDATE_REPORT)!
    expect(alias.options).toBeUndefined()
    expect(alias.description).toContain("tools.orch_uni.validate_report")
    expect(alias.description).toContain("not_verified")
    harness.dispose()
  })

  test("every description names the canonical call and a short example", async () => {
    const harness = await createHarness()
    for (const name of TOOL_IDS) {
      const tool = harness.tools.get(name)!
      expect(tool.description, name).toContain(`Canonical call: tools.${name}({`)
    }
    harness.dispose()
  })

  test("declares the documented input fields", async () => {
    const harness = await createHarness()
    const inputs = Object.fromEntries([...harness.tools].map(([id, tool]) => [id, tool.input]))
    expect(Object.keys(inputs).sort()).toEqual([...TOOL_EFFECTIVE_IDS].sort())
    expect(inputs["orch_uni.validate_report"]).toEqual({
      type: "object",
      properties: {
        text: { type: "string", description: expect.any(String) },
        path: { type: "string", description: expect.any(String) },
        schema: { type: "string", description: expect.any(String) },
      },
    })
    expect(inputs["orch_uni.context_lint"]).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: expect.any(String) },
        max_lines: { type: "number", description: expect.any(String) },
        max_tokens: { type: "number", description: expect.any(String) },
        max_words: { type: "number", description: expect.any(String) },
        max_file_bytes: { type: "number", description: expect.any(String) },
        max_files: { type: "number", description: expect.any(String) },
        max_findings: { type: "number", description: expect.any(String) },
        max_total_findings: { type: "number", description: expect.any(String) },
      },
    })
    expect((inputs["orch_uni.snapshot"] as { required: string[] }).required).toEqual(["path"])
    expect((inputs["orch_uni.sessions"] as { properties: Record<string, unknown> }).properties).toEqual({
      sessionID: { type: "string", description: expect.any(String) },
      recursive: { type: "boolean", description: expect.any(String) },
    })
    expect((inputs["orch_uni.list_tools"] as { properties: Record<string, unknown> }).properties).toEqual({
      tool: { type: "string", description: expect.any(String) },
    })
    expect(inputs[COMPATIBILITY_VALIDATE_REPORT]).toEqual(inputs["orch_uni.validate_report"])
    harness.dispose()
  })

  test("a host that rejects flat tools still registers the six canonical tools", async () => {
    const warnings: string[] = []
    const harness = await createHarness({ rejectFlatTool: true, warn: (message) => warnings.push(message) })
    expect([...harness.tools.keys()].sort()).toEqual([...TOOL_IDS].sort())
    expect(harness.tools.has(COMPATIBILITY_VALIDATE_REPORT)).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.toLowerCase()).toContain("compatibility")
    expect(warnings[0]!.toLowerCase()).toContain("flat")
    expect(warnings[0]).toContain("tools.orch_uni.validate_report")
    const text =
      '```json\n{"schema":"meta/v1","verdict":"pass","gate":"pass","closing_list":[],"coverage_gaps":[],"reports":[]}\n```'
    expect(await runTool(harness, "orch_uni.validate_report", { text })).toMatchObject({ valid: true })
    harness.dispose()
  })

  test("no second registration is needed and cleanup only stops the subscription", async () => {
    const harness = await createHarness()
    expect(harness.aborted).toBe(false)
    harness.dispose()
    expect(harness.aborted).toBe(true)
  })
})

describe("orch_uni_validate_report", () => {
  test("validates text and reports the schema and warnings", async () => {
    const harness = await createHarness()
    const text = [
      "Резюме.",
      "```json",
      JSON.stringify({
        schema: "meta/v1",
        verdict: "pass",
        gate: "pass",
        closing_list: [],
        coverage_gaps: [],
        reports: [],
      }),
      "```",
    ].join("\n")
    const result = await runTool(harness, "orch_uni_validate_report", { text })
    expect(result).toEqual({ valid: true, schema: "meta/v1", errors: [], warnings: [] })
    harness.dispose()
  })

  test("reads a report from a location-relative path", async () => {
    const harness = await createHarness()
    const report = path.join(harness.directory, "reports", "empiric.md")
    await mkdir(path.dirname(report), { recursive: true })
    await writeFile(
      report,
      [
        "```json",
        JSON.stringify({
          schema: "empiric/v1",
          verdict: "ready",
          claims_checked: [{ claim: "c", method: "run", rc: "0", result: "r", verdict: "confirmed" }],
          modes_measured: [],
          self_check: [{ item: 1, title: "t", status: "applied", note: "n" }],
          findings: [],
          contract_gaps: [],
          not_verified: [],
        }),
        "```",
      ].join("\n"),
      "utf8",
    )
    const result = await runTool(harness, "orch_uni_validate_report", {
      path: "reports/empiric.md",
      schema: "empiric/v1",
    })
    expect(result).toMatchObject({ valid: true, schema: "empiric/v1" })
    expect((result.warnings as string[]).join(" ")).toContain("self_check: items 2")
    harness.dispose()
  })

  test("typed input errors", async () => {
    const harness = await createHarness()
    expect(await runTool(harness, "orch_uni_validate_report", {})).toMatchObject({ ok: false, code: "E_INPUT" })
    expect(await runTool(harness, "orch_uni_validate_report", { text: "x", path: "y" })).toMatchObject({
      ok: false,
      code: "E_INPUT",
    })
    expect(await runTool(harness, "orch_uni_validate_report", { text: 42 })).toMatchObject({
      ok: false,
      code: "E_INPUT",
    })
    expect(await runTool(harness, "orch_uni_validate_report", { path: "nope/missing.md" })).toMatchObject({
      ok: false,
      code: "E_INPUT",
    })
    expect(await runTool(harness, "orch_uni_validate_report", "not an object")).toMatchObject({
      ok: false,
      code: "E_INPUT",
    })
    harness.dispose()
  })

  test("delegates schema failures to their own codes", async () => {
    const harness = await createHarness()
    expect(await runTool(harness, "orch_uni_validate_report", { text: "нет json" })).toMatchObject({
      code: "E_NO_JSON",
    })
    expect(await runTool(harness, "orch_uni_validate_report", { text: "```json\n{nope\n```" })).toMatchObject({
      code: "E_PARSE",
    })
    expect(
      await runTool(harness, "orch_uni_validate_report", { text: '```json\n{"schema":"x/v1"}\n```' }),
    ).toMatchObject({
      code: "E_UNKNOWN_SCHEMA",
    })
    harness.dispose()
  })

  test("preflights an unknown expected schema before reading the report file", async () => {
    const harness = await createHarness()
    const result = await runTool(harness, "orch_uni_validate_report", {
      path: "no/such/report.md",
      schema: "nope/v1",
    })
    expect(result).toMatchObject({ ok: false, code: "E_UNKNOWN_SCHEMA", schema: "nope/v1" })
    expect(result.available).toContain("empiric/v1")
    expect(String(result.hint)).toContain("empiric/v1")
    harness.dispose()
  })

  test("failure bodies carry short repair hints", async () => {
    const harness = await createHarness()
    const noJson = await runTool(harness, "orch_uni_validate_report", { text: "plain prose" })
    expect(noJson.code).toBe("E_NO_JSON")
    expect(String(noJson.hint)).toContain("```json")
    expect(String(noJson.hint)).toContain("closing fence")

    const parse = await runTool(harness, "orch_uni_validate_report", { text: "```json\n{nope\n```" })
    expect(parse.code).toBe("E_PARSE")
    expect(String(parse.hint)).toContain("trailing commas")

    const invalid = await runTool(harness, "orch_uni_validate_report", {
      text: '```json\n{"schema":"meta/v1","verdict":"maybe"}\n```',
    })
    expect(invalid.code).toBe("E_INVALID")
    expect(String(invalid.hint)).toContain("Fix $.")
    const errors = invalid.errors as { hint?: string; path: string }[]
    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) {
      expect(error.hint, error.path).toBeTruthy()
      expect(error.hint!.length).toBeLessThanOrEqual(300)
    }
    expect(errors.some((error) => error.path === "$.verdict" && error.hint?.includes("enum"))).toBe(true)
    expect(errors.some((error) => error.path === "$.gate" && error.hint?.toLowerCase().includes("required"))).toBe(true)

    const mismatch = await runTool(harness, "orch_uni_validate_report", {
      text: '```json\n{"schema":"meta/v1","verdict":"pass","gate":"pass","closing_list":[],"coverage_gaps":[],"reports":[]}\n```',
      schema: "empiric/v1",
    })
    expect(mismatch.code).toBe("E_SCHEMA_MISMATCH")
    expect(String(mismatch.hint)).toContain('"empiric/v1"')
    expect(mismatch.available).toContain("empiric/v1")
    harness.dispose()
  })

  test("the success shape stays {valid, schema, errors, warnings}", async () => {
    const harness = await createHarness()
    const text =
      '```json\n{"schema":"meta/v1","verdict":"pass","gate":"pass","closing_list":[],"coverage_gaps":[],"reports":[]}\n```'
    const result = await runTool(harness, "orch_uni_validate_report", { text })
    expect(result).toEqual({ valid: true, schema: "meta/v1", errors: [], warnings: [] })
    harness.dispose()
  })

  test("the flat alias is registered and executes the same validator", async () => {
    const harness = await createHarness()
    const alias = harness.tools.get(COMPATIBILITY_VALIDATE_REPORT)!
    expect(alias.options).toBeUndefined()
    const text =
      '```json\n{"schema":"meta/v1","verdict":"pass","gate":"pass","closing_list":[],"coverage_gaps":[],"reports":[]}\n```'
    const result = await runTool(harness, COMPATIBILITY_VALIDATE_REPORT, { text }, true)
    expect(result).toEqual({ valid: true, schema: "meta/v1", errors: [], warnings: [] })
    harness.dispose()
  })
})

describe("orch_uni_list_tools", () => {
  test("lists canonical calls and expands validate_report with examples", async () => {
    const harness = await createHarness()
    const catalogue = await runTool(harness, "orch_uni.list_tools", {})
    expect(catalogue.namespace).toBe(TOOL_NAMESPACE)
    const names = (catalogue.tools as { name: string }[]).map((tool) => tool.name)
    expect(names).toEqual(["validate_report", "context_lint", "snapshot", "sessions", "session_stats", "list_tools"])
    for (const tool of catalogue.tools as { call: string; summary: string }[]) {
      expect(tool.call.startsWith("tools.orch_uni.")).toBe(true)
      expect(tool.summary.length).toBeGreaterThan(20)
    }
    expect(catalogue.compatibility).toMatchObject({
      [COMPATIBILITY_VALIDATE_REPORT]: { preferred: "tools.orch_uni.validate_report" },
    })

    const expanded = await runTool(harness, "orch_uni.list_tools", { tool: "validate_report" })
    const schemas = expanded.schemas as { id: string; required: string[]; example: Record<string, unknown> }[]
    expect(schemas.map((entry) => entry.id)).toContain("empiric/v1")
    expect(schemas.map((entry) => entry.id)).toContain("context-lint-failure/v1")
    const meta = schemas.find((entry) => entry.id === "meta/v1")!
    expect(meta.required).toContain("schema")
    expect(meta.example.schema).toBe("meta/v1")
    // The example is directly usable as a report template.
    const validated = await runTool(harness, "orch_uni_validate_report", {
      text: `\`\`\`json\n${JSON.stringify(meta.example)}\n\`\`\``,
      schema: "meta/v1",
    })
    expect(validated).toMatchObject({ valid: true, schema: "meta/v1" })

    const unknown = await runTool(harness, "orch_uni.list_tools", { tool: "nope" })
    expect(unknown).toMatchObject({ ok: false, code: "E_INPUT" })
    expect(unknown.available).toContain("validate_report")
    harness.dispose()
  })
})

describe("event journal: validation", () => {
  test("records exactly one fact per call and never copies report text", async () => {
    const storage = new Map<string, unknown>()
    const journal = new EventJournal(memoryStorage(storage))
    const harness = await createHarness({ storage, journal })
    const sentinel = "SENTINEL-REPORT-BODY-4f1c"
    const text = [
      "```json",
      JSON.stringify({
        schema: "meta/v1",
        verdict: "pass",
        gate: "pass",
        closing_list: [],
        coverage_gaps: [],
        reports: [],
        note: sentinel,
      }),
      "```",
    ].join("\n")
    expect(await runTool(harness, "orch_uni_validate_report", { text })).toMatchObject({ valid: true })
    const unknown = await runTool(harness, "orch_uni_validate_report", {
      path: "missing/report.md",
      schema: "nope/v1",
    })
    expect(unknown).toMatchObject({ ok: false, code: "E_UNKNOWN_SCHEMA" })
    await journal.flush()
    const snapshot = await journal.read(harness.sessionID)
    expect(snapshot.available).toBe(true)
    expect(snapshot.counts.validation).toBe(2)
    expect(snapshot.events).toHaveLength(2)
    expect(snapshot.events[0]).toMatchObject({
      kind: "validation",
      schema: "meta/v1",
      valid: true,
      errorCount: 0,
      warningCount: 0,
    })
    expect(snapshot.events[1]).toMatchObject({
      kind: "validation",
      schema: "nope/v1",
      valid: false,
      code: "E_UNKNOWN_SCHEMA",
      errorCount: 0,
      warningCount: 0,
    })
    expect(JSON.stringify([...storage.values()])).not.toContain(sentinel)
    harness.dispose()
  })
})

describe("event journal: two harness instances", () => {
  test("a second harness with the same storage reads the first instance's journal", async () => {
    const storage = new Map<string, unknown>()
    const firstJournal = new EventJournal(memoryStorage(storage))
    const first = await createHarness({ storage, journal: firstJournal })
    const text =
      '```json\n{"schema":"meta/v1","verdict":"pass","gate":"pass","closing_list":[],"coverage_gaps":[],"reports":[]}\n```'
    expect(await runTool(first, "orch_uni_validate_report", { text })).toMatchObject({ valid: true })
    first.dispose()

    const secondJournal = new EventJournal(memoryStorage(storage))
    const second = await createHarness({ storage, journal: secondJournal })
    const snapshot = await secondJournal.read(second.sessionID)
    expect(snapshot.available).toBe(true)
    expect(snapshot.counts.validation).toBe(1)
    expect(snapshot.events[0]).toMatchObject({ kind: "validation", schema: "meta/v1", valid: true })
    second.dispose()
  })
})

describe("orch_uni_snapshot", () => {
  test("snapshots a directory and keeps the default exclusions with extras", async () => {
    const harness = await createHarness()
    const root = path.join(harness.directory, "state")
    await mkdir(path.join(root, "node_modules"), { recursive: true })
    await writeFile(path.join(root, "node_modules", "x.js"), "x", "utf8")
    await writeFile(path.join(root, "a.txt"), "a", "utf8")
    await writeFile(path.join(root, "b.txt"), "b", "utf8")
    const result = await runTool(harness, "orch_uni_snapshot", { path: "state", exclude: ["b.txt"] })
    expect(result.root).toBe(root)
    expect((result.files as { path: string }[]).map((file) => file.path)).toEqual(["a.txt"])
    expect(result.aggregate).toMatch(/^[0-9a-f]{64}$/)
    const repeat = await runTool(harness, "orch_uni_snapshot", { path: "state", exclude: ["b.txt"] })
    expect(repeat.aggregate).toBe(result.aggregate)
    const withoutExtras = await runTool(harness, "orch_uni_snapshot", { path: root })
    expect((withoutExtras.files as { path: string }[]).map((file) => file.path)).toEqual(["a.txt", "b.txt"])
    expect(withoutExtras.aggregate).not.toBe(result.aggregate)
    harness.dispose()
  })

  test("typed input and path errors", async () => {
    const harness = await createHarness()
    expect(await runTool(harness, "orch_uni_snapshot", {})).toMatchObject({ ok: false, code: "E_INPUT" })
    expect(await runTool(harness, "orch_uni_snapshot", { path: "" })).toMatchObject({ ok: false, code: "E_INPUT" })
    expect(await runTool(harness, "orch_uni_snapshot", { path: "x", exclude: [1] })).toMatchObject({
      ok: false,
      code: "E_INPUT",
    })
    expect(await runTool(harness, "orch_uni_snapshot", { path: "no-such-dir" })).toMatchObject({
      ok: false,
      code: "E_NOT_FOUND",
    })
    harness.dispose()
  })
})

describe("orch_uni_sessions", () => {
  test("lists children from the authoritative session list when available", async () => {
    const harness = await createHarness({
      sessions: {
        list: async ({ parentID }: { parentID?: string }) => ({
          data:
            parentID === "ses_parent"
              ? [child("ses_child_a", "ses_parent", "empiric"), { ...child("ses_child_b", "ses_parent", "invariant") }]
              : [{ ...child("ses_grand", "ses_child_a", "explore") }],
          cursor: {},
        }),
      },
    })
    const direct = await runTool(harness, "orch_uni_sessions", { sessionID: "ses_parent" })
    expect(direct).toMatchObject({ source: "session.list", authoritative: true, count: 2 })
    expect((direct.sessions as unknown[])[0]).toEqual({
      sessionID: "ses_child_a",
      parentID: "ses_parent",
      agent: "empiric",
      model: "deepseek/deepseek-flash",
      variant: "default",
      title: "child",
      cost: 0.01,
      tokens: { input: 10, output: 20 },
      created: new Date(1_700_000_000_000).toISOString(),
      updated: new Date(1_700_000_001_000).toISOString(),
    })
    const deep = await runTool(harness, "orch_uni_sessions", { sessionID: "ses_parent", recursive: true })
    expect(deep.count).toBe(3)
    expect((deep.sessions as { sessionID: string }[]).map((session) => session.sessionID)).toEqual([
      "ses_child_a",
      "ses_child_b",
      "ses_grand",
    ])
    harness.dispose()
  })

  test("falls back to the persisted session index and flags it as non-authoritative", async () => {
    const harness = await createHarness({
      sessions: { get: async ({ sessionID }: { sessionID: string }) => child(sessionID, "ses_parent", "meta") },
      index: { ses_child_a: "ses_parent", ses_grand: "ses_child_a" },
    })
    const result = await runTool(harness, "orch_uni_sessions", { sessionID: "ses_parent", recursive: true })
    expect(result).toMatchObject({ source: "session.index", authoritative: false, count: 2 })
    expect(result.limitations).toHaveLength(3)
    expect((result.sessions as { sessionID: string }[]).map((session) => session.sessionID)).toEqual([
      "ses_child_a",
      "ses_grand",
    ])
    harness.dispose()
  })

  test("defaults to the calling session and returns an empty list without children", async () => {
    const harness = await createHarness({ index: {} })
    const result = await runTool(harness, "orch_uni_sessions", {})
    expect(result).toMatchObject({ sessionID: harness.sessionID, count: 0, sessions: [] })
    harness.dispose()
  })

  test("E_NO_API when neither listing nor events exist", async () => {
    const harness = await createHarness({ index: {}, events: false })
    const result = await runTool(harness, "orch_uni_sessions", {})
    expect(result).toMatchObject({ ok: false, code: "E_NO_API" })
    expect(result.available).toContain("get")
    harness.dispose()
  })

  test("typed input errors and missing sessions", async () => {
    const harness = await createHarness({
      sessions: {
        get: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "ses_missing") throw new Error("session not found")
          if (sessionID === "ses_missing_tagged") {
            throw Object.assign(new Error(""), { _tag: "Session.NotFoundError" })
          }
          return child(sessionID, "ses_parent", "meta")
        },
        list: async () => ({ data: [], cursor: {} }),
      },
    })
    expect(await runTool(harness, "orch_uni_sessions", { sessionID: "" })).toMatchObject({ ok: false, code: "E_INPUT" })
    expect(await runTool(harness, "orch_uni_sessions", { recursive: "yes" })).toMatchObject({
      ok: false,
      code: "E_INPUT",
    })
    expect(await runTool(harness, "orch_uni_sessions", { sessionID: "ses_missing" })).toMatchObject({
      ok: false,
      code: "E_NOT_FOUND",
    })
    expect(await runTool(harness, "orch_uni_sessions", { sessionID: "ses_missing_tagged" })).toMatchObject({
      ok: false,
      code: "E_NOT_FOUND",
    })
    harness.dispose()
  })
})

describe("session index", () => {
  test("records events, persists to storage and reloads", async () => {
    const harness = await createHarness({ index: {} })
    harness.pushEvent({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_parent" } })
    harness.pushEvent({ type: "session.created", data: { sessionID: "ses_root" } })
    await harness.drain()
    expect(harness.indexEntries()).toEqual({ ses_child: "ses_parent" })

    harness.pushEvent({ type: "session.deleted", data: { sessionID: "ses_child" } })
    await harness.drain()
    expect(harness.indexEntries()).toEqual({})

    harness.pushEvent({ type: "session.created", data: { sessionID: "ses_child2", parentID: "ses_parent" } })
    await harness.drain()

    // A second plugin instance in the same process loads the persisted index.
    const reloaded = await createHarness({ storage: harness.storage })
    const result = await runTool(reloaded, "orch_uni_sessions", { sessionID: "ses_parent" })
    expect((result.sessions as { sessionID: string }[]).map((session) => session.sessionID)).toEqual(["ses_child2"])
    reloaded.dispose()
    harness.dispose()
  })
})

describe("shipped files", () => {
  test("the schemas directory is what the tools validate against", async () => {
    const harness = await createHarness()
    const source = await readFile(new URL("../schemas/meta.v1.json", import.meta.url), "utf8")
    expect(JSON.parse(source).id).toBe("meta/v1")
    const result = await runTool(harness, "orch_uni_validate_report", { text: '```json\n{"schema":"meta/v1"}\n```' })
    expect(result.code).toBe("E_INVALID")
    expect((result.errors as { path: string }[]).map((error) => error.path)).toContain("$.verdict")
    harness.dispose()
  })
})

describe("schema freshness", () => {
  test("a schema edited while the plugin is live is applied on the next validation", async () => {
    const schemas = await mkdtemp(path.join(tmpdir(), "audit-schemas-"))
    const document = (required: string[]) =>
      JSON.stringify({
        id: "probe/v1",
        schema: {
          type: "object",
          required,
          properties: { schema: { type: "string" }, verdict: { type: "string" } },
        },
      })
    await writeFile(path.join(schemas, "probe.v1.json"), document(["schema", "verdict"]), "utf8")
    const harness = await createHarness({ schemasDirectory: schemas })
    const text = '```json\n{"schema":"probe/v1","verdict":"pass"}\n```'
    expect(await runTool(harness, "orch_uni_validate_report", { text })).toMatchObject({
      valid: true,
      schema: "probe/v1",
    })

    // Same plugin instance, no reload: the next call must see the new file.
    await writeFile(path.join(schemas, "probe.v1.json"), document(["schema", "verdict", "gate"]), "utf8")
    const fresh = await runTool(harness, "orch_uni_validate_report", { text })
    expect(fresh).toMatchObject({ valid: false, code: "E_INVALID" })
    expect((fresh.errors as { path: string }[]).map((error) => error.path)).toContain("$.gate")

    harness.dispose()
    await rm(schemas, { recursive: true, force: true })
  })
})

describe("schema registry failures", () => {
  test("a broken or missing schemas directory is a typed refusal, not a throw", async () => {
    const text = '```json\n{"schema":"x/v1"}\n```'

    const broken = await mkdtemp(path.join(tmpdir(), "audit-schemas-broken-"))
    await writeFile(path.join(broken, "broken.v1.json"), "{ not json", "utf8")
    const brokenHarness = await createHarness({ schemasDirectory: broken })
    const brokenResult = await runTool(brokenHarness, "orch_uni_validate_report", { text })
    expect(brokenResult).toMatchObject({ ok: false, code: "E_SCHEMA_IO" })
    expect(brokenResult.directory).toBe(broken)
    expect(String(brokenResult.file)).toContain("broken.v1.json")
    expect(String(brokenResult.message)).toContain(broken)
    brokenHarness.dispose()
    await rm(broken, { recursive: true, force: true })

    const missingDirectory = path.join(await mkdtemp(path.join(tmpdir(), "audit-schemas-missing-")), "nope")
    const missingHarness = await createHarness({ schemasDirectory: missingDirectory })
    const missingResult = await runTool(missingHarness, "orch_uni_validate_report", { text })
    expect(missingResult).toMatchObject({ ok: false, code: "E_SCHEMA_IO" })
    expect(missingResult.directory).toBe(missingDirectory)
    expect(missingResult.file).toBeUndefined()
    expect(String(missingResult.message)).toContain(missingDirectory)
    const parent = path.dirname(missingDirectory)
    missingHarness.dispose()
    await rm(parent, { recursive: true, force: true })
  })
})

function child(id: string, parentID: string, agent: string) {
  return {
    id,
    parentID,
    agent,
    model: { id: "deepseek-flash", providerID: "deepseek", variant: "default" },
    title: "child",
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
  }
}
