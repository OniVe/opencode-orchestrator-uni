/**
 * Translation guard: every non-reference locale must mirror the reference
 * locale (agents + process documents) if translated — same file sets, same
 * markdown shape, same frontmatter, same SGR templates and schema-bound enum
 * tokens, no leftover Cyrillic, no forbidden ids. `pairIssues` is the contract;
 * this suite runs it over every file of every locale pair.
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { AGENTS_DIRECTORY, DOCS_DIRECTORY, type Locale, SUPPORTED_LOCALES } from "../index"
import { agentFiles, docFiles, markdownShape, pairIssues, REFERENCE_LOCALE, readLocaleFile } from "./support/locales"

const OTHER_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== REFERENCE_LOCALE)

const KIT_ROOT = path.resolve(AGENTS_DIRECTORY, "..")

async function fileIssues(root: string, locale: Locale, name: string): Promise<string[]> {
  const reference = await readLocaleFile(root, REFERENCE_LOCALE, name)
  const translated = await readLocaleFile(root, locale, name)
  return pairIssues(reference, translated)
}

describe("locale content parity", () => {
  test("every locale ships the same file sets", async () => {
    const referenceAgents = await agentFiles(REFERENCE_LOCALE)
    const referenceDocs = await docFiles(REFERENCE_LOCALE)
    expect(referenceAgents.length).toBe(8)
    expect(referenceDocs.length).toBe(4)
    for (const locale of OTHER_LOCALES) {
      expect(await agentFiles(locale), `${locale} agent files`).toEqual(referenceAgents)
      expect(await docFiles(locale), `${locale} doc files`).toEqual(referenceDocs)
    }
  })

  for (const locale of OTHER_LOCALES) {
    test(`${REFERENCE_LOCALE} → ${locale}: agent definitions mirror the reference`, async () => {
      for (const name of await agentFiles(REFERENCE_LOCALE)) {
        const issues = await fileIssues(AGENTS_DIRECTORY, locale, name)
        expect(issues, `agents/${locale}/${name}: ${JSON.stringify(issues)}`).toEqual([])
      }
    })
    test(`${REFERENCE_LOCALE} → ${locale}: process documents mirror the reference`, async () => {
      for (const name of await docFiles(REFERENCE_LOCALE)) {
        const issues = await fileIssues(DOCS_DIRECTORY, locale, name)
        expect(issues, `docs/${locale}/${name}: ${JSON.stringify(issues)}`).toEqual([])
      }
    })
  }

  test("README.ru.md mirrors README.md in structure", async () => {
    const english = await readFile(path.join(KIT_ROOT, "README.md"), "utf8")
    const russian = await readFile(path.join(KIT_ROOT, "README.ru.md"), "utf8")
    const shapeEnglish = markdownShape(english)
    const shapeRussian = markdownShape(russian)
    expect(shapeRussian.headingLevels).toEqual(shapeEnglish.headingLevels)
    expect(shapeRussian.fences).toBe(shapeEnglish.fences)
    expect(russian.includes("opencode-orchestrator-uni")).toBe(true)
    expect(russian.includes("orchestrator.uni")).toBe(true)
  })
})
