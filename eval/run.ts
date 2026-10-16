#!/usr/bin/env bun
/**
 * eval/run.ts — регрессионный стенд аудиторского контура.
 *
 * На каждый (кейс, роль): свежая песочница с артефактами кейса (без ключа дефектов),
 * последовательный запуск живой роли плагина через `opencode run --format json`,
 * разбор SGR-отчёта штатным валидатором (`lib/report-schema.ts`), матчинг находок с
 * ключом кейса (`eval/matcher.ts`) и сохранение машинного результата + человекочитаемого
 * отчёта.
 *
 * Примеры:
 *   bun eval/run.ts --dry
 *   bun eval/run.ts --cases all --tag deepseek-baseline-2026-10-15 --baseline eval/baselines/deepseek-2026-10-15.json
 *   bun eval/run.ts --cases parse-duration --roles empiric --model empiric=deepseek/deepseek-flash
 *
 * База `opencode.db` открывается ТОЛЬКО на чтение (стоимость/токены сессии).
 */

import { Database } from "bun:sqlite"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { checkReport, selectReportJson, type JsonSchemaNode } from "../lib/report-schema"
import { loadSchemas } from "../lib/tools"
import { type CaseManifest, type MatchResult } from "./matcher"
import { deriveMetrics } from "./derive"
import { mdTable, renderRunReport, runTableRows, type ReportComparison, type ReportSummary } from "./report"

const EVAL_DIR = import.meta.dir
const CASES_DIR = path.join(EVAL_DIR, "cases")
const RESULTS_DIR = path.join(EVAL_DIR, "results")
const DB_PATH = path.join(homedir(), ".local", "share", "opencode", "opencode.db")
const DEFAULT_MODEL = "deepseek/deepseek-flash"
const DEFAULT_LIMIT_USD = 0.3
const RUN_TIMEOUT_MS = 12 * 60 * 1000

/**
 * Бинарь `opencode` для спавна.
 *
 * На Windows `Bun.spawn` отказывается передавать аргумент с символами cmd.exe
 * (`, (`, `)`, `"`, переводы строк — а бриф многострочный) в `.cmd`-обёртку npm.
 * Поэтому ищем настоящий `opencode.exe`; `EVAL_OPENCODE_BIN` — переопределение
 * (используется в тестах стенда и на нестандартных установках).
 */
function resolveOpencodeBin(): string {
  const override = process.env.EVAL_OPENCODE_BIN
  if (override) return override

  const isExe = (candidate: string): boolean =>
    candidate.toLowerCase().endsWith(".exe") && existsSync(candidate)

  const fromShim = (shim: string): string | undefined => {
    const dir = path.dirname(shim)
    const bundled = path.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    if (isExe(bundled)) return bundled
    if (/\.(cmd|bat)$/i.test(shim)) {
      try {
        const text = readFileSync(shim, "utf8").replace(/%dp0%/gi, dir)
        for (const match of text.matchAll(/"?([^"\r\n]*?\.exe)"?/g)) {
          const candidate = match[1]?.trim()
          if (candidate && isExe(candidate)) return candidate
        }
      } catch {
        // обёртку прочитать не удалось — пробуем путь по умолчанию ниже
      }
    }
    return undefined
  }

  const found = Bun.which("opencode")
  if (found) {
    if (isExe(found)) return found
    const resolved = fromShim(found)
    if (resolved) return resolved
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const direct = path.join(dir, "opencode.exe")
    if (isExe(direct)) return direct
    const nested = path.join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    if (isExe(nested)) return nested
  }
  return found ?? "opencode"
}

const OPENCODE_BIN = resolveOpencodeBin()

interface Options {
  cases: string[]
  roles: string[]
  models: Map<string, string>
  limitUsd: number
  tag: string
  dry: boolean
  baseline?: string
}

