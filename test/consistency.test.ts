/**
 * Guards identifier consistency across the kit: agent ids ↔ SGR schemas ↔ schema
 * file names ↔ tool ids ↔ prose on the shipping surface (`README.md`, `docs/**`,
 * `agents/**`, `lib/**`, `schemas/**`, `index.ts`, `package.json`).
 *
 * The drift this closes: after the `audit-`/`audit_` rename nothing tied the
 * shipping ids together, so stale agent references in the process documents, a
 * renamed schema file, or a namespaced tool name lost in prose all passed the
 * suite untouched (`test/schemas.test.ts` only checks the schema set itself).
 *
 * Surface rule: `eval/`, `test/` and `lab/` are the dev contour and stay out of
 * the scan — they may legitimately mention historical labels (`audit-*` roles in
 * the legacy results/baselines of `eval/`, temp prefixes in `test/`).
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { AGENTS_DIRECTORY, DOCS_DIRECTORY, PLUGIN_ID } from "../index"
import { SCHEMAS_DIRECTORY, TOOL_IDS, loadSchemas } from "../lib/tools"
import { schemaForRole } from "../eval/derive"

const KIT_ROOT = path.resolve(AGENTS_DIRECTORY, "..")
const BASELINES_DIRECTORY = path.join(KIT_ROOT, "eval", "baselines")

/** Shipping surface: scanned recursively plus the standalone entry/metadata files. */
const SHIPPED_DIRECTORIES = [
  DOCS_DIRECTORY,
  AGENTS_DIRECTORY,
  path.join(KIT_ROOT, "lib"),
  path.join(KIT_ROOT, "schemas"),
]
const SHIPPED_FILES = [
  path.join(KIT_ROOT, "README.md"),
  path.join(KIT_ROOT, "index.ts"),
  path.join(KIT_ROOT, "package.json"),
]

/** Agents that audit nothing themselves: they ship no SGR template (and no schema). */
const SCHEMA_LESS_AGENTS = new Set(["orchestrator"])

/** Stale identifiers that must not survive a rename: agent ids, tool ids, references. */
const FORBIDDEN_PROSE: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "old agent id", pattern: /\baudit-(?:factcheck|empiric|invariant|arbiter|meta|redteam)\b/g },
  { what: "old tool id", pattern: /\baudit[-_](?:validate[-_]report|snapshot|sessions)\b/g },
  { what: "prefixed agent reference", pattern: /(agent|--agent)[^A-Za-z]{0,6}audit-/g },
]

/**
 * Package identity (the `P1` rename): the published name (`package.json` →
 * `package-lock.json` → tarball name → install command) and the plugin id
 * (`index.ts` → `[orchestrator.uni]` diagnostics prefix → storage/selector scope).
 * The two are independent literals — neither is derivable from the other, and the
 * consumer meets them before any code — so a half-rename of one carrier used to stay
 * green (`test/plugin.test.ts` only compares `plugin.id` with that same source
 * constant). Each carrier is pinned to the literal below.
 */
const PACKAGE_NAME = "opencode-orchestrator-uni"
const PLUGIN_ID_LITERAL = "orchestrator.uni"

/**
 * Pre-`P1` identity tokens. One pattern covers both reported forms: the bare
 * `orchestrator-agents` (the former plugin id) and the packaged
 * `opencode-orchestrator-agents`, which contains the bare form as a `-`-delimited
 * token. Word boundaries keep lookalikes such as `orchestrator-agents-kit` inside
 * the class as well (conservative).
 */
const OLD_IDENTITY_TOKENS = /\b(?:opencode-)?orchestrator-agents\b/g

/** Effective tool id in prose: `orch_uni_<name>`, plus the documented wildcard `orch_uni_*`. */
const TOOL_TOKEN = /\borch_uni_[A-Za-z0-9_*]+/g
const TOOL_TOKEN_ALLOWED = new Set([...TOOL_IDS, "orch_uni_*"])

