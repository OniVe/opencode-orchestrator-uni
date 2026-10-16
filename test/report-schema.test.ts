/**
 * Unit tests for the report validator: block extraction, the documented JSON
 * Schema subset, the schema-selection pipeline (one negative case per typed
 * code) and the prompt-level warnings.
 */
import { describe, expect, test } from "bun:test"
import {
  checkReport,
  extractJsonBlocks,
  type JsonSchemaNode,
  reportWarnings,
  selectReportJson,
  validateValue,
} from "../lib/report-schema"
import { loadSchemas } from "../lib/tools"

const schemas = await loadSchemas()

function fence(body: string): string {
  return ["# Отчёт", "", "```json", body, "```", ""].join("\n")
}

const META_OK = {
  schema: "meta/v1",
  verdict: "pass",
  gate: "pass",
  closing_list: [],
  coverage_gaps: [],
  reports: [{ report: "reports/empiric-r1.md", result: "pass", violations: [] }],
}

describe("fenced block extraction", () => {
  test("reads json blocks in order and ignores other languages", () => {
    const text = ["```ts", "const a = 1", "```", "```json", "{}", "```", "```JSON", '{"a":1}', "```"].join("\n")
    expect(extractJsonBlocks(text)).toEqual(["{}", '{"a":1}'])
  })

  test("handles CRLF and an unterminated block", () => {
    const text = '```json\r\n{ }\r\n```\r\n```json\r\n{ "a": 1 }'
    expect(extractJsonBlocks(text)).toEqual(["{ }"])
  })

  test("prefers the last block carrying a schema field", () => {
    const text = [fence('{"other":true}'), fence('{"schema":"meta/v1"}')].join("\n")
    const selected = selectReportJson(text)
    expect(selected.ok).toBe(true)
    if (selected.ok) expect(selected.value).toEqual({ schema: "meta/v1" })
  })

  test("falls back to the last parsable block without a schema field", () => {
    const text = [fence('{"a":1}'), fence('{"b":2}')].join("\n")
    const selected = selectReportJson(text)
    expect(selected.ok).toBe(true)
    if (selected.ok) expect(selected.value).toEqual({ b: 2 })
  })

  test("E_NO_JSON when there is no json block", () => {
    const report = checkReport("просто текст", { schemas })
    expect(report.valid).toBe(false)
    expect(report.code).toBe("E_NO_JSON")
    expect(report.errors).toEqual([])
    expect(report.message).toContain("fenced")
  })

  test("E_PARSE when no block is valid JSON", () => {
    const report = checkReport(fence('{"a": }'), { schemas })
    expect(report.code).toBe("E_PARSE")
    expect(report.message).toContain("could be parsed")
  })
})

describe("schema selection", () => {
  test("valid report passes", () => {
    const report = checkReport(fence(JSON.stringify(META_OK)), { schemas })
    expect(report).toEqual({ valid: true, schema: "meta/v1", errors: [], warnings: [] })
  })

  test("extra fields are allowed", () => {
    const value = { ...META_OK, verdict_label: "пройдено", reports: [{ ...META_OK.reports[0], hint: "x" }] }
    expect(checkReport(fence(JSON.stringify(value)), { schemas }).valid).toBe(true)
  })

  test("E_UNKNOWN_SCHEMA for an unshipped id", () => {
    const report = checkReport(fence('{"schema":"audit-nope/v1"}'), { schemas })
    expect(report.code).toBe("E_UNKNOWN_SCHEMA")
    expect(report.schema).toBe("audit-nope/v1")
  })

  test("E_UNKNOWN_SCHEMA for an unknown expected schema", () => {
    const report = checkReport(fence(JSON.stringify(META_OK)), { schemas, expectedSchema: "audit-nope/v1" })
    expect(report.code).toBe("E_UNKNOWN_SCHEMA")
    expect(report.message).toContain("expected")
  })

  test("E_UNKNOWN_SCHEMA when the report names no schema and none is expected", () => {
    const report = checkReport(fence('{"verdict":"pass"}'), { schemas })
    expect(report.code).toBe("E_UNKNOWN_SCHEMA")
  })

  test("E_SCHEMA_MISMATCH when the report names another schema than expected", () => {
    const report = checkReport(fence(JSON.stringify(META_OK)), { schemas, expectedSchema: "empiric/v1" })
    expect(report.code).toBe("E_SCHEMA_MISMATCH")
    expect(report.schema).toBe("meta/v1")
  })

  test("expected schema is used when the report omits the field", () => {
    const report = checkReport(fence(JSON.stringify({ verdict: "pass" })), { schemas, expectedSchema: "meta/v1" })
    expect(report.code).toBe("E_INVALID")
    expect(report.errors.some((error) => error.path === "$.schema")).toBe(true)
  })

  test("E_INVALID lists structured errors", () => {
    const value = { ...META_OK, verdict: "maybe", reports: [{ report: "x", result: "pass" }] }
    const report = checkReport(fence(JSON.stringify(value)), { schemas })
    expect(report.code).toBe("E_INVALID")
    expect(report.errors.map((error) => error.path).sort()).toEqual(["$.reports[0].violations", "$.verdict"])
    expect(report.warnings).toEqual([])
  })
})

