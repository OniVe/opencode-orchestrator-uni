/**
 * Guards against drift between the agent prompts and the shipped schemas.
 *
 * Source of truth: the SGR section of every `agents/*.md`. For each agent we
 * take the JSON template from its prompt, replace the documented enum
 * placeholders with concrete alternatives, and require that it validates
 * against the schema the same prompt names. Each alternative of every enum
 * placeholder is tried, so adding an enum value to a prompt without adding it to
 * the schema fails here.
 */
import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  SUPPORTED_KEYWORDS,
  collectSchemaKeywords,
  validateValue,
  type JsonSchemaNode,
} from "../lib/report-schema"
import { SCHEMAS_DIRECTORY, loadSchemas } from "../lib/tools"
import { AGENTS_DIRECTORY } from "../index"

/** `name.vN.json` → `name/vN` (the ids shipped with the kit). */
const EXPECTED_SCHEMAS = [
  "factcheck/v1",
  "empiric/v1",
  "invariant/v1",
  "arbiter/v1",
  "meta/v1",
  "redteam/v1",
  "fix-runner/v1",
]

const ENUM_PLACEHOLDER = /[A-Za-z][A-Za-z_]*(\s*\|\s*[A-Za-z_]+)+/

interface EnumPath {
  readonly path: readonly (string | number)[]
  readonly alternatives: readonly string[]
}

function collectEnumPaths(value: unknown, prefix: readonly (string | number)[] = []): EnumPath[] {
  if (typeof value === "string") {
    const match = ENUM_PLACEHOLDER.exec(value)
    if (match === null) return []
    const alternatives = match[0]
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part !== "")
    return alternatives.length > 1 ? [{ path: prefix, alternatives }] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectEnumPaths(item, [...prefix, index]))
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => collectEnumPaths(child, [...prefix, key]))
  }
  return []
}

function cloneWith(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  if (path.length === 0) return replacement
  const [head, ...rest] = path
  if (Array.isArray(value)) {
    const copy = value.slice()
    copy[head as number] = cloneWith(copy[head as number], rest, replacement)
    return copy
  }
  const source = value as Record<string, unknown>
  return { ...source, [head as string]: cloneWith(source[head as string], rest, replacement) }
}

/** Every JSON object in the text that carries a string `schema` field. */
function promptTemplates(markdown: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  for (let start = 0; start < markdown.length; start += 1) {
    if (markdown[start] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < markdown.length; index += 1) {
      const character = markdown[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
        continue
      }
      if (character === "{") depth += 1
      else if (character === "}") {
        depth -= 1
        if (depth > 0) continue
        try {
          const value = JSON.parse(markdown.slice(start, index + 1)) as Record<string, unknown>
          if (typeof value.schema === "string") found.push(value)
        } catch {
          // not a JSON object; ignore
        }
        break
      }
    }
  }
  return found
}

/** The SGR template of an agent prompt: the last JSON object naming a schema. */
function reportTemplate(markdown: string): Record<string, unknown> {
  const template = promptTemplates(markdown).at(-1)
  if (template === undefined) throw new Error("no JSON SGR template found in the agent prompt")
  return template
}

/** Replace every enum placeholder with its first alternative. */
function concretize(template: Record<string, unknown>): Record<string, unknown> {
  let value: unknown = template
  for (const { path: where, alternatives } of collectEnumPaths(template)) {
    value = cloneWith(value, where, alternatives[0])
  }
  return value as Record<string, unknown>
}

describe("shipped report schemas", () => {
  test("the seven kit schemas are shipped and no others", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    expect([...schemas.keys()].sort()).toEqual([...EXPECTED_SCHEMAS].sort())
    const files = (await readdir(SCHEMAS_DIRECTORY)).filter((name) => name.endsWith(".json"))
    expect(files.length).toBe(EXPECTED_SCHEMAS.length)
  })

  test("every schema uses only supported keywords", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    for (const [id, schema] of schemas) {
      const keywords = collectSchemaKeywords(schema)
      for (const keyword of keywords) {
        expect(SUPPORTED_KEYWORDS.has(keyword), `${id} uses unsupported keyword "${keyword}"`).toBe(true)
      }
      expect((schema as { type?: unknown }).type, `${id} is an object schema`).toBe("object")
    }
  })

  test("every schema pins its own id through const", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    for (const [id, schema] of schemas) {
      const schemaField = schema.properties?.schema
      expect(schemaField?.const, `${id} pins its id`).toBe(id)
      expect(schemaField?.type).toBe("string")
    }
  })

  test("requires only the fields the prompt template lists", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    for (const [id, schema] of schemas) {
      for (const field of schema.required ?? []) {
        expect(schema.properties?.[field], `${id}.${field} is required and described`).toBeDefined()
      }
    }
  })
})

describe("agent prompts and schemas agree", () => {
  const agents = () =>
    readdir(AGENTS_DIRECTORY).then((names) => names.filter((name) => name.endsWith(".md")).sort())

  /** Agent id → SGR template found in its prompt (only report-producing agents have one). */
  async function templatesByAgent(): Promise<Map<string, Record<string, unknown>>> {
    const templates = new Map<string, Record<string, unknown>>()
    for (const file of await agents()) {
      const markdown = await readFile(path.join(AGENTS_DIRECTORY, file), "utf8")
      const template = promptTemplates(markdown).at(-1)
      if (template !== undefined) templates.set(file.replace(/\.md$/, ""), template)
    }
    return templates
  }

  test("the report-producing agents are exactly the shipped schemas", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    const templates = await templatesByAgent()
    const produced = [...templates.values()].map((template) => template.schema as string)
    expect(produced.sort()).toEqual([...EXPECTED_SCHEMAS].sort())
    for (const [agent, template] of templates) {
      expect(schemas.has(template.schema as string), `${agent} → ${String(template.schema)}`).toBe(true)
    }
    // The root orchestrator audits nothing itself: it has no SGR template.
    expect(templates.has("orchestrator")).toBe(false)
  })

  test("the SGR template of every agent validates against its schema", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    for (const [agent, template] of await templatesByAgent()) {
      const schema = schemas.get(template.schema as string) as JsonSchemaNode
      const errors = validateValue(concretize(template), schema)
      expect(errors, `${agent} SGR template: ${JSON.stringify(errors)}`).toEqual([])
    }
  })

  test("every enum alternative named in a prompt is accepted by the schema", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    for (const [agent, template] of await templatesByAgent()) {
      const schema = schemas.get(template.schema as string) as JsonSchemaNode
      for (const { path: where, alternatives } of collectEnumPaths(template)) {
        for (const alternative of alternatives) {
          const variant = cloneWith(concretize(template), where, alternative)
          const errors = validateValue(variant, schema)
          expect(errors, `${agent} ${where.join(".")} = "${alternative}": ${JSON.stringify(errors)}`).toEqual([])
        }
      }
    }
  })
})