/** Every JSON object in markdown that carries a string `schema` field. */
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

async function agentFiles(): Promise<string[]> {
  return (await readdir(AGENTS_DIRECTORY)).filter((name) => name.endsWith(".md")).sort()
}

/** Agent id → the last SGR template found in its prompt (`.at(-1)` like the schema guard). */
async function templatesByAgent(): Promise<Map<string, Record<string, unknown>>> {
  const templates = new Map<string, Record<string, unknown>>()
  for (const file of await agentFiles()) {
    const markdown = await readFile(path.join(AGENTS_DIRECTORY, file), "utf8")
    const template = promptTemplates(markdown).at(-1)
    if (template !== undefined) templates.set(file.replace(/\.md$/, ""), template)
  }
  return templates
}

/** Every file under the shipping directories (recursively). */
async function surfaceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await surfaceFiles(full)))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

describe("agent ids and their report schemas", () => {
  test("every report-producing agent pins <id>/v1 and ships schemas/<id>.v1.json", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    const templates = await templatesByAgent()
    for (const file of await agentFiles()) {
      const id = file.replace(/\.md$/, "")
      const template = templates.get(id)
      if (SCHEMA_LESS_AGENTS.has(id)) {
        expect(template, `${id} produces no SGR`).toBeUndefined()
        expect(schemas.has(`${id}/v1`), `${id} ships no schema`).toBe(false)
        continue
      }
      expect(template, `agents/${id}.md carries an SGR template`).toBeDefined()
      expect(template?.schema, `${id} template pins ${id}/v1`).toBe(`${id}/v1`)
      expect(schemas.has(`${id}/v1`), `${id}/v1 is loaded by loadSchemas()`).toBe(true)
      expect(existsSync(path.join(SCHEMAS_DIRECTORY, `${id}.v1.json`)), `schemas/${id}.v1.json exists`).toBe(true)
    }
  })

  test("every schema file is named after its own id", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    const files = (await readdir(SCHEMAS_DIRECTORY)).filter((name) => name.endsWith(".json")).sort()
    const expected = [...schemas.keys()].map((id) => `${id.replaceAll("/", ".")}.json`).sort()
    expect(files).toEqual(expected)
  })
})

describe("prose references only existing agent and tool ids", () => {
  test("no stale ids or renamed tool references on the shipping surface", async () => {
    const files = [...(await Promise.all(SHIPPED_DIRECTORIES.map(surfaceFiles))).flat(), ...SHIPPED_FILES]
    expect(files.length).toBeGreaterThan(5)
    const violations: string[] = []
    for (const file of files) {
      const relative = path.relative(KIT_ROOT, file)
      const markdown = await readFile(file, "utf8")
      for (const { what, pattern } of FORBIDDEN_PROSE) {
        for (const match of markdown.matchAll(pattern)) {
          const line = markdown.slice(0, match.index).split("\n").length
          violations.push(`${relative}:${line}: ${what} "${match[0].trim()}"`)
        }
      }
      for (const match of markdown.matchAll(TOOL_TOKEN)) {
        if (TOOL_TOKEN_ALLOWED.has(match[0])) continue
        const line = markdown.slice(0, match.index).split("\n").length
        violations.push(`${relative}:${line}: unknown tool id "${match[0]}" (TOOL_IDS: ${TOOL_IDS.join(", ")})`)
      }
    }
    expect(violations).toEqual([])
  })

  test("every agent prompt names the validator by its effective id", async () => {
    for (const file of await agentFiles()) {
      const markdown = await readFile(path.join(AGENTS_DIRECTORY, file), "utf8")
      expect(/\borch_uni_validate_report\b/.test(markdown), `${file} names orch_uni_validate_report`).toBe(true)
    }
  })
})

