/**
 * context-lint — deterministic, read-only checks for instruction files.
 *
 * The tool is the mechanical half of the `context-lint` agent: it measures
 * budget, finds vague phrases, duplicate lines, broken relative links,
 * placeholders, dates in the first lines and missing structural sections. The
 * agent adds the semantic half (conflicts, testability, SPEC intent).
 *
 * Every check is pure with respect to the workspace: files are only read, and
 * the result is a plain object. The caller (`lib/tools.ts`) turns it into a
 * JSON tool body; failures are typed codes, not thrown errors.
 */
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

export type ContextKind = "agents" | "spec" | "claude" | "other"
export type ContextSeverity = "MAJOR" | "MINOR" | "INFO"
export type ContextFindingKind =
  | "budget"
  | "vague"
  | "duplicate"
  | "broken_link"
  | "missing_section"
  | "conflict"
  | "unverified_command"
  | "other"

export interface ContextFinding {
  readonly id: string
  readonly severity: ContextSeverity
  readonly kind: ContextFindingKind
  readonly evidence: string
  readonly detail: string
  readonly fix: string
}

export interface ContextFileResult {
  readonly path: string
  readonly kind: ContextKind
  readonly lines: number
  readonly words: number
  readonly chars: number
  readonly tokens_est: number
  readonly findings: ContextFinding[]
}

export interface ContextLintResult {
  readonly ok: true
  readonly verdict: "pass" | "fail"
  readonly closing_list: string[]
  readonly files: ContextFileResult[]
  readonly summary: string
}

export interface ContextLintFailure {
  readonly ok: false
  readonly code: "E_INPUT" | "E_NOT_FOUND" | "E_NO_FILES" | "E_IO" | "E_ABORTED"
  readonly message: string
}

export type ContextLintOutcome = ContextLintResult | ContextLintFailure

export interface ContextLintOptions {
  /** Repository root; relative targets are resolved against it. */
  readonly root: string
  /** File or directory to inspect. Defaults to `root`. */
  readonly target?: string
  /** AGENTS/CLAUDE line budget. Default: 200. */
  readonly maxLines?: number
  /** AGENTS/CLAUDE token budget (estimated). Default: 2500. */
  readonly maxTokens?: number
  /** Optional abort signal. */
  readonly signal?: AbortSignal
}

