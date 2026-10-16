/**
 * matcher — нормализация текста SGR-отчёта и сопоставление находок с ключом дефектов.
 *
 * Модель ключа (см. `cases/<id>/reference-defects.md` и `manifest.json`):
 *   defect  = { id, severity, signatures: RegExp[][] }
 *   signature group = альтернативы (любая совпавшая → группа найдена);
 *   дефект считается найденным, только если найдены ВСЕ его группы.
 *
 * Текст отчёта нормализуется: нижний регистр, типографские кавычки/тире → ASCII,
 * неразрывные пробелы → пробел, любые пробельные серии → один пробел. Регулярные
 * сигнатуры применяются к нормализованному тексту целиком (сырой вывод модели:
 * резюме + JSON-блок). Это сознательно грубая метрика: она измеряет, упомянула ли
 * роль наблюдаемое поведение дефекта, а не качество формулировки.
 *
 * «Кандидат» (unmatched) — находка отчёта, чей текст не совпал ни с одной группой
 * ни одного дефекта ключа. Это материал для ручной разметки, а не автоматические
 * ложные срабатывания.
 */

export interface DefectKey {
  readonly id: string
  readonly severity: string
  /** Каждая сигнатура — список альтернатив; все сигнатуры обязаны совпасть. */
  readonly signatures: readonly (readonly string[])[]
}

export interface CaseManifest {
  readonly id: string
  readonly title: string
  readonly files: readonly { readonly path: string; readonly role: string; readonly sha256: string }[]
  readonly recovery: {
    readonly method: string
    readonly source: string
    readonly reconstructed: boolean
    readonly note: string
  }
  readonly expected_major: readonly string[]
  readonly defects: readonly DefectKey[]
}

export interface DefectMatch {
  readonly id: string
  readonly severity: string
  readonly matched: boolean
  /** По одной записи на группу сигнатур: какие альтернативы совпали. */
  readonly groups: readonly { readonly patterns: readonly string[]; readonly hits: readonly string[] }[]
}

export interface MatchResult {
  readonly matched: readonly string[]
  readonly missed: readonly string[]
  readonly matchedMajor: readonly string[]
  readonly missedMajor: readonly string[]
  readonly recall: number
  readonly recallMajor: number
  readonly details: readonly DefectMatch[]
}

/** Нормализация: регистр, кавычки, тире, неразрывные пробелы, пробельные серии. */
export function normalizeReport(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u00a0\u2007\u202f\u2009\u200a\u2002\u2003]/g, " ")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb\uff02]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uff0d]/g, "-")
    .replace(/[\u2026]/g, "...")
    .replace(/\s+/g, " ")
    .trim()
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "i")
  } catch {
    return undefined
  }
}

/** Сопоставить нормализованный текст отчёта с ключом дефектов кейса. */
export function matchDefects(normalizedText: string, defects: readonly DefectKey[]): MatchResult {
  const details: DefectMatch[] = []
  for (const defect of defects) {
    const groups = defect.signatures.map((alternatives) => {
      const hits: string[] = []
      for (const pattern of alternatives) {
        const re = safeRegExp(pattern)
        if (re && re.test(normalizedText)) hits.push(pattern)
      }
      return { patterns: [...alternatives], hits }
    })
    details.push({ id: defect.id, severity: defect.severity, matched: groups.every((g) => g.hits.length > 0), groups })
  }
  const bySeverity = (severity: string): string[] => defectIds(defects, severity)
  const matched = details.filter((d) => d.matched).map((d) => d.id)
  const missed = details.filter((d) => !d.matched).map((d) => d.id)
  const majorIds = bySeverity("MAJOR")
  const matchedMajor = matched.filter((id) => majorIds.includes(id))
  const missedMajor = missed.filter((id) => majorIds.includes(id))
  const ratio = (hit: number, total: number): number => (total === 0 ? 1 : round2(hit / total))
  return {
    matched,
    missed,
    matchedMajor,
    missedMajor,
    recall: ratio(matched.length, details.length),
    recallMajor: ratio(matchedMajor.length, majorIds.length),
    details,
  }
}

function defectIds(defects: readonly DefectKey[], severity: string): string[] {
  return defects.filter((d) => d.severity === severity).map((d) => d.id)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Текстовые фрагменты находок отчёта — из любого JSON-подобного объекта, который
 * несёт список находок (`findings`/`invariants`). Используется для списка кандидатов.
 *
 * У `invariants` берутся только `verdict: "violated"`: «held»-инварианты — это
 * подтверждённые свойства, а не находки, и в кандидатах они были бы шумом.
 */
export function collectFindingTexts(report: unknown): { id: string; severity: string; text: string }[] {
  const out: { id: string; severity: string; text: string }[] = []
  if (typeof report !== "object" || report === null) return out
  const record = report as Record<string, unknown>
  for (const key of ["findings", "invariants"]) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue
      const finding = item as Record<string, unknown>
      if (key === "invariants" && finding.verdict === "held") continue
      const text = Object.values(finding)
        .filter((value) => typeof value === "string")
        .join(" \u0001 ")
      out.push({
        id: typeof finding.id === "string" ? finding.id : `${key}:?`,
        severity: typeof finding.severity === "string" ? finding.severity : "-",
        text,
      })
    }
  }
  return out
}

/**
 * Находки, не привязанные к ключу: ни одна группа ни одного дефекта не сработала
 * на тексте самой находки. Совпадение по «сырому» тексту, без нормализации отчёта
 * целиком, — чтобы кандидат отражал именно свою находку.
 */
export function unmatchedFindings(
  report: unknown,
  defects: readonly DefectKey[],
): { id: string; severity: string; text: string }[] {
  const findings = collectFindingTexts(report)
  const out: { id: string; severity: string; text: string }[] = []
  for (const finding of findings) {
    const normalized = normalizeReport(finding.text)
    const anyGroupHit = defects.some((defect) =>
      defect.signatures.some((alternatives) => alternatives.some((pattern) => safeRegExp(pattern)?.test(normalized))),
    )
    if (!anyGroupHit) out.push(finding)
  }
  return out
}
