/**
 * Locale-aware helpers shared by the translation guard (`test/translation.test.ts`)
 * and the dev checkers (`tools/locale-check.ts`, `tools/kit-verify.ts`).
 *
 * The kit ships the same agent definitions and process documents in several
 * languages. These helpers describe what must stay invariant between a source
 * locale and its translation: file sets, frontmatter, markdown shape, and the
 * schema-bound enum tokens inside SGR JSON templates.
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"
import { AGENTS_DIRECTORY, DOCS_DIRECTORY, type Locale } from "../../index"

/** Locale that the other locales are translated from (the originals). */
export const REFERENCE_LOCALE: Locale = "ru"

/** Markdown file names (sorted) in `<root>/<locale>/`; `[]` when the directory is absent. */
async function localeFiles(root: string, locale: Locale): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, locale), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export function agentFiles(locale: Locale): Promise<string[]> {
  return localeFiles(AGENTS_DIRECTORY, locale)
}

export function docFiles(locale: Locale): Promise<string[]> {
  return localeFiles(DOCS_DIRECTORY, locale)
}

export async function readLocaleFile(root: string, locale: Locale, name: string): Promise<string> {
  return await readFile(path.join(root, locale, name), "utf8")
}

/** Heading levels (outside fenced code) and the fenced-block count. */
export interface MarkdownShape {
  readonly headingLevels: readonly number[]
  readonly fences: number
}

export function markdownShape(markdown: string): MarkdownShape {
  const headingLevels: number[] = []
  let fences = 0
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fences += 1
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^(#{1,6})\s/.exec(line)
    if (heading) headingLevels.push(heading[1].length)
  }
  return { headingLevels, fences }
}

export function cyrillicCount(text: string): number {
  return (text.match(/[\u0400-\u04FF]/g) ?? []).length
}

/** Pre-rename identifiers the shipping surface must never carry again. */
export function forbiddenIdMatches(text: string): string[] {
  return [
    ...text.matchAll(/\baudit-(?:factcheck|empiric|invariant|arbiter|meta|redteam)\b/g),
    ...text.matchAll(/\baudit[-_](?:validate[-_]report|snapshot|sessions)\b/g),
  ].map((match) => match[0])
}

/** Effective `orch_uni_*` tool ids mentioned in the text. */
export function toolIdSet(text: string): Set<string> {
  return new Set([...text.matchAll(/\borch_uni_[A-Za-z0-9_*]+/g)].map((match) => match[0]))
}

/** Every JSON object in the text that carries a string `schema` field. */
export function promptTemplates(markdown: string): Record<string, unknown>[] {
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

/** Every string value inside a JSON-like structure. */
export function templateStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const item of value) templateStrings(item, out)
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) templateStrings(item, out)
  return out
}

const ENUM_TOKEN = /[A-Za-z][A-Za-z_]*(\s*\|\s*[A-Za-z_]+)+/g

/** Normalized enum token sequences (order- and space-insensitive) in SGR templates. */
export function enumTokens(markdown: string): Set<string> {
  const tokens = new Set<string>()
  for (const template of promptTemplates(markdown)) {
    for (const text of templateStrings(template)) {
      for (const match of text.matchAll(ENUM_TOKEN)) {
        tokens.add(
          match[0]
            .split("|")
            .map((part) => part.trim())
            .join("|"),
        )
      }
    }
  }
  return tokens
}

/**
 * Structural parity of one reference JSON value against its translation.
 * Strings: non-Russian strings must be byte-identical, translated strings must
 * be free of Cyrillic. Everything else must be deep-equal in shape.
 */