describe("validator subset", () => {
  test("type: names, arrays of names and null", () => {
    expect(validateValue("x", { type: "string" })).toEqual([])
    expect(validateValue(1, { type: "string" })).toEqual([{ path: "$", message: "expected type string, got number" }])
    expect(validateValue(null, { type: ["string", "null"] })).toEqual([])
    expect(validateValue([], { type: "object" })).toEqual([{ path: "$", message: "expected type object, got array" }])
  })

  test("const and enum, including the array reading used by prism", () => {
    expect(validateValue("a", { const: "a" })).toEqual([])
    expect(validateValue("b", { const: "a" })).toEqual([{ path: "$", message: 'expected const "a", got "b"' }])
    expect(validateValue("x", { enum: ["a", "b"] })[0]?.message).toContain("expected one of")
    const prism: JsonSchemaNode = {
      type: ["string", "array"],
      enum: ["a", "b"],
      items: { type: "string", enum: ["a", "b"] },
    }
    expect(validateValue("a", prism)).toEqual([])
    expect(validateValue(["a", "b"], prism)).toEqual([])
    expect(validateValue(["a", "c"], prism)).toEqual([{ path: "$[1]", message: 'expected one of "a", "b", got "c"' }])
    expect(validateValue("c", prism)).toHaveLength(1)
  })

  test("required, properties, nested items and minItems", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string" },
        b: {
          type: "array",
          minItems: 2,
          items: { type: "object", required: ["c"], properties: { c: { type: "number" } } },
        },
      },
    }
    expect(validateValue({ a: "x" }, schema)).toEqual([])
    expect(validateValue({}, schema)).toEqual([{ path: "$.a", message: "required field is missing" }])
    expect(validateValue({ a: "x", b: [{}] }, schema).map((error) => error.path)).toEqual(["$.b", "$.b[0].c"])
    expect(validateValue({ a: "x", b: [1, { c: 1 }] }, schema)[0]?.path).toBe("$.b[0]")
  })

  test("additionalProperties defaults to permissive and can be closed", () => {
    const open: JsonSchemaNode = { type: "object", properties: { a: { type: "string" } } }
    expect(validateValue({ a: "x", z: 1 }, open)).toEqual([])
    const closed: JsonSchemaNode = { ...open, additionalProperties: false }
    expect(validateValue({ a: "x", z: 1 }, closed)).toEqual([
      { path: "$.z", message: "additional property is not allowed" },
    ])
  })

  test("a wrong node type stops descending", () => {
    const schema: JsonSchemaNode = { type: "object", properties: { a: { type: "string", enum: ["x"] } } }
    expect(validateValue({ a: 5 }, schema)).toHaveLength(1)
  })
})