const SKIP = new Set(["node_modules", ".git", ".ae", "dist", "build", "target", "vendor"])
const TARGET_NAME = /^(AGENTS|SPEC|CLAUDE)\.md$/i
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const INLINE_CODE = /`([^`\n]+)`/g
const PLACEHOLDER = /<[^>\n]+>|\b(?:TODO|TBD|FIXME)\b/g
const PATH_EXTENSION = /\.(?:md|mdx|ts|tsx|js|jsx|json|ya?ml|toml|sql|py|rs|go|java|kt|sh|ps1|css|scss|html)$/i

const VAGUE: readonly { readonly term: string; readonly pattern: RegExp }[] = [
  { term: "clean", pattern: /\bclean\b/i },
  { term: "best practices", pattern: /\bbest practices?\b/i },
  { term: "robust", pattern: /\brobust\b/i },
  { term: "properly", pattern: /\bproperly\b/i },
  { term: "carefully", pattern: /\bcarefully\b/i },
  { term: "optimally", pattern: /\boptimally\b/i },
  { term: "аккуратно", pattern: /аккуратн/i },
  { term: "правильно", pattern: /правильн/i },
  { term: "оптимально", pattern: /оптимальн/i },
  { term: "качественно", pattern: /качественн/i },
  { term: "удобно", pattern: /удобн/i },
  { term: "надёжно", pattern: /надёжн/i },
]

function kindOf(file: string): ContextKind {
  const base = path.basename(file).toLowerCase()
  if (base === "agents.md") return "agents"
  if (base === "spec.md") return "spec"
  if (base === "claude.md") return "claude"
  return "other"
}

function relative(root: string, file: string): string {
  const value = path.relative(root, file)
  return (value === "" ? path.basename(file) : value).split(path.sep).join("/")
}

function estimateTokens(text: string): number {
  const chars = [...text].length
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length
  return Math.round(cyrillic / 3 + (chars - cyrillic) / 4)
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || PATH_EXTENSION.test(value)
}

function isCheckableLink(value: string): boolean {
  if (value === "" || /^(?:https?:|mailto:|tel:|data:|#)/i.test(value)) return false
  if (/[\s*<>{}|$]/.test(value) || value.includes("...") || value.includes("…")) return false
  return true
}

async function collectFiles(start: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  const entries = await readdir(start, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(start, entry.name)
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      files.push(...(await collectFiles(full, depth + 1)))
    } else if (entry.isFile() && TARGET_NAME.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

async function resolveTargets(root: string, target: string | undefined): Promise<string[] | ContextLintFailure> {
  const start =
    target === undefined || target === "" ? root : path.isAbsolute(target) ? target : path.resolve(root, target)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(start)
  } catch {
    return { ok: false, code: "E_NOT_FOUND", message: `target not found: ${start}` }
  }
  if (info.isFile()) return [start]
  if (!info.isDirectory())
    return { ok: false, code: "E_INPUT", message: `target is neither a file nor a directory: ${start}` }
  try {
    const files = await collectFiles(start)
    return files.sort()
  } catch (error) {
    return {
      ok: false,
      code: "E_IO",
      message: `cannot read ${start}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function checkBudget(
  file: ContextFileResult,
  findings: Omit<ContextFinding, "id">[],
  maxLines: number,
  maxTokens: number,
): void {
  if (file.kind === "agents" || file.kind === "claude") {
    if (file.lines > maxLines) {
      findings.push({
        severity: "MAJOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.lines} lines > ${maxLines} budget`,
        fix: "Move procedures to docs/skills; keep commands, boundaries and pointers.",
      })
    } else if (file.lines > Math.round(maxLines * 0.75)) {
      findings.push({
        severity: "MINOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.lines} lines is close to the ${maxLines}-line budget`,
        fix: "Cut rules that are not used in most sessions.",
      })
    }
    if (file.tokens_est > maxTokens) {
      findings.push({
        severity: "MAJOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `~${file.tokens_est} tokens > ${maxTokens} budget`,
        fix: "Move long procedures to references; keep only high-signal rules.",
      })
    }
  } else if (file.kind === "spec") {
    if (file.words > 1500) {
      findings.push({
        severity: "MAJOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.words} words > 1500 budget`,
        fix: "Split the spec via a roadmap/spec-of-specs; keep one feature per file.",
      })
    } else if (file.words > 1200) {
      findings.push({
        severity: "MINOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.words} words is close to the 1500-word budget`,
        fix: "Remove restated context and implementation details.",
      })
    }
  }
}

function checkVague(file: ContextFileResult, lines: readonly string[], findings: Omit<ContextFinding, "id">[]): void {
  const seen = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    for (const { term, pattern } of VAGUE) {
      if (pattern.test(lines[index]) && !seen.has(term)) seen.set(term, index + 1)
    }
  }
  if (seen.size >= 3) {
    const [term, line] = [...seen.entries()][0] as [string, number]
    findings.push({
      severity: "MAJOR",
      kind: "vague",
      evidence: `${file.path}:${line}`,
      detail: `${seen.size} distinct vague phrases (${[...seen.keys()].join(", ")}; first: ${term})`,
      fix: "Replace each with a testable rule or delete it.",
    })
    return
  }
  for (const [term, line] of seen) {
    findings.push({
      severity: "MINOR",
      kind: "vague",
      evidence: `${file.path}:${line}`,
      detail: `vague phrase "${term}"`,
      fix: "Make it testable or delete it.",
    })
  }
}

function checkDuplicates(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  const seen = new Map<string, number>()
  let emitted = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length < 40 || line.startsWith("|") || line.startsWith("```")) continue
    const normalized = line.replace(/\s+/g, " ")
    const first = seen.get(normalized)
    if (first === undefined) {
      seen.set(normalized, index + 1)
      continue
    }
    if (emitted >= 10) continue
    emitted += 1
    findings.push({
      severity: "MINOR",
      kind: "duplicate",
      evidence: `${file.path}:${index + 1}`,
      detail: `duplicates line ${first}`,
      fix: "Keep one copy; link to the source instead.",
    })
  }
}

