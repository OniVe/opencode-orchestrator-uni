/**
 * report-schema — extraction and validation of the kit's SGR reports.
 *
 * An SGR report is a Markdown answer that ends with a fenced ```json block whose
 * `schema` field names one of the kit's report schemas (`factcheck/v1`,
 * `empiric/v1`, …). This module turns such a text into a deterministic
 * verdict: which schema it claims, whether it validates, and which prompt rules
 * a structurally valid report still misses.
 *
 * Everything here is pure: no filesystem, no plugin context, no I/O. Loading
 * `schemas/*.json` and the tool plumbing live in `lib/tools.ts`.
 *
 * The validator implements the documented subset of JSON Schema and nothing
 * else — `type` (single name or array of names, `null` included), `const`,
 * `enum`, `required`, `properties`, `additionalProperties`, `items`,
 * `minItems`. Unknown keywords are ignored on purpose: the subset is a contract,
 * and the test suite asserts that every shipped schema stays inside it.
 *
 * Two deliberate readings of that subset:
 * - `enum` is applied to scalar values; when the value is an array, `items`
 *   is applied instead. This is what lets `prism` (a string from an enum *or*
 *   an array of such strings) be expressed without a union keyword.
 * - unknown properties are allowed unless a schema sets
 *   `"additionalProperties": false`. Reports legitimately carry extra fields
 *   (`verdict_label`, `check`, …) and the agent prompts export that.
 */

/** Type names understood by the validator. */
export type JsonTypeName = "object" | "array" | "string" | "number" | "boolean" | "null"

/** A node of the supported JSON Schema subset. */
export interface JsonSchemaNode {
  readonly type?: JsonTypeName | readonly JsonTypeName[]
  readonly const?: unknown
  readonly enum?: readonly unknown[]
  readonly required?: readonly string[]
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>
  readonly items?: JsonSchemaNode
  readonly additionalProperties?: boolean
  readonly minItems?: number
}

/** Keys the validator implements; the test suite refuses schemas that use others. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "minItems",
])

/** Typed failure codes returned by `checkReport` and the `audit_validate_report` tool. */
export type ValidationCode =
  | "E_NO_JSON"
  | "E_PARSE"
  | "E_UNKNOWN_SCHEMA"
  | "E_SCHEMA_MISMATCH"
  | "E_INVALID"
  | "E_INPUT"

export interface SchemaError {
  readonly path: string
  readonly message: string
}

export interface ValidationReport {
  readonly valid: boolean
  /** Set when `valid` is false. */
  readonly code?: ValidationCode
  /** Schema the report was validated against, when it could be determined. */
  readonly schema?: string
  readonly errors: readonly SchemaError[]
  readonly warnings: readonly string[]
  /** Short human-readable summary; always set for extraction failures. */
  readonly message?: string
}

export interface CheckReportOptions {
  /** Schema id the caller expects (mismatch with the report is an error). */
  readonly expectedSchema?: string
  readonly schemas: ReadonlyMap<string, JsonSchemaNode>
}

/** Root path used in `SchemaError.path` (`$.findings[0].severity`). */
const ROOT = "$"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function typeNameOf(value: unknown): JsonTypeName {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    default:
      return "object"
  }
}

function normalizeTypes(type: JsonSchemaNode["type"]): readonly JsonTypeName[] | undefined {
  if (type === undefined) return undefined
  return Array.isArray(type) ? type : [type as JsonTypeName]
}

/** JSON deep equality, enough for `const`/`enum` comparisons. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]),
    )
  }
  return false
}

function brief(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined) return String(value)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

/**
 * Validate `value` against one schema node. Paths are JSON-pointer-ish and start
 * at `$`; the first failure at a node stops descending into it so a single
 * mistake does not flood the report.
 */
export function validateValue(value: unknown, node: JsonSchemaNode, path: string = ROOT): SchemaError[] {
  const errors: SchemaError[] = []
  const types = normalizeTypes(node.type)
  const actual = typeNameOf(value)
  if (types && !types.includes(actual)) {
    return [{ path, message: `expected type ${types.join("|")}, got ${actual}` }]
  }
  if (node.const !== undefined && !deepEqual(value, node.const)) {
    return [{ path, message: `expected const ${brief(node.const)}, got ${brief(value)}` }]
  }
  if (node.enum !== undefined && !Array.isArray(value) && !node.enum.some((candidate) => deepEqual(value, candidate))) {
    errors.push({ path, message: `expected one of ${node.enum.map((item) => brief(item)).join(", ")}, got ${brief(value)}` })
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      errors.push({ path, message: `expected at least ${node.minItems} items, got ${value.length}` })
    }
    if (node.items) {
      value.forEach((item, index) => {
        errors.push(...validateValue(item, node.items as JsonSchemaNode, `${path}[${index}]`))
      })
    }
    return errors
  }
  if (isPlainObject(value)) {
    const properties = node.properties ?? {}
    for (const key of node.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path: `${path}.${key}`, message: "required field is missing" })
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateValue(value[key], child, `${path}.${key}`))
      }
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push({ path: `${path}.${key}`, message: "additional property is not allowed" })
        }
      }
    }
  }
  return errors
}