export function templateParity(reference: unknown, translated: unknown, where: string): string[] {
  if (typeof reference === "string" || typeof translated === "string") {
    if (typeof reference !== "string" || typeof translated !== "string") {
      return [`${where}: string/non-string mismatch`]
    }
    const issues: string[] = []
    if (cyrillicCount(translated) > 0) {
      issues.push(`${where}: Cyrillic left in string ${JSON.stringify(translated).slice(0, 80)}`)
    }
    if (cyrillicCount(reference) === 0 && translated !== reference) {
      issues.push(`${where}: non-Russian string changed: ${JSON.stringify(reference)} -> ${JSON.stringify(translated)}`)
    }
    return issues
  }
  if (Array.isArray(reference) || Array.isArray(translated)) {
    if (!Array.isArray(reference) || !Array.isArray(translated)) return [`${where}: array/non-array mismatch`]
    if (reference.length !== translated.length) {
      return [`${where}: array length ${reference.length} -> ${translated.length}`]
    }
    return reference.flatMap((item, index) => templateParity(item, translated[index], `${where}[${index}]`))
  }
  if (typeof reference === "object" && reference !== null && typeof translated === "object" && translated !== null) {
    const referenceKeys = Object.keys(reference).sort()
    const translatedKeys = Object.keys(translated).sort()
    if (JSON.stringify(referenceKeys) !== JSON.stringify(translatedKeys)) {
      return [`${where}: keys ${JSON.stringify(referenceKeys)} vs ${JSON.stringify(translatedKeys)}`]
    }
    return referenceKeys.flatMap((key) =>
      templateParity(
        (reference as Record<string, unknown>)[key],
        (translated as Record<string, unknown>)[key],
        `${where}.${key}`,
      ),
    )
  }
  return JSON.stringify(reference) === JSON.stringify(translated) ? [] : [`${where}: value mismatch`]
}

/**
 * Every structural issue that a translation of `reference` must not have.
 * One function for both agent definitions and process documents: documents
 * simply have no frontmatter and no SGR templates, so those checks pass.
 */
export function pairIssues(reference: string, translated: string): string[] {
  const issues: string[] = []

  const shapeReference = markdownShape(reference)
  const shapeTranslated = markdownShape(translated)
  if (JSON.stringify(shapeReference.headingLevels) !== JSON.stringify(shapeTranslated.headingLevels)) {
    issues.push(
      `heading levels differ (src: [${shapeReference.headingLevels}], dst: [${shapeTranslated.headingLevels}])`,
    )
  }
  if (shapeReference.fences !== shapeTranslated.fences) {
    issues.push(`code fences differ (src: ${shapeReference.fences}, dst: ${shapeTranslated.fences})`)
  }

  const cyrillic = cyrillicCount(translated)
  if (cyrillic > 0) issues.push(`Cyrillic left in translation (${cyrillic} chars)`)

  const forbidden = forbiddenIdMatches(translated)
  if (forbidden.length > 0) issues.push(`forbidden ids: ${[...new Set(forbidden)].join(", ")}`)

  const toolsReference = toolIdSet(reference)
  const toolsTranslated = toolIdSet(translated)
  for (const id of toolsReference) if (!toolsTranslated.has(id)) issues.push(`tool id lost: ${id}`)
  for (const id of toolsTranslated) if (!toolsReference.has(id)) issues.push(`unknown tool id added: ${id}`)

  const frontReference = matter(reference).data as Record<string, unknown>
  const frontTranslated = matter(translated).data as Record<string, unknown>
  const keysReference = Object.keys(frontReference)
    .filter((key) => key !== "description")
    .sort()
  const keysTranslated = Object.keys(frontTranslated)
    .filter((key) => key !== "description")
    .sort()
  if (JSON.stringify(keysReference) !== JSON.stringify(keysTranslated)) {
    issues.push(`frontmatter keys differ: [${keysReference}] vs [${keysTranslated}]`)
  }
  for (const key of keysReference) {
    if (JSON.stringify(frontReference[key]) !== JSON.stringify(frontTranslated[key])) {
      issues.push(`frontmatter "${key}" changed`)
    }
  }
  if (Object.keys(frontReference).length > 0) {
    const description = frontTranslated.description
    if (typeof description !== "string" || description.trim() === "") {
      issues.push("missing translated description in frontmatter")
    }
  }

  const templatesReference = promptTemplates(reference)
  const templatesTranslated = promptTemplates(translated)
  if (templatesReference.length !== templatesTranslated.length) {
    issues.push(`SGR templates differ (src: ${templatesReference.length}, dst: ${templatesTranslated.length})`)
  } else {
    for (let index = 0; index < templatesReference.length; index += 1) {
      issues.push(...templateParity(templatesReference[index], templatesTranslated[index], `template[${index}]`))
    }
  }

  const enumsReference = enumTokens(reference)
  const enumsTranslated = enumTokens(translated)
  for (const token of enumsReference) if (!enumsTranslated.has(token)) issues.push(`enum tokens lost: ${token}`)
  for (const token of enumsTranslated) if (!enumsReference.has(token)) issues.push(`enum tokens added: ${token}`)

  return issues
}