function checkLinks(
  file: ContextFileResult,
  lines: readonly string[],
  root: string,
  absolute: string,
  findings: Omit<ContextFinding, "id">[],
): void {
  const candidates: { readonly target: string; readonly line: number }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(MARKDOWN_LINK)) {
      candidates.push({ target: match[1], line: index + 1 })
    }
    for (const match of lines[index].matchAll(INLINE_CODE)) {
      const target = match[1].trim()
      if (looksLikePath(target)) candidates.push({ target, line: index + 1 })
    }
  }
  const seen = new Set<string>()
  let emitted = 0
  for (const { target, line } of candidates) {
    const key = `${line}:${target}`
    if (seen.has(key) || !isCheckableLink(target)) continue
    seen.add(key)
    const clean = target.split("#")[0]
    if (clean === "") continue
    const resolved = clean.startsWith("/")
      ? path.join(root, clean.slice(1))
      : path.resolve(path.dirname(absolute), clean)
    if (existsSync(resolved)) continue
    if (emitted >= 20) continue
    emitted += 1
    findings.push({
      severity: "MAJOR",
      kind: "broken_link",
      evidence: `${file.path}:${line}`,
      detail: `missing path "${target}"`,
      fix: "Fix the link or remove it.",
    })
  }
}

function checkPlaceholders(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(PLACEHOLDER)
    if (match === null) continue
    findings.push({
      severity: "MAJOR",
      kind: "other",
      evidence: `${file.path}:${index + 1}`,
      detail: `placeholder "${match[0]}"`,
      fix: "Fill it or move it to an explicit open-questions block.",
    })
  }
}

function checkFirstLines(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  const head = lines.slice(0, 3).join("\n")
  if (/(?:19|20)\d{2}-\d{2}-\d{2}|\bv?\d+\.\d+\.\d+\b/.test(head)) {
    findings.push({
      severity: "MINOR",
      kind: "other",
      evidence: `${file.path}:1`,
      detail: "date or version in the first three lines",
      fix: "Move it down; it breaks prefix caching.",
    })
  }
}

function checkSections(file: ContextFileResult, text: string, findings: Omit<ContextFinding, "id">[]): void {
  const lower = text.toLowerCase()
  if (file.kind === "agents" || file.kind === "claude") {
    if (
      !/(^|\n)#{1,6}\s*(commands?|команды)\b/.test(lower) &&
      !/\|\s*(задача|task)\s*\|/.test(lower) &&
      !/\b(?:npm|bun|pnpm|yarn|make|cargo|pytest|go test)\b/.test(lower)
    ) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no commands section",
        fix: "Add install/build/test/lint/run commands.",
      })
    }
    if (!/(never|никогда|ask first|сначала спроси|do not|не редактир|не коммит)/.test(lower)) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no Never / Ask first boundaries",
        fix: "Add secrets, generated files, prod and migration boundaries.",
      })
    }
    if (!/(definition of done|готово|before commit|перед коммит|verify|проверк)/.test(lower)) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no verification / definition of done",
        fix: "Add the check chain that must be green before done.",
      })
    }
  }
  if (file.kind === "spec") {
    if (!/(non-goals?|не-цели|не делаем|вне scope|out of scope)/.test(lower)) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no non-goals",
        fix: "Add 3–7 things the feature deliberately does not do.",
      })
    }
    if (!/(acceptance criteria|критерии приёмки|\bac\d|\bac\b)/.test(lower)) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no acceptance criteria",
        fix: "Add Given/When/Then AC with a test per row.",
      })
    }
    if (!/(requirements?|требования|\br\d+\b)/.test(lower)) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no numbered requirements",
        fix: "Add R1..Rn, one observable behavior per requirement.",
      })
    }
    if (!/(definition of done|\bdod\b|готово)/.test(lower)) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no definition of done",
        fix: "Add a 5–8 item done checklist.",
      })
    }
  }
}

