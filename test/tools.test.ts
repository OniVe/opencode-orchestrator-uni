/**
 * Registration and executor tests for the `orch_uni_*` tools, driven by a mock
 * plugin context (same style as `plugin.test.ts`: the harness mimics the engine
 * editors as observed in OpenCode 2.0.x).
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TOOL_IDS, TOOL_NAMESPACE } from "../lib/tools"
import { createHarness, runTool } from "./support/harness"

describe("audit tool registration", () => {
  test("registers the three tools in the orch_uni namespace", async () => {
    const harness = await createHarness()
    expect([...harness.tools.keys()].sort()).toEqual([...TOOL_IDS].sort())
    expect(harness.namespaces.map((entry) => entry.name)).toEqual([TOOL_NAMESPACE])
    for (const id of TOOL_IDS) {
      const tool = harness.tools.get(id)!
      expect(tool.options?.namespace).toBe(TOOL_NAMESPACE)
      expect(tool.description.length).toBeGreaterThan(40)
      expect(typeof tool.execute).toBe("function")
    }
    harness.dispose()
  })

  test("declares the documented input fields", async () => {
    const harness = await createHarness()
    const inputs = Object.fromEntries([...harness.tools].map(([id, tool]) => [id, tool.input]))
    expect(Object.keys(inputs).sort()).toEqual([...TOOL_IDS].sort())
    expect(inputs.orch_uni_validate_report).toEqual({
      type: "object",
      properties: {
        text: { type: "string", description: expect.any(String) },
        path: { type: "string", description: expect.any(String) },
        schema: { type: "string", description: expect.any(String) },
      },
    })
    expect((inputs.orch_uni_snapshot as { required: string[] }).required).toEqual(["path"])
    expect((inputs.orch_uni_sessions as { properties: Record<string, unknown> }).properties).toEqual({
      sessionID: { type: "string", description: expect.any(String) },
      recursive: { type: "boolean", description: expect.any(String) },
    })
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
