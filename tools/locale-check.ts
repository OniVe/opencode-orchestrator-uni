#!/usr/bin/env bun
/**
 * tools/locale-check.ts — parity checker for kit translations.
 *
 * Usage:
 *   bun tools/locale-check.ts                         # all ru→en pairs (agents + docs)
 *   bun tools/locale-check.ts <src.md> <dst.md> ...   # explicit pairs
 *
 * The contract lives in `test/support/locales.ts` (`pairIssues`) and is
 * enforced by `test/translation.test.ts`; this CLI is the fast feedback loop
 * for translators and editors. In the default (no-argument) mode the file sets
 * are compared both ways: a translated file with no reference sibling is an
 * `orphan translation` failure too, as in the kit's own suite.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { agentFiles, docFiles, pairIssues } from "../test/support/locales"

async function checkPair(srcPath: string, dstPath: string): Promise<{ file: string; issues: string[] }> {
  const src = await readFile(srcPath, "utf8").catch(() => undefined)
  const dst = await readFile(dstPath, "utf8").catch(() => undefined)
  if (src === undefined) return { file: dstPath, issues: [`missing source file: ${srcPath}`] }
  if (dst === undefined) return { file: dstPath, issues: ["missing translation file"] }
  return { file: dstPath, issues: pairIssues(src, dst) }
}

/** Translated files with no reference sibling — the other direction of the pair loop. */
async function orphanTranslations(): Promise<string[]> {
  const orphans: string[] = []
  for (const root of ["agents", "docs"] as const) {
    const reference = new Set(root === "agents" ? await agentFiles("ru") : await docFiles("ru"))
    const translated = root === "agents" ? await agentFiles("en") : await docFiles("en")
    for (const name of translated) if (!reference.has(name)) orphans.push(path.join(root, "en", name))
  }
  return orphans.sort()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const pairs: [string, string][] = []
  let orphans: string[] = []
  if (args.length === 0) {
    for (const name of await agentFiles("ru")) {
      pairs.push([path.join("agents", "ru", name), path.join("agents", "en", name)])
    }
    for (const name of await docFiles("ru")) {
      pairs.push([path.join("docs", "ru", name), path.join("docs", "en", name)])
    }
    orphans = await orphanTranslations()
  } else if (args.length % 2 === 0) {
    for (let index = 0; index < args.length; index += 2) {
      pairs.push([args[index]!, args[index + 1]!])
    }
  } else {
    console.error("usage: bun tools/locale-check.ts [<src.md> <dst.md> ...]")
    process.exit(2)
  }

  let failed = 0
  for (const [src, dst] of pairs) {
    const result = await checkPair(src, dst)
    if (result.issues.length === 0) {
      console.log(`PASS  ${dst}`)
    } else {
      failed += 1
      console.log(`FAIL  ${dst}`)
      for (const issue of result.issues) console.log(`      - ${issue}`)
    }
  }
  for (const orphan of orphans) {
    failed += 1
    console.log(`FAIL  ${orphan}`)
    console.log("      - orphan translation: no reference file")
  }
  const total = pairs.length + orphans.length
  console.log(`\n${total - failed}/${total} ok`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
