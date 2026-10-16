/**
 * derive — вывод метрик по одному отчёту роли: валидация SGR штатным валидатором и
 * матчинг находок с ключом кейса.
 *
 * Живёт отдельно от `run.ts`, чтобы тот же код использовал offline-пере-матчинг
 * (`recompute.ts`): после правки сигнатур метрики пересчитываются по сохранённым
 * текстам отчётов без живых LLM-вызовов, и обе стороны не расходятся.
 */

import { checkReport, selectReportJson, type JsonSchemaNode } from "../lib/report-schema"
import { matchDefects, normalizeReport, unmatchedFindings, type CaseManifest, type DefectMatch } from "./matcher"

export interface DerivedMetrics {
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
  detail: DefectMatch[]
  unmatched: { id: string; severity: string; text: string }[]
}

/**
 * Схема роли: `audit-empiric` → `audit-empiric/v1`.
 *
 * Роль с префиксом плагина (`uni.audit-empiric`) отображается на ту же схему:
 * префикс до последней точки отбрасывается — контракты отчётов едины для
 * комплектов, а префикс — свойство агента, не отчёта (правится для сравнения
 * uni.*-комплекта с базовым, 2026-10-15).
 */
export function schemaForRole(role: string): string {
  const dot = role.lastIndexOf(".")
  const base = dot === -1 ? role : role.slice(dot + 1)
  return `${base}/v1`
}

export function deriveMetrics(
  manifest: CaseManifest,
  role: string,
  reportText: string,
  schemas: ReadonlyMap<string, JsonSchemaNode>,
): DerivedMetrics {
  const validation = checkReport(reportText, { schemas, expectedSchema: schemaForRole(role) })
  const metrics: DerivedMetrics = {
    reportValid: validation.valid,
    reportSchema: validation.schema ?? null,
    validationCode: validation.code ?? null,
    validationErrors: validation.errors.map((error) => `${error.path}: ${error.message}`),
    warnings: [...validation.warnings],
    findings: 0,
    recall: 0,
    recallMajor: 0,
    matched: [],
    missed: [],
    missedMajor: [],
    detail: [],
    unmatched: [],
  }
  const selected = selectReportJson(reportText)
  if (!selected.ok) return metrics
  const match = matchDefects(normalizeReport(reportText), manifest.defects)
  metrics.recall = match.recall
  metrics.recallMajor = match.recallMajor
  metrics.matched = [...match.matched]
  metrics.missed = [...match.missed]
  metrics.missedMajor = [...match.missedMajor]
  metrics.detail = [...match.details]
  const findings = (selected.value as Record<string, unknown> | null)?.findings
  metrics.findings = Array.isArray(findings) ? findings.length : 0
  metrics.unmatched = unmatchedFindings(selected.value, manifest.defects).map((finding) => ({
    ...finding,
    text: finding.text.slice(0, 400),
  }))
  return metrics
}