describe("prompt-level warnings", () => {
  test("empiric: rc for run|measure|compare_base and self_check items 1..19", () => {
    const value = {
      schema: "empiric/v1",
      claims_checked: [
        { claim: "a", method: "run", result: "x", verdict: "confirmed" },
        { claim: "b", method: "source", result: "y", verdict: "unverifiable" },
      ],
      self_check: [{ item: 1, title: "t", status: "applied", note: "n" }],
    }
    const warnings = reportWarnings("empiric/v1", value)
    expect(warnings).toContain("claims_checked[0]: rc is mandatory for method=run (SGR rules)")
    expect(warnings.some((line) => line.startsWith("self_check: items 2, 3"))).toBe(true)
    expect(warnings.some((line) => line.includes("rc is mandatory for method=source"))).toBe(false)
  })

  test("empiric: duplicates in self_check", () => {
    const value = { self_check: [{ item: 1 }, { item: 1 }] }
    expect(reportWarnings("empiric/v1", value).some((line) => line.includes("duplicate items 1"))).toBe(true)
  })

  test("invariant: violated invariants without a counterexample", () => {
    const warnings = reportWarnings("invariant/v1", {
      invariants: [
        { id: "I1", statement: "s", verdict: "violated" },
        { id: "I2", statement: "s", verdict: "violated", counterexample: "T1→T2" },
        { id: "I3", statement: "s", verdict: "held" },
      ],
    })
    expect(warnings).toContain("invariants[0]: verdict=violated without a counterexample (SGR rules)")
    expect(warnings.some((line) => line.includes("invariants[1]"))).toBe(false)
    expect(warnings.some((line) => line.includes("invariants[2]"))).toBe(false)
  })

  test("invariant: uncovered mandatory lines", () => {
    const warnings = reportWarnings("invariant/v1", {
      lines_checked: [{ line: "ОТМЕНА/ТАЙМАУТЫ", status: "checked", note: "n" }],
    })
    expect(warnings).toHaveLength(8)
    expect(warnings.every((line) => line.startsWith("lines_checked:"))).toBe(true)
    const covered = reportWarnings("invariant/v1", {
      lines_checked: [
        { line: "ОТМЕНА/ТАЙМАУТЫ" },
        { line: "СОГЛАСОВАННОСТЬ ПРОИЗВОДНЫХ ДАННЫХ" },
        { line: "МОНОТОННОСТЬ МЕТОК" },
        { line: "ВРАЖДЕБНЫЙ ВВОД" },
        { line: "ПОЛНОТА КЛАССА" },
        { line: "КОНТРАКТЫ «НЕИЗВЕСТНО»" },
        { line: "ЖИЗНЕННЫЙ ЦИКЛ ПРОЦЕССА" },
        { line: "ТОЧНОСТЬ ДЕТЕКТОРОВ" },
        { line: "«ИЗВЕСТНЫЕ ФАКТЫ / УЖЕ УЧТЕНО»" },
      ],
    })
    expect(covered).toEqual([])
  })

  test("meta: verdict is a synonym of gate", () => {
    expect(reportWarnings("meta/v1", { gate: "pass", verdict: "fail" })[0]).toContain("differs from gate")
    expect(reportWarnings("meta/v1", { gate: "fail", verdict: "fail" })).toEqual([])
  })

  test("redteam: closing_list/verdict invariants", () => {
    expect(reportWarnings("redteam/v1", { verdict: "ready", closing_list: ["R1"] })[0]).toContain("invariant violated")
    expect(reportWarnings("redteam/v1", { verdict: "not_ready", closing_list: [], coverage_gaps: [] })[0]).toContain(
      "demote",
    )
    expect(reportWarnings("redteam/v1", { verdict: "not_ready", closing_list: ["R1"], coverage_gaps: [] })).toEqual([])
  })

  test("warnings are only computed for structurally valid reports", () => {
    const value = { ...META_OK, verdict: "maybe", gate: "pass" }
    const report = checkReport(fence(JSON.stringify(value)), { schemas })
    expect(report.valid).toBe(false)
    expect(report.warnings).toEqual([])
  })
})
