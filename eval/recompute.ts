#!/usr/bin/env bun

/**
 * eval/recompute.ts — offline-пере-матчинг сохранённого прогона.
 *
 * Пересчитывает метрики (`reportValid`, `recall`, `missed`, кандидаты) по уже
 * сохранённым текстам отчётов `results/<ts>/<case>.<role>.md` и перезаписывает
 * `run.json` и `report.md`. Живые LLM-вызовы НЕ выполняются: cost/tokens/время/
 * sessionID берутся из прежнего `run.json` как есть.
 *
 * Legacy-прогон (несовместимый с текущими схемами: метки ролей до переименования, либо
 * тексты отчётов объявляют схему, которой нет в `loadSchemas()`) пересчитывается и
 * печатается, но НЕ записывается: иначе валидные метрики заменились бы на all-invalid
 * (`E_UNKNOWN_SCHEMA`).
 *
 * Зачем: после правки сигнатур ключа или кода матчера не нужно (и не нужно платить
 * за) повторный прогон ролей — достаточно пере-матчить сохранённые отчёты.
 *
 * Запуск:
 *   bun eval/recompute.ts                 # последний прогон из eval/results/
 *   bun eval/recompute.ts eval/results/20261015-122730
 */

import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadSchemas } from "../lib/tools"
import { deriveMetrics, schemaForRole } from "./derive"
import type { CaseManifest } from "./matcher"
import { mdTable, type ReportSummary, renderRunReport, runTableRows } from "./report"

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

/**
 * Копия итога прогона с полем `provenance` сразу после `startedAt` — так поле
 * стоит во всех исторических базлайнах (контракт см. `eval/README.md`).
 */
function withProvenance(summary: Record<string, unknown>, provenance: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(summary)) {
    out[key] = value
    if (key === "startedAt") out.provenance = provenance
  }
  if (!("provenance" in out)) out.provenance = provenance
  return out
}