function usage(): never {
  console.log(
    [
      "bun eval/run.ts [options]",
      "  --cases <ids|all>              кейсы через запятую (по умолчанию all)",
      "  --roles <r1,r2>                роли через запятую (по умолчанию empiric,invariant)",
      "  --model <role>=<provider/model> переопределить модель роли (можно несколько раз)",
      "  --limit-usd <n>                стоп-предохранитель по суммарной стоимости (по умолчанию 0.30)",
      "  --tag <name>                   метка прогона",
      "  --baseline <path>              сохранить (файла нет) или сравнить (файл есть) JSON-итог",
      "  --dry                          напечатать план и выйти",
    ].join("\n"),
  )
  process.exit(1)
}

function parseArgs(argv: string[]): Options {
  const models = new Map<string, string>()
  const options: Options = {
    cases: ["all"],
    roles: ["empiric", "invariant"],
    models,
    limitUsd: DEFAULT_LIMIT_USD,
    tag: "",
    dry: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) {
        console.error(`eval/run.ts: ${arg} требует значение`)
        usage()
      }
      i += 1
      return value
    }
    switch (arg) {
      case "--cases":
        options.cases = next().split(",").map((s) => s.trim()).filter(Boolean)
        break
      case "--roles":
        options.roles = next().split(",").map((s) => s.trim()).filter(Boolean)
        break
      case "--model": {
        const value = next()
        const eq = value.indexOf("=")
        if (eq <= 0) {
          console.error(`eval/run.ts: --model ожидает <role>=<provider/model>, получено "${value}"`)
          usage()
        }
        models.set(value.slice(0, eq), value.slice(eq + 1))
        break
      }
      case "--limit-usd": {
        const value = Number(next())
        if (!Number.isFinite(value) || value <= 0) {
          console.error(`eval/run.ts: --limit-usd ожидает положительное число`)
          usage()
        }
        options.limitUsd = value
        break
      }
      case "--tag":
        options.tag = next()
        break
      case "--baseline":
        options.baseline = next()
        break
      case "--dry":
        options.dry = true
        break
      default:
        console.error(`eval/run.ts: неизвестный аргумент "${arg}"`)
        usage()
    }
  }
  return options
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

async function loadManifests(): Promise<Map<string, CaseManifest>> {
  const { readdir } = await import("node:fs/promises")
  const entries = await readdir(CASES_DIR, { withFileTypes: true })
  const manifests = new Map<string, CaseManifest>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(CASES_DIR, entry.name, "manifest.json")
    if (!existsSync(file)) continue
    const manifest = JSON.parse(await readFile(file, "utf8")) as CaseManifest
    manifests.set(manifest.id, manifest)
  }
  return manifests
}

function modelFor(options: Options, role: string): string {
  return options.models.get(role) ?? options.models.get("*") ?? DEFAULT_MODEL
}

interface RunRecord {
  case: string
  role: string
  model: string
  sandbox: string
  sessionID: string | null
  startedAt: string
  durationMs: number
  timedOut: boolean
  exitCode: number | null
  costUsd: number | null
  tokens: { input: number; output: number; cacheRead: number } | null
  reportValid: boolean
  reportSchema: string | null
  validationCode: string | null
  validationErrors: string[]
  warnings: string[]
  findings: number
  recall: number
  recallMajor: number
  matched: string[]
  missed: string[]
  missedMajor: string[]
  detail: MatchResult["details"]
  unmatched: { id: string; severity: string; text: string }[]
  stdoutPath: string | null
  reportPath: string | null
  error: string | null
}

interface RunTotals {
  runs: number
  costUsd: number
  tokensInput: number
  tokensOutput: number
  validReports: number
  budgetLimitUsd: number
  budgetExceeded: boolean
}

async function copySandbox(manifest: CaseManifest, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const file of manifest.files) {
    await cp(path.join(CASES_DIR, manifest.id, file.path), path.join(dir, file.path))
  }
}

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