/**
 * Every fenced ```` ```json ```` block body in the text, in order of appearance.
 * An unterminated block is ignored; fences are matched per line so CRLF and LF
 * texts behave identically.
 *
 * The opening marker is recognised anywhere in a line, because the agent prompts
 * introduce their SGR template as "Один блок ```json по схеме: …" and models
 * copy that shape; the rest of such an inline line is prose and is dropped. A
 * closing fence must be a line of its own.
 */
export function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = []
  let info: string | undefined
  let buffer: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (info === undefined) {
      const open = /```+\s*([A-Za-z0-9_+.#-]*)/.exec(line)
      if (open) {
        info = open[1] ?? ""
        buffer = []
      }
      continue
    }
    if (/^\s*```+\s*$/.test(line)) {
      if (/^json/i.test(info)) blocks.push(buffer.join("\n"))
      info = undefined
      buffer = []
      continue
    }
    buffer.push(line)
  }
  return blocks
}

/**
 * Pick the report block: the last ```json block that parses and carries a
 * string `schema` field; failing that, the last one that parses at all.
 */
export function selectReportJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: "E_NO_JSON" | "E_PARSE"; readonly message: string } {
  const blocks = extractJsonBlocks(text)
  if (blocks.length === 0) {
    return { ok: false, code: "E_NO_JSON", message: "no fenced ```json block found in the report" }
  }
  let lastParsed: unknown
  let hasParsed = false
  let lastWithSchema: unknown
  let hasWithSchema = false
  let firstError: string | undefined
  for (const block of blocks) {
    let value: unknown
    try {
      value = JSON.parse(block)
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : String(error)
      continue
    }
    lastParsed = value
    hasParsed = true
    if (isPlainObject(value) && typeof value.schema === "string") {
      lastWithSchema = value
      hasWithSchema = true
    }
  }
  if (hasWithSchema) return { ok: true, value: lastWithSchema }
  if (hasParsed) return { ok: true, value: lastParsed }
  return {
    ok: false,
    code: "E_PARSE",
    message: `no json block could be parsed as JSON: ${firstError ?? "unknown error"}`,
  }
}

/** Mandatory lines of the `invariant` report (prompt wording → match keywords). */
const INVARIANT_LINES: readonly { readonly label: string; readonly keywords: readonly string[] }[] = [
  { label: "ОТМЕНА/ТАЙМАУТЫ", keywords: ["отмен", "таймаут", "timeout", "cancel"] },
  { label: "СОГЛАСОВАННОСТЬ ПРОИЗВОДНЫХ ДАННЫХ", keywords: ["производн", "согласован", "snapshot", "кэш", "cache"] },
  { label: "МОНОТОННОСТЬ МЕТОК", keywords: ["монотон", "эпох", "верси", "счётчик", "счетчик"] },
  { label: "ВРАЖДЕБНЫЙ ВВОД", keywords: ["враждебн", "hostile", "инъекц", "quoting"] },
  { label: "ПОЛНОТА КЛАССА", keywords: ["полнота класса", "полнот", "однотипн"] },
  { label: "КОНТРАКТЫ «НЕИЗВЕСТНО»", keywords: ["неизвестно", "contract", "контракт"] },
  { label: "ЖИЗНЕННЫЙ ЦИКЛ ПРОЦЕССА", keywords: ["жизненный цикл", "shutdown", "сигнал", "лок", "pid"] },
  { label: "ТОЧНОСТЬ ДЕТЕКТОРОВ", keywords: ["детектор", "порог", "ложн"] },
  { label: "«ИЗВЕСТНЫЕ ФАКТЫ / УЖЕ УЧТЕНО»", keywords: ["известные факты", "уже учтено"] },
]

/** Self-check items the empiric prompt requires (приёмы 1–19). */
const EMPIRIC_SELF_CHECK_ITEMS = 19

/**
 * Cross-field rules the JSON Schema subset cannot express. These are prompt
 * requirements stated in prose ("rc обязателен ВСЕГДА", "lines_checked обязан
 * покрывать ВСЕ обязательные линии", redteam's closing_list/verdict invariant),
 * reported as warnings: a report can be structurally valid and still miss them.
 * Warnings are only computed for structurally valid reports.
 */