async function main(): Promise<void> {
  const target = Bun.argv[2] ? path.resolve(Bun.argv[2]) : await latestResultsDir()
  const runJsonPath = path.join(target, "run.json")
  const summary = JSON.parse(await readFile(runJsonPath, "utf8")) as ReportSummary & {
    runs: (ReportSummary["runs"][number] & Record<string, unknown>)[]
  }
  const manifests = await loadManifests()
  const schemas = await loadSchemas()

  // Legacy-прогон = прогон, несовместимый с текущими схемами. Признак — любой из двух:
  //   1) у роли нет её схемы: `schemaForRole(role)` отсутствует в `loadSchemas()`
  //      (прогон до переименования ролей);
  //   2) метки ролей уже текущие, но текст отчёта объявляет чужую схему: вычисленный
  //      `reportSchema` ячейки — строка, которой нет в `loadSchemas()`
  //      (label-совместимый legacy).
  // Пересчёт таких ячеек даёт `valid=false (E_UNKNOWN_SCHEMA)` и потерял бы валидные
  // метрики, поэтому при наличии хотя бы одной такой ячейки файлы прогона не пишутся вовсе.
  // Признак (2) известен только после расчёта — он добавляется ниже, в цикле; решение о
  // записи принимается после цикла (до записи ничего не пишется).
  const missingSchemas = new Map<string, string>()
  for (const run of summary.runs) {
    const expected = schemaForRole(run.role)
    if (!schemas.has(expected)) missingSchemas.set(run.role, expected)
  }

  for (const run of summary.runs) {
    const manifest = manifests.get(run.case)
    if (!manifest) {
      console.warn(`пропуск: нет кейса ${run.case}`)
      continue
    }
    const reportFile = run.reportPath ?? `${run.case}.${run.role}.md`
    const reportText = await readFile(path.join(target, reportFile), "utf8")
    Object.assign(run, deriveMetrics(manifest, run.role, reportText, schemas))
    // Признак (2): объявленная отчётом схема отсутствует среди загруженных.
    const declared = run.reportSchema
    if (typeof declared === "string" && !schemas.has(declared)) missingSchemas.set(run.role, declared)
    console.log(
      `${run.case} / ${run.role}: valid=${run.reportValid} recall=${run.recall} major=${run.recallMajor} ` +
        `missed=[${run.missed.join(", ")}] кандидатов=${run.unmatched.length}`,
    )
  }

  const legacy = missingSchemas.size > 0

  // Запись выполняется только для совместимого прогона: у legacy-прогона расчёт
  // печатается (выше), но `run.json`/`report.md`/baseline остаются побайтово как есть.
  if (legacy) {
    console.warn(
      `legacy-прогон: несовместим с текущими схемами — ${[...missingSchemas]
        .map(([role, expected]) => `"${role}" (нет схемы ${expected})`)
        .join(", ")};\n` +
        `  расчёт напечатан выше, но run.json, report.md и baseline НЕ записаны: метрики таких\n` +
        `  ячеек были бы all-invalid (E_UNKNOWN_SCHEMA). Файлы прогона оставлены как есть.`,
    )
  } else {
    await writeFile(runJsonPath, JSON.stringify(summary, null, 2), "utf8")
    await writeFile(path.join(target, "report.md"), renderRunReport(summary), "utf8")
    console.log(`\nобновлено: ${runJsonPath} и ${path.join(target, "report.md")}`)

    // Baseline — та же ревизия прогона; держим его согласованным с results/.
    // Guard: baseline синхронизируется только когда набор ячеек `<кейс>::<роль>`
    // совпадает. Расхождение = baseline перелейблен (переименование ролей) или
    // устарел: перезапись вернула бы старые метки и откатила бы ренейм.
    const baseline = summary.options.baseline
    if (baseline) {
      const baselinePath = path.isAbsolute(baseline) ? baseline : path.join(EVAL_DIR, "..", baseline)
      if (existsSync(baselinePath)) {
        const stored = JSON.parse(await readFile(baselinePath, "utf8")) as Record<string, unknown>
        const cellKeys = (value: unknown): string[] =>
          ((value as { runs?: { case?: unknown; role?: unknown }[] }).runs ?? [])
            .map((run) => `${String(run.case)}::${String(run.role)}`)
            .sort()
        const storedKeys = cellKeys(stored)
        const freshKeys = cellKeys(summary)
        if (storedKeys.join("\n") === freshKeys.join("\n")) {
          // Пометка происхождения не должна теряться при согласованной
          // перезаписи: baseline с `provenance` иначе стал бы неотличим от
          // обычного `run.json` (и от исторического происхождения файла).
          const fresh = summary as unknown as Record<string, unknown>
          const next =
            fresh.provenance === undefined && stored.provenance !== undefined
              ? withProvenance(fresh, stored.provenance)
              : fresh
          if (next !== fresh) console.log("provenance перенесён из прежнего baseline")
          await writeFile(baselinePath, JSON.stringify(next, null, 2), "utf8")
          console.log(`обновлён baseline: ${baselinePath}`)
        } else {
          const onlyStored = storedKeys.filter((key) => !freshKeys.includes(key))
          const onlyFresh = freshKeys.filter((key) => !storedKeys.includes(key))
          console.warn(
            `baseline НЕ обновлён: ${baselinePath}\n` +
              `  метки ячеек разошлись — baseline перелейблен (переименование ролей) или устарел;\n` +
              `  перезапись вернула бы старые метки. Только в baseline: [${onlyStored.join(", ")}];\n` +
              `  только в results: [${onlyFresh.join(", ")}]. run.json и report.md обновлены, baseline оставлен как есть.`,
          )
        }
      }
    }
  }

  console.log(
    "\n" +
      mdTable(
        ["кейс", "роль", "валиден", "cost", "время", "recall", "MAJOR", "непокрыто"],
        runTableRows(summary.runs).map((r) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!, r[6]!, r[7]!]),
      ),
  )
}

await main()