function checkAcRows(file: ContextFileResult, lines: readonly string[], findings: Omit<ContextFinding, "id">[]): void {
  if (file.kind !== "spec") return
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s*\|/.test(line) || !/\bAC\d/i.test(line)) continue
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((_cell, position, all) => !(position === 0 || position === all.length - 1))
    if (cells.length < 6) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:${index + 1}`,
        detail: "AC row lacks columns",
        fix: "Use AC | R | Given | When | Then | Test.",
      })
      continue
    }
    const last = cells.at(-1) ?? ""
    if (!/(test|тест|`)/i.test(last)) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:${index + 1}`,
        detail: "AC row has no test",
        fix: "Add a test name or reference.",
      })
    }
  }
}

function checkAndChains(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  if (file.kind !== "spec") return
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s*[-*]?\s*\*{0,2}R\d+/i.test(line)) continue
    if (/\band\b/i.test(line) || /(?:^|[\s,;:])и(?:[\s,;:]|$)/i.test(line)) {
      findings.push({
        severity: "MINOR",
        kind: "other",
        evidence: `${file.path}:${index + 1}`,
        detail: "requirement joins multiple behaviors",
        fix: "Split into separate R items.",
      })
    }
  }
}

/**
 * Lint one file or the target files under a directory.
 * `ok: true` means the check ran; `verdict: "fail"` is a lint verdict, not an execution error.
 */
export async function lintContext(options: ContextLintOptions): Promise<ContextLintOutcome> {
  const maxLines = options.maxLines ?? 200
  const maxTokens = options.maxTokens ?? 2500
  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    return { ok: false, code: "E_INPUT", message: "maxLines must be a positive number" }
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { ok: false, code: "E_INPUT", message: "maxTokens must be a positive number" }
  }
  if (options.signal?.aborted) return { ok: false, code: "E_ABORTED", message: "context lint aborted" }

  const targets = await resolveTargets(options.root, options.target)
  if (!Array.isArray(targets)) return targets
  if (targets.length === 0) {
    return { ok: false, code: "E_NO_FILES", message: "no AGENTS.md, SPEC.md or CLAUDE.md found in the target" }
  }

  let counter = 0
  const files: ContextFileResult[] = []
  for (const absolute of targets) {
    if (options.signal?.aborted) return { ok: false, code: "E_ABORTED", message: "context lint aborted" }
    let text: string
    try {
      text = await readFile(absolute, "utf8")
    } catch (error) {
      return {
        ok: false,
        code: "E_IO",
        message: `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const lines = text.split(/\r?\n/)
    const chars = [...text].length
    const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length
    const file: ContextFileResult = {
      path: relative(options.root, absolute),
      kind: kindOf(absolute),
      lines: lines.length,
      words,
      chars,
      tokens_est: estimateTokens(text),
      findings: [],
    }
    const raw: Omit<ContextFinding, "id">[] = []
    checkBudget(file, raw, maxLines, maxTokens)
    checkVague(file, lines, raw)
    checkDuplicates(file, lines, raw)
    checkLinks(file, lines, options.root, absolute, raw)
    checkPlaceholders(file, lines, raw)
    checkFirstLines(file, lines, raw)
    checkSections(file, text, raw)
    checkAcRows(file, lines, raw)
    checkAndChains(file, lines, raw)
    const findings: ContextFinding[] = raw.map((finding) => {
      counter += 1
      return { id: `CTX-${String(counter).padStart(3, "0")}`, ...finding }
    })
    files.push({ ...file, findings })
  }

  const all = files.flatMap((file) => file.findings)
  const major = all.filter((finding) => finding.severity === "MAJOR")
  const minor = all.filter((finding) => finding.severity === "MINOR").length
  const info = all.filter((finding) => finding.severity === "INFO").length
  return {
    ok: true,
    verdict: major.length > 0 ? "fail" : "pass",
    closing_list: major.map((finding) => finding.id),
    files,
    summary: `${files.length} file(s); MAJOR ${major.length}, MINOR ${minor}, INFO ${info}`,
  }
}