export function reportWarnings(schemaId: string, value: unknown): string[] {
  const warnings: string[] = []
  if (!isPlainObject(value)) return warnings
  const list = (key: string): readonly unknown[] => (Array.isArray(value[key]) ? (value[key] as readonly unknown[]) : [])
  const strings = (key: string): readonly string[] => list(key).filter((item): item is string => typeof item === "string")

  if (schemaId === "empiric/v1") {
    list("claims_checked").forEach((item, index) => {
      if (!isPlainObject(item)) return
      const method = item.method
      if (method !== "run" && method !== "measure" && method !== "compare_base") return
      const rc = item.rc
      if (rc === undefined || rc === null || rc === "") {
        warnings.push(`claims_checked[${index}]: rc is mandatory for method=${method} (SGR rules)`)
      }
    })
    const seen = new Set<number>()
    const duplicates: number[] = []
    for (const item of list("self_check")) {
      if (!isPlainObject(item) || typeof item.item !== "number") continue
      if (seen.has(item.item)) duplicates.push(item.item)
      seen.add(item.item)
    }
    const missing: number[] = []
    for (let item = 1; item <= EMPIRIC_SELF_CHECK_ITEMS; item += 1) if (!seen.has(item)) missing.push(item)
    if (missing.length > 0) {
      warnings.push(`self_check: items ${missing.join(", ")} of 1..${EMPIRIC_SELF_CHECK_ITEMS} are missing`)
    }
    if (duplicates.length > 0) warnings.push(`self_check: duplicate items ${duplicates.join(", ")}`)
  }

  if (schemaId === "invariant/v1") {
    list("invariants").forEach((item, index) => {
      if (!isPlainObject(item) || item.verdict !== "violated") return
      const counterexample = item.counterexample
      if (counterexample === undefined || counterexample === null || counterexample === "") {
        warnings.push(`invariants[${index}]: verdict=violated without a counterexample (SGR rules)`)
      }
    })
    const lines = list("lines_checked")
      .filter(isPlainObject)
      .map((item) => (typeof item.line === "string" ? item.line.toLowerCase() : ""))
    for (const required of INVARIANT_LINES) {
      const covered = lines.some((line) => required.keywords.some((keyword) => line.includes(keyword)))
      if (!covered) warnings.push(`lines_checked: mandatory line "${required.label}" is not covered`)
    }
  }

  if (schemaId === "meta/v1") {
    if (typeof value.gate === "string" && typeof value.verdict === "string" && value.gate !== value.verdict) {
      warnings.push(`verdict (${value.verdict}) differs from gate (${value.gate}); verdict is a synonym of gate`)
    }
  }

  if (schemaId === "redteam/v1") {
    const closing = strings("closing_list")
    const gaps = strings("coverage_gaps")
    if (value.verdict === "ready" && closing.length > 0) {
      warnings.push("invariant violated: closing_list is not empty while verdict=ready")
    }
    if (value.verdict === "not_ready" && closing.length === 0 && gaps.length === 0) {
      warnings.push("verdict=not_ready with an empty closing_list and coverage_gaps; rules demote it to ready")
    }
  }

  return warnings
}

/**
 * Full pipeline: extract the report block, resolve its schema, validate it and
 * collect prompt-level warnings. Never throws for malformed input — every
 * outcome is a `ValidationReport` with a typed `code` when `valid` is false.
 */
export function checkReport(text: string, options: CheckReportOptions): ValidationReport {
  const selected = selectReportJson(text)
  if (!selected.ok) {
    return { valid: false, code: selected.code, errors: [], warnings: [], message: selected.message }
  }
  const value = selected.value
  const reported = isPlainObject(value) && typeof value.schema === "string" ? value.schema : undefined
  const expected = options.expectedSchema

  if (expected !== undefined && !options.schemas.has(expected)) {
    return {
      valid: false,
      code: "E_UNKNOWN_SCHEMA",
      schema: expected,
      errors: [],
      warnings: [],
      message: `unknown expected schema "${expected}"`,
    }
  }
  const schemaId = reported ?? expected
  if (schemaId === undefined) {
    return {
      valid: false,
      code: "E_UNKNOWN_SCHEMA",
      errors: [],
      warnings: [],
      message: 'the report has no "schema" field and no schema was expected',
    }
  }
  const schema = options.schemas.get(schemaId)
  if (schema === undefined) {
    return {
      valid: false,
      code: "E_UNKNOWN_SCHEMA",
      schema: schemaId,
      errors: [],
      warnings: [],
      message: `unknown schema id "${schemaId}"`,
    }
  }
  if (expected !== undefined && reported !== undefined && reported !== expected) {
    return {
      valid: false,
      code: "E_SCHEMA_MISMATCH",
      schema: reported,
      errors: [],
      warnings: [],
      message: `expected schema "${expected}", report declares "${reported}"`,
    }
  }
  const errors = validateValue(value, schema)
  if (errors.length > 0 || !isPlainObject(value)) {
    return {
      valid: false,
      code: "E_INVALID",
      schema: schemaId,
      errors,
      warnings: [],
      message: `report does not satisfy ${schemaId}: ${errors.length} validation error(s)`,
    }
  }
  return {
    valid: true,
    schema: schemaId,
    errors: [],
    warnings: reportWarnings(schemaId, value),
  }
}

/**
 * Collect every keyword used anywhere in a schema document, including nested
 * `properties`/`items` nodes. Used by the test suite to reject schemas that
 * step outside `SUPPORTED_KEYWORDS`.
 */
export function collectSchemaKeywords(node: unknown, keywords: Set<string> = new Set()): Set<string> {
  if (!isPlainObject(node)) return keywords
  for (const [key, child] of Object.entries(node)) {
    keywords.add(key)
    if (key === "properties" && isPlainObject(child)) {
      for (const property of Object.values(child)) collectSchemaKeywords(property, keywords)
    } else if (key === "items") {
      collectSchemaKeywords(child, keywords)
    }
  }
  return keywords
}
