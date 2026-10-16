#!/usr/bin/env bun
/**
 * eval/selfcheck.ts — самопроверка матчера на исторических отчётах.
 *
 * Берёт ключ кейса `csv-split-line` и исторические SGR-отчёты baseline-прогона
 * (`eval/dev-notes/fixtures/csv-baseline-empiric.md`, `...-invariant.md`), гоняет
 * штатный разбор/валидацию и матчинг и записывает протокол в
 * `eval/dev-notes/matcher-selfcheck.md`.
 *
 * Запуск: bun eval/selfcheck.ts
 */

import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { checkReport, selectReportJson, type JsonSchemaNode } from "../lib/report-schema"
import { loadSchemas } from "../lib/tools"
import { matchDefects, normalizeReport, unmatchedFindings, type CaseManifest } from "./matcher"

const EVAL_DIR = import.meta.dir
const MANIFEST = path.join(EVAL_DIR, "cases", "csv-split-line", "manifest.json")
const FIXTURES = path.join(EVAL_DIR, "dev-notes", "fixtures")
const OUT = path.join(EVAL_DIR, "dev-notes", "matcher-selfcheck.md")

const REPORTS: { role: string; file: string }[] = [
  { role: "audit-empiric", file: "csv-baseline-empiric.md" },
  { role: "audit-invariant", file: "csv-baseline-invariant.md" },
]

function mdTable(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n")
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as CaseManifest
  const schemas: Map<string, JsonSchemaNode> = await loadSchemas()
  const lines: string[] = [
    "# Самопроверка матчера (исторические отчёты)",
    "",
    `Ключ: \`cases/${manifest.id}/manifest.json\` (${manifest.defects.map((d) => `${d.id}/${d.severity}`).join(", ")}).`,
    "Источники: `dev-notes/fixtures/csv-baseline-empiric.md`, `dev-notes/fixtures/csv-baseline-invariant.md`",
    "(baseline-прогон того же кейса на `deepseek/deepseek-flash`, сессии `ses_ec55a05dcffe…` / `ses_ec55a05dbffe…`).",
    "",
    "Ожидание: матчер должен вытащить оба MAJOR (K1, K2) у обеих ролей — это калибровка сигнатур",
    "(исторические отчёты — эталон стиля живых ролей).",
    "",
  ]

  const table: string[][] = []
  for (const item of REPORTS) {
    const text = await readFile(path.join(FIXTURES, item.file), "utf8")
    const expected = `${item.role}/v1`
    const validation = checkReport(text, { schemas, expectedSchema: expected })
    const match = matchDefects(normalizeReport(text), manifest.defects)
    const selected = selectReportJson(text)
    const unmatched = selected.ok ? unmatchedFindings(selected.value, manifest.defects) : []
    table.push([
      item.role,
      validation.valid ? "да" : `нет (${validation.code})`,
      match.matched.join(", ") || "—",
      match.missed.join(", ") || "—",
      `${match.recall} (MAJOR ${match.recallMajor})`,
      String(unmatched.length),
    ])
    lines.push(`## ${item.role}`, "", "```", JSON.stringify(
      {
        valid: validation.valid,
        code: validation.code ?? null,
        warnings: validation.warnings,
        matched: match.matched,
        missed: match.missed,
        recall: match.recall,
        recallMajor: match.recallMajor,
        detail: match.details.map((d) => ({ id: d.id, severity: d.severity, matched: d.matched, hits: d.groups.map((g) => g.hits) })),
      },
      null,
      2,
    ), "```", "")
  }

  lines.splice(10, 0, mdTable(["роль", "отчёт валиден", "найдено", "не найдено", "recall", "кандидатов"], table), "")

  await writeFile(OUT, lines.join("\n"), "utf8")
  console.log(mdTable(["роль", "валиден", "найдено", "не найдено", "recall", "кандидатов"], table))
  console.log(`\nзаписано: ${OUT}`)
}

await main()