describe("eval baselines agree with the agent roles", () => {
  test("every baseline run targets a report-producing role and its schema", async () => {
    const schemas = await loadSchemas(SCHEMAS_DIRECTORY)
    const roles = new Set([...schemas.keys()].map((id) => id.replace(/\/v\d+$/, "")))
    const files = (await readdir(BASELINES_DIRECTORY)).filter((name) => name.endsWith(".json")).sort()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const baseline = JSON.parse(await readFile(path.join(BASELINES_DIRECTORY, file), "utf8")) as {
        provenance?: unknown
        runs?: { role?: unknown; reportSchema?: unknown }[]
      }
      const provenance = baseline.provenance
      // Content contract of a baseline: the top-level `provenance` marker (origin of a
      // relabeled/historical run) is mandatory and its `relabeled` flag is a boolean.
      // `reportPath`/`stdoutPath` are historical artifact names — their local existence
      // is deliberately not required (see `eval/README.md`).
      expect(typeof provenance, `${file} carries a provenance object`).toBe("object")
      expect(provenance !== null && !Array.isArray(provenance), `${file}: provenance is a plain object`).toBe(true)
      expect(
        typeof (provenance as { relabeled?: unknown } | null)?.relabeled,
        `${file}: provenance.relabeled is a boolean`,
      ).toBe("boolean")
      const runs = baseline.runs ?? []
      expect(runs.length, `${file} records runs`).toBeGreaterThan(0)
      for (const run of runs) {
        const role = String(run.role)
        // Plugin-prefixed roles (`uni.empiric`) map onto the same report contract.
        const base = role.slice(role.lastIndexOf(".") + 1)
        expect(roles.has(base), `${file}: "${role}" is a report-producing agent`).toBe(true)
        expect(run.reportSchema, `${file}: "${role}" pins ${base}/v1`).toBe(schemaForRole(role))
      }
    }
  })
})

/**
 * Scan surface = the shipping surface declared at the top of this file
 * (`SHIPPED_DIRECTORIES` + `SHIPPED_FILES`); the dev contour (`eval/`, `test/`, `lab/`)
 * stays out, and `package-lock.json` is out of the token scan because it is not
 * shipped — its `name` is pinned explicitly instead.
 */
describe("package identity", () => {
  test("package.json and package-lock.json pin the published name", async () => {
    const manifest = JSON.parse(await readFile(path.join(KIT_ROOT, "package.json"), "utf8")) as { name?: unknown }
    expect(manifest.name, "package.json name").toBe(PACKAGE_NAME)
    const lock = JSON.parse(await readFile(path.join(KIT_ROOT, "package-lock.json"), "utf8")) as {
      name?: unknown
      packages?: Record<string, { name?: unknown } | undefined>
    }
    expect(lock.name, "package-lock.json name").toBe(PACKAGE_NAME)
    expect(lock.packages?.[""]?.name, 'package-lock.json packages[""].name').toBe(PACKAGE_NAME)
  })

  test("PLUGIN_ID and README carry both identities", async () => {
    expect(PLUGIN_ID, "index.ts PLUGIN_ID").toBe(PLUGIN_ID_LITERAL)
    const readme = await readFile(path.join(KIT_ROOT, "README.md"), "utf8")
    expect(readme.includes(PACKAGE_NAME), `README.md names the package ${PACKAGE_NAME}`).toBe(true)
    expect(readme.includes(PLUGIN_ID_LITERAL), `README.md names the plugin id ${PLUGIN_ID_LITERAL}`).toBe(true)
  })

  test("the shipping surface carries no pre-rename identity token", async () => {
    const files = [...(await Promise.all(SHIPPED_DIRECTORIES.map(surfaceFiles))).flat(), ...SHIPPED_FILES]
    expect(files.length).toBeGreaterThan(5)
    const violations: string[] = []
    for (const file of files) {
      const relative = path.relative(KIT_ROOT, file)
      const content = await readFile(file, "utf8")
      for (const match of content.matchAll(OLD_IDENTITY_TOKENS)) {
        const line = content.slice(0, match.index).split("\n").length
        violations.push(`${relative}:${line}: pre-rename identity token "${match[0]}"`)
      }
    }
    expect(violations).toEqual([])
  })
})
