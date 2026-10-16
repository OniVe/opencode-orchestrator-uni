#!/usr/bin/env bun
/**
 * eval/recompute.ts — offline-пере-матчинг сохранённого прогона.
 *
 * Пересчитывает метрики (`reportValid`, `recall`, `missed`, кандидаты) по уже
 * сохранённым текстам отчётов `results/<ts>/<case>.<role>.md` и перезаписывает
 * `run.json` и `report.md`. Живые LLM-вызовы НЕ выполняются: cost/tokens/время/
 * sessionID берутся из прежнего `run.json` как есть.
 *
 * Зачем: после правки сигнатур ключа или кода матчера не нужно (и не нужно платить
 * за) повторный прогон ролей — достаточно пере-матчить сохранённые отчёты.
 *
 * Запуск:
 *   bun eval/recompute.ts                 # последний прогон из eval/results/
 *   bun eval/recompute.ts eval/results/20261015-122730
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { loadSchemas } from "../lib/tools"
import { deriveMetrics } from "./derive"
import { renderRunReport, runTableRows, mdTable, type ReportSummary } from "./report"
import type { CaseManifest } from "./matcher"

const EVAL_DIR = import.meta.dir
const CASES_DIR = path.join(EVAL_DIR, "cases")
const RESULTS_DIR = path.join(EVAL_DIR, "results")

async function latestResultsDir(): Promise<string> {
  const entries = (await readdir(RESULTS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const last = entries[entries.length - 1]
  if (!last) throw new Error(`в ${RESULTS_DIR} нет ни одного прогона`)
  return path.join(RESULTS_DIR, last)
}

async function loadManifests(): Promise<Map<string, CaseManifest>> {
  const manifests = new Map<string, CaseManifest>()
  for (const entry of await readdir(CASES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(CASES_DIR, entry.name, "manifest.json")
    if (!existsSync(file)) continue
    const manifest = JSON.parse(await readFile(file, "utf8")) as CaseManifest
    manifests.set(manifest.id, manifest)
  }
  return manifests
}

async function main(): Promise<void> {
  const target = Bun.argv[2] ? path.resolve(Bun.argv[2]) : await latestResultsDir()
  const runJsonPath = path.join(target, "run.json")
  const summary = JSON.parse(await readFile(runJsonPath, "utf8")) as ReportSummary & {
    runs: (ReportSummary["runs"][number] & Record<string, unknown>)[]
  }
  const manifests = await loadManifests()
  const schemas = await loadSchemas()

  for (const run of summary.runs) {
    const manifest = manifests.get(run.case)
    if (!manifest) {
      console.warn(`пропуск: нет кейса ${run.case}`)
      continue
    }
    const reportFile = run.reportPath ?? `${run.case}.${run.role}.md`
    const reportText = await readFile(path.join(target, reportFile), "utf8")
    Object.assign(run, deriveMetrics(manifest, run.role, reportText, schemas))
    console.log(
      `${run.case} / ${run.role}: valid=${run.reportValid} recall=${run.recall} major=${run.recallMajor} ` +
        `missed=[${run.missed.join(", ")}] кандидатов=${run.unmatched.length}`,
    )
  }

  await writeFile(runJsonPath, JSON.stringify(summary, null, 2), "utf8")
  await writeFile(path.join(target, "report.md"), renderRunReport(summary), "utf8")
  console.log(`\nобновлено: ${runJsonPath} и ${path.join(target, "report.md")}`)

  // Baseline — та же ревизия прогона; держим его согласованным с results/.
  const baseline = summary.options.baseline
  if (baseline) {
    const baselinePath = path.isAbsolute(baseline) ? baseline : path.join(EVAL_DIR, "..", baseline)
    if (existsSync(baselinePath)) {
      await writeFile(baselinePath, JSON.stringify(summary, null, 2), "utf8")
      console.log(`обновлён baseline: ${baselinePath}`)
    }
  }

  console.log("\n" + mdTable(["кейс", "роль", "валиден", "cost", "время", "recall", "MAJOR", "непокрыто"], runTableRows(summary.runs).map((r) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!, r[6]!, r[7]!])))
}

await main()
