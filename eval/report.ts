/**
 * report — рендер человекочитаемого отчёта прогона (`results/<ts>/report.md`).
 *
 * Вынесено из `run.ts`, чтобы тем же кодом пользовался offline-пере-матчинг
 * (`recompute.ts`): метрики пересчитываются по сохранённым текстам отчётов без
 * живых LLM-вызовов, и таблица остаётся ровно такой же.
 */

export interface ReportRun {
  readonly case: string
  readonly role: string
  readonly reportValid: boolean
  readonly validationCode: string | null
  readonly costUsd: number | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly recall: number
  readonly recallMajor: number
  readonly missed: readonly string[]
  readonly missedMajor: readonly string[]
  readonly unmatched: readonly unknown[]
  readonly reportPath: string | null
  readonly sessionID: string | null
  readonly error: string | null
}

export interface ReportTotals {
  readonly runs: number
  readonly costUsd: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly validReports: number
  readonly budgetLimitUsd: number
  readonly budgetExceeded: boolean
}

export interface ReportComparison {
  readonly baseline: string
  readonly rows: readonly { readonly case: string; readonly role: string; readonly valid: string; readonly recall: string; readonly recallMajor: string; readonly cost: string }[]
}

export interface ReportSummary {
  readonly tag: string
  readonly timestamp: string
  readonly options: {
    readonly cases: readonly string[]
    readonly roles: readonly string[]
    readonly models: Readonly<Record<string, string>>
    readonly limitUsd: number
    /** Путь к baseline, если прогон сравнивался/сохранялся (иначе null/undefined). */
    readonly baseline?: string | null
  }
  readonly totals: ReportTotals
  readonly runs: readonly ReportRun[]
  readonly comparison?: ReportComparison | null
}

export function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(" | ")} |`
  const sep = `| ${headers.map(() => "---").join(" | ")} |`
  return [head, sep, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n")
}

/** Строка таблицы прогона: кейс, роль, валидность, cost, время, recall, missed, кандидаты. */
export function runTableRows(runs: readonly ReportRun[]): string[][] {
  return runs.map((run) => [
    run.case,
    run.role,
    run.reportValid ? "да" : `нет${run.validationCode ? ` (${run.validationCode})` : ""}`,
    run.costUsd === null ? "?" : `$${run.costUsd.toFixed(4)}`,
    `${Math.round(run.durationMs / 1000)}s${run.timedOut ? " (timeout)" : ""}`,
    `${run.recall}`,
    `${run.recallMajor}`,
    run.missed.length > 0 ? run.missed.join(", ") : "—",
    String(run.unmatched.length),
    run.error ? "да" : "—",
  ])
}

export const RUN_TABLE_HEADERS = [
  "кейс",
  "роль",
  "отчёт валиден",
  "cost",
  "время",
  "recall",
  "recall MAJOR",
  "непокрытые id",
  "кандидатов",
  "ошибка",
] as const

export function renderRunReport(summary: ReportSummary): string {
  const { totals, runs, options } = summary
  const lines = [
    `# Регрессионный прогон аудиторского контура — ${summary.tag}`,
    "",
    `- Время: ${summary.timestamp}`,
    `- Кейсы: ${options.cases.join(", ")}`,
    `- Роли: ${options.roles.join(", ")}`,
    `- Модели: ${options.roles.map((r) => `${r}=${options.models[r] ?? "?"}`).join(", ")}`,
    `- Лимит бюджета: $${options.limitUsd}${totals.budgetExceeded ? " (остановлен по лимиту)" : ""}`,
    `- Потрачено: $${totals.costUsd.toFixed(4)} (токены: in ${totals.tokensInput}, out ${totals.tokensOutput})`,
    `- Валидных отчётов: ${totals.validReports} / ${totals.runs}`,
    "",
    mdTable(RUN_TABLE_HEADERS, runTableRows(runs)),
    "",
    "Метрики: `recall` — доля дефектов ключа, чьи сигнатуры найдены в тексте отчёта; `recall MAJOR` — то же по MAJOR-дефектам.",
    "`непокрытые id` — дефекты ключа, не упомянутые отчётом. `кандидатов` — наблюдения отчёта, не привязанные ни к одному пункту ключа",
    "(материал для ручной разметки, не автоматические ложные срабатывания; `invariants` со статусом `held` в кандидаты не попадают).",
    "",
    "## Ключевые тексты",
    "",
    ...runs.map((run) => `- \`${run.reportPath ?? "—"}\` — ${run.case} / ${run.role}${run.sessionID ? ` (session \`${run.sessionID}\`)` : ""}`),
    "",
  ]
  if (summary.comparison) {
    lines.push(
      "## Сравнение с базой",
      "",
      `База: \`${summary.comparison.baseline}\``,
      "",
      mdTable(
        ["кейс", "роль", "валидность", "recall", "recall MAJOR", "cost"],
        summary.comparison.rows.map((r) => [r.case, r.role, r.valid, r.recall, r.recallMajor, r.cost]),
      ),
      "",
    )
  }
  return lines.join("\n")
}