async function runOpencode(dir: string, role: string, model: string, prompt: string): Promise<SpawnResult> {
  const started = Date.now()
  const proc = Bun.spawn(
    [OPENCODE_BIN, "run", "--agent", role, "-m", model, "--format", "json", "--title", `eval ${role}`, prompt],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      // `cwd` задаёт рабочий каталог процесса, но OpenCode определяет локацию сессии
      // по `PWD`; без этой переменной агент попадает в каталог сервиса (репозиторий),
      // а не в песочницу.
      env: { ...process.env, PWD: dir },
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // процесс уже завершился
    }
  }, RUN_TIMEOUT_MS)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)
  return { stdout, stderr, exitCode, timedOut, durationMs: Date.now() - started }
}

interface SessionStats {
  costUsd: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
}

function readSessionStats(db: Database, sessionID: string): SessionStats | null {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = db
        .query<{ cost: number; tokens_input: number; tokens_output: number; tokens_cache_read: number }, [string]>(
          "SELECT cost, tokens_input, tokens_output, tokens_cache_read FROM session_v2 WHERE id = ?",
        )
        .get(sessionID)
      if (row && (row.cost > 0 || row.tokens_input > 0 || row.tokens_output > 0)) {
        return {
          costUsd: row.cost,
          tokensInput: row.tokens_input,
          tokensOutput: row.tokens_output,
          tokensCacheRead: row.tokens_cache_read,
        }
      }
    } catch {
      // база занята/недоступна — повторим
    }
    Bun.sleepSync(1500)
  }
  return null
}

function parseEventStream(stdout: string): {
  sessionID: string | null
  text: string
  errors: string[]
  events: number
} {
  let sessionID: string | null = null
  const texts: string[] = []
  const errors: string[] = []
  let events = 0
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    events += 1
    if (sessionID === null && typeof event.sessionID === "string" && event.sessionID) sessionID = event.sessionID
    if (event.type === "text") {
      const part = event.part as Record<string, unknown> | undefined
      if (part && typeof part.text === "string") texts.push(part.text)
    }
    if (event.type === "error") {
      const error = event.error as Record<string, unknown> | undefined
      errors.push(typeof error?.message === "string" ? error.message : JSON.stringify(event.error))
    }
  }
  return { sessionID, text: texts.join("\n").trim(), errors, events }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const manifests = await loadManifests()
  const caseIds = options.cases.includes("all") ? [...manifests.keys()] : options.cases
  for (const id of caseIds) {
    if (!manifests.has(id)) {
      console.error(`eval/run.ts: неизвестный кейс "${id}" (есть: ${[...manifests.keys()].join(", ")})`)
      process.exit(1)
    }
  }

  const ts = timestamp()
  const runRoot = path.join(process.env.TEMP ?? process.env.TMP ?? path.join(homedir(), "AppData", "Local", "Temp"), "opencode", "eval-runs", ts)
  const tag = options.tag || `run-${ts}`

  console.log(`eval/run.ts — стенд аудиторского контура`)
  console.log(`  бинарь:     ${OPENCODE_BIN}`)
  console.log(`  тег:        ${tag}`)
  console.log(`  кейсы:      ${caseIds.join(", ")}`)
  console.log(`  роли:       ${options.roles.join(", ")}`)
  console.log(`  модели:     ${options.roles.map((r) => `${r}=${modelFor(options, r)}`).join(", ")}`)
  console.log(`  лимит:      $${options.limitUsd}`)
  console.log(`  песочницы:  ${runRoot}`)
  console.log(`  результатов: ${path.join(RESULTS_DIR, ts)}`)
  for (const id of caseIds) {
    const manifest = manifests.get(id)!
    for (const role of options.roles) {
      const sandbox = path.join(runRoot, id, role)
      console.log(`  план: ${id} × ${role} → ${sandbox}`)
    }
  }
  if (options.dry) {
    console.log("dry-run: запуск не выполняется.")
    return
  }

  const resultsDir = path.join(RESULTS_DIR, ts)
  await mkdir(resultsDir, { recursive: true })

  const schemas: Map<string, JsonSchemaNode> = await loadSchemas()
  let db: Database | null = null
  try {
    db = new Database(DB_PATH, { readonly: true })
  } catch (error) {
    console.error(`предупреждение: не удалось открыть ${DB_PATH} readonly (${(error as Error).message}); стоимость не будет собрана`)
  }

  const records: RunRecord[] = []
  const totals: RunTotals = {
    runs: 0,
    costUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    validReports: 0,
    budgetLimitUsd: options.limitUsd,
    budgetExceeded: false,
  }

  const buildSummary = (): Record<string, unknown> => ({
    harness: "eval/run.ts",
    version: 1,
    tag,
    timestamp: ts,
    startedAt: records[0]?.startedAt ?? new Date().toISOString(),
    options: {
      cases: caseIds,
      roles: options.roles,
      models: Object.fromEntries(options.roles.map((r) => [r, modelFor(options, r)])),
      limitUsd: options.limitUsd,
      baseline: options.baseline ?? null,
    },
    totals,
    runs: records,
  })

  const runJsonPath = path.join(resultsDir, "run.json")
  /** Промежуточная запись после каждой ячейки: прогон переживает обрыв стенда. */
  const persist = async (): Promise<void> => {
    await writeFile(runJsonPath, JSON.stringify(buildSummary(), null, 2), "utf8")
  }

  for (const id of caseIds) {
    const manifest = manifests.get(id)!
    for (const role of options.roles) {
      if (totals.costUsd >= options.limitUsd) {
        totals.budgetExceeded = true
        console.warn(`бюджет $${options.limitUsd} исчерпан (потрачено $${totals.costUsd.toFixed(4)}); прогоны остановлены`)
        break
      }
      const model = modelFor(options, role)
      const sandbox = path.join(runRoot, id, role)
      const record: RunRecord = {
        case: id,
        role,
        model,
        sandbox,
        sessionID: null,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        timedOut: false,
        exitCode: null,
        costUsd: null,
        tokens: null,
        reportValid: false,
        reportSchema: null,
        validationCode: null,
        validationErrors: [],
        warnings: [],
        findings: 0,
        recall: 0,
        recallMajor: 0,
        matched: [],
        missed: [],
        missedMajor: [],
        detail: [],
        unmatched: [],
        stdoutPath: null,
        reportPath: null,
        error: null,
      }
      console.log(`\n=== ${id} × ${role} (${model}) ===`)
      try {
        await rm(sandbox, { recursive: true, force: true })
        await copySandbox(manifest, sandbox)
        const brief = await readFile(path.join(sandbox, "case.md"), "utf8")
        const run = await runOpencode(sandbox, role, model, brief)
        record.durationMs = run.durationMs
        record.timedOut = run.timedOut
        record.exitCode = run.exitCode

        const stdoutPath = path.join(resultsDir, `${id}.${role}.raw.jsonl`)
        await writeFile(stdoutPath, run.stdout, "utf8")
        record.stdoutPath = path.basename(stdoutPath)
        if (run.stderr.trim()) console.warn(`  stderr (${run.stderr.length} символов): ${run.stderr.trim().slice(0, 400)}`)

        const parsed = parseEventStream(run.stdout)
        record.sessionID = parsed.sessionID
        if (parsed.errors.length > 0) record.error = `agent error: ${parsed.errors.join(" | ").slice(0, 500)}`

        const reportPath = path.join(resultsDir, `${id}.${role}.md`)
        await writeFile(reportPath, parsed.text, "utf8")
        record.reportPath = path.basename(reportPath)

        const derived = deriveMetrics(manifest, role, parsed.text, schemas)
        Object.assign(record, derived)

        if (db && parsed.sessionID) {
          const stats = readSessionStats(db, parsed.sessionID)
          if (stats) {
            record.costUsd = stats.costUsd
            record.tokens = { input: stats.tokensInput, output: stats.tokensOutput, cacheRead: stats.tokensCacheRead }
            totals.costUsd += stats.costUsd
            totals.tokensInput += stats.tokensInput
            totals.tokensOutput += stats.tokensOutput
          }
        }
        totals.runs += 1
        if (record.reportValid) totals.validReports += 1

        console.log(
          `  session=${record.sessionID ?? "?"} exit=${record.exitCode} ${record.timedOut ? "TIMEOUT " : ""}` +
            `valid=${record.reportValid}${record.validationCode ? ` (${record.validationCode})` : ""} ` +
            `recall=${record.recall} major=${record.recallMajor} ` +
            `cost=${record.costUsd === null ? "?" : "$" + record.costUsd.toFixed(4)} ${Math.round(record.durationMs / 1000)}s`,
        )
        if (record.missed.length > 0) console.log(`  не покрыто: ${record.missed.join(", ")}`)
      } catch (error) {
        record.error = (error as Error).message
        record.durationMs = 0
        console.error(`  ошибка прогона ${id} × ${role}: ${record.error}`)
        totals.runs += 1
      }
      records.push(record)
      await persist()
    }
  }

  let summary = buildSummary() as unknown as ReportSummary

  // Сравнение с базой
  let comparison: ReportComparison | null = null
  if (options.baseline) {
    const baselinePath = path.isAbsolute(options.baseline) ? options.baseline : path.join(EVAL_DIR, "..", options.baseline)
    if (existsSync(baselinePath)) {
      const previous = JSON.parse(await readFile(baselinePath, "utf8")) as ReportSummary
      const index = new Map(previous.runs.map((run) => [`${run.case}::${run.role}`, run]))
      comparison = {
        baseline: options.baseline,
        rows: records.map((run) => {
          const old = index.get(`${run.case}::${run.role}`)
          const flip = (a: boolean, b: boolean): string => (a === b ? (b ? "valid" : "invalid") : `${b ? "valid" : "invalid"} → ${a ? "valid" : "invalid"}`)
          const delta = (a: number, b: number): string => (a === b ? `${a}` : `${b} → ${a}`)
          return {
            case: run.case,
            role: run.role,
            valid: old ? flip(run.reportValid, old.reportValid) : "new",
            recall: old ? delta(run.recall, old.recall) : `${run.recall}`,
            recallMajor: old ? delta(run.recallMajor, old.recallMajor) : `${run.recallMajor}`,
            cost: old ? delta(Number(run.costUsd?.toFixed(4) ?? 0), Number(old.costUsd?.toFixed(4) ?? 0)) : `$${run.costUsd?.toFixed(4) ?? "?"}`,
          }
        }),
      }
    } else {
      await mkdir(path.dirname(baselinePath), { recursive: true })
      await writeFile(baselinePath, JSON.stringify(summary, null, 2), "utf8")
      console.log(`baseline сохранён: ${baselinePath}`)
    }
  }

  summary = { ...summary, comparison }

  // Финальный run.json: машинный итог целиком, включая сравнение с базой (если было).
  await writeFile(runJsonPath, JSON.stringify(summary, null, 2), "utf8")
  await writeFile(path.join(resultsDir, "report.md"), renderRunReport(summary), "utf8")

  const rows = runTableRows(records)
  console.log("\n--- итог ---")
  console.log(mdTable(["кейс", "роль", "валиден", "cost", "время", "recall", "MAJOR", "непокрыто"], rows.map((r) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!, r[6]!, r[7]!])))
  console.log(`\nсуммарно: $${totals.costUsd.toFixed(4)} / лимит $${options.limitUsd}; токены in=${totals.tokensInput} out=${totals.tokensOutput}`)
  console.log(`результаты: ${resultsDir}`)

  db?.close()
}

await main()
