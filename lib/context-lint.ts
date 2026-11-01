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
 *
 * Containment and cost are part of the contract:
 * - links and explicit targets never leave `root` (`E_OUT_OF_ROOT`);
 * - a UNC/backslash/URI target is never handed to `existsSync` (a network path
 *   would block the event loop for the SMB timeout);
 * - reads are capped by `maxFileBytes`, directory expansion by `maxFiles`, and
 *   findings by `maxFindingsPerFile`/`maxTotalFindings` (truncation is reported,
 *   never silent);
 * - line-oriented parsers skip lines longer than `MAX_LINE_LENGTH`, so a minified
 *   bundle pasted into a file cannot make matching quadratic.
 */
import { existsSync } from "node:fs"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
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
  /** True when `maxFindingsPerFile` dropped raw findings of this file. */
  readonly truncated?: boolean
}

export interface ContextLintResult {
  readonly ok: true
  readonly verdict: "pass" | "fail"
  readonly closing_list: string[]
  readonly files: ContextFileResult[]
  readonly summary: string
  /** True when `maxTotalFindings` stopped the scan before every target was read. */
  readonly truncated?: boolean
}

/** Typed refusal codes of `lintContext`. */
export type ContextLintCode =
  | "E_INPUT"
  | "E_NOT_FOUND"
  | "E_NO_FILES"
  | "E_IO"
  | "E_ABORTED"
  | "E_LIMIT_FILE"
  | "E_LIMIT_FILES"
  | "E_OUT_OF_ROOT"

export interface ContextLintFailure {
  readonly ok: false
  readonly code: ContextLintCode
  readonly message: string
  /** Path the refusal refers to (limits, out-of-root). */
  readonly path?: string
  /** Observed size in bytes (`E_LIMIT_FILE`). */
  readonly bytes?: number
  /** Observed number of files (`E_LIMIT_FILES`). */
  readonly files?: number
  /** Limit that fired (`E_LIMIT_FILE`, `E_LIMIT_FILES`). */
  readonly max?: number
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
  /** Largest file that may be read, in bytes. Default: 2_000_000. */
  readonly maxFileBytes?: number
  /** Most files a directory target may expand to. Default: 500. */
  readonly maxFiles?: number
  /** Raw findings kept per file. Default: 100. */
  readonly maxFindingsPerFile?: number
  /** Raw findings kept across the whole scan. Default: 1000. */
  readonly maxTotalFindings?: number
  /** Optional abort signal. */
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_FILE_BYTES = 2_000_000
const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_FINDINGS_PER_FILE = 100
const DEFAULT_MAX_TOTAL_FINDINGS = 1000
/** Lines longer than this are skipped by the link and placeholder parsers. */
const MAX_LINE_LENGTH = 4000
/** Upper bound of a `detail` field that echoes source text. */
const MAX_DETAIL_LENGTH = 120
const MAX_BROKEN_LINKS = 20
const MAX_DUPLICATES = 10

const SKIP = new Set(["node_modules", ".git", ".ae", "dist", "build", "target", "vendor"])
const TARGET_NAME = /^(AGENTS|SPEC|CLAUDE)\.md$/i
/** `](target)` of a Markdown link, including the inner link of a badge. */
const LINK_TARGET = /\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
/** Linear: `<...>` (three or more dots) or a TODO/TBD/FIXME marker. */
const PLACEHOLDER = /<\.{2,}>|\b(?:TODO|TBD|FIXME)\b/g
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const INLINE_CODE = /`[^`\n]*`/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const FENCE_LINE = /^\s*(?:```+|~~~+)/
const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/
const OPEN_QUESTIONS_HEADING = /^#{1,6}\s*(?:open questions|открытые вопросы)(?=$|[\s:.,;—–-])/i

const COMMANDS_HEADING = /^#{1,6}\s*(?:commands?|команды)(?=$|[\s:.,;—–-])/i
const TASK_TABLE_HEADER = /\|\s*(?:задача|task)\s*\|/i
const SHELL_TOOL = /\b(?:npm|bun|pnpm|yarn|make|cargo|pytest|go test)\b/i
const BOUNDARIES = /(never|никогда|ask first|сначала спроси|do not|не редактир|не коммит)/i
const VERIFICATION = /(verification|verify|definition of done|определение готовности|готовност|готово)/i
const REQUIREMENTS_HEADING = /^#{1,6}\s*(?:requirements?|требования)(?=$|[\s:.,;—–-])/im
const REQUIREMENT_LINE = /^\s*[-*]?\s*\*{0,2}R\d+(?!\d)/m
const ACCEPTANCE_HEADING = /^#{1,6}\s*(?:acceptance criteria|критерии при[её]мки)(?=$|[\s:.,;—–-])/im
const AC_ROW_LINE = /^\s*\|\s*AC\d+(?:\.\d+)?\s*\|/im
const DEFINITION_OF_DONE = /(definition of done|\bdod\b|готово)/i

const NON_GOALS_HEADING = /^#{1,6}\s*(?:non-goals?|non goals?|out of scope|не-цели|не цели|не делаем)(?=$|[\s:.,;—–-])/i
const NON_GOALS_INLINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:non-goals?|non goals?|out of scope|не-цели|не цели|не делаем)(?:\*\*)?\s*:\s*(.*)$/i
const NONE_ITEM = /^(?:none|nothing|n\/a|na|нет|никаких|отсутствуют)\s*[.!]?$/i

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

/** Cut a detail that echoes source text; a long secret must not be copied out. */
function clip(value: string): string {
  return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH - 3)}...` : value
}

function estimateTokens(text: string): number {
  const chars = [...text].length
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length
  return Math.round(cyrillic / 3 + (chars - cyrillic) / 4)
}

/** True when `candidate` stays inside `root` (case-insensitive on Windows). */
function isInside(root: string, candidate: string): boolean {
  const from = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)
  const to = process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)
  const inside = path.relative(from, to)
  return inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))
}

/**
 * Normalize a link destination into a local, checkable path.
 * Returns `undefined` for anything that is not a local relative path: URI schemes
 * (`https:`, `ftp:`, `file:`, `ssh:`), protocol-relative `//host/…`, backslash
 * paths and UNC shares (`\\host\share` — touching one would block on SMB),
 * angle-bracketed or whitespace-carrying destinations and ellipses.
 */
function localLinkTarget(raw: string): string | undefined {
  let target = raw.trim()
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim()
  if (target === "") return undefined
  if (target.includes("\\")) return undefined
  if (target.startsWith("//")) return undefined
  if (URI_SCHEME.test(target)) return undefined
  if (/[\s<>{}|$`"']/.test(target)) return undefined
  if (target.includes("...") || target.includes("…")) return undefined
  const withoutAnchor = target.split(/[?#]/)[0]
  if (withoutAnchor === "") return undefined
  try {
    return decodeURIComponent(withoutAnchor)
  } catch {
    return undefined
  }
}

/**
 * Target files under a directory, depth-first, depth ≤ 3. Bare directories are
 * pruned by name and by a `realpath` visited set; a symlink/junction is followed
 * once — a file link to `AGENTS.md` is linted, a directory link is traversed, and
 * a cycle stops at the visited set instead of recursing forever.
 */
async function collectFiles(start: string, depth = 0, visited = new Set<string>()): Promise<string[]> {
  if (depth > 3) return []
  let identity: string
  try {
    identity = await realpath(start)
  } catch {
    identity = path.resolve(start)
  }
  if (visited.has(identity)) return []
  visited.add(identity)
  const entries = await readdir(start, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(start, entry.name)
    if (entry.isSymbolicLink()) {
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(full)
      } catch {
        continue // dangling link
      }
      if (info.isFile()) {
        if (TARGET_NAME.test(entry.name)) files.push(full)
      } else if (info.isDirectory() && !SKIP.has(entry.name)) {
        files.push(...(await collectFiles(full, depth + 1, visited)))
      }
      continue
    }
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      files.push(...(await collectFiles(full, depth + 1, visited)))
    } else if (entry.isFile() && TARGET_NAME.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

async function resolveTargets(
  root: string,
  target: string | undefined,
  maxFiles: number,
): Promise<string[] | ContextLintFailure> {
  const rootAbsolute = path.resolve(root)
  const start =
    target === undefined || target === ""
      ? rootAbsolute
      : path.isAbsolute(target)
        ? path.normalize(target)
        : path.resolve(rootAbsolute, target)
  if (!isInside(rootAbsolute, start)) {
    return {
      ok: false,
      code: "E_OUT_OF_ROOT",
      message: `target is outside the workspace root: ${start}`,
      path: start,
    }
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(start)
  } catch {
    return { ok: false, code: "E_NOT_FOUND", message: `target not found: ${start}` }
  }
  if (info.isFile()) return [start]
  if (!info.isDirectory())
    return { ok: false, code: "E_INPUT", message: `target is neither a file nor a directory: ${start}` }
  let files: string[]
  try {
    files = await collectFiles(start)
  } catch (error) {
    return {
      ok: false,
      code: "E_IO",
      message: `cannot read ${start}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  files.sort()
  if (files.length > maxFiles) {
    return {
      ok: false,
      code: "E_LIMIT_FILES",
      message: `${files.length} files under ${start} exceed the ${maxFiles}-file limit`,
      path: start,
      files: files.length,
      max: maxFiles,
    }
  }
  return files
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
  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (FENCE_LINE.test(raw)) {
      inFence = !inFence
      continue
    }
    // Code samples repeat on purpose: a copy-pasted snippet is not a duplicate rule.
    if (inFence) continue
    const line = raw.trim()
    if (line.length < 40 || line.startsWith("|")) continue
    const normalized = line.replace(/\s+/g, " ")
    const first = seen.get(normalized)
    if (first === undefined) {
      seen.set(normalized, index + 1)
      continue
    }
    if (emitted >= MAX_DUPLICATES) continue
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
    const line = lines[index]
    if (line.length > MAX_LINE_LENGTH) continue
    for (const match of line.matchAll(LINK_TARGET)) {
      const target = localLinkTarget(match[1])
      if (target !== undefined) candidates.push({ target, line: index + 1 })
    }
  }
  const seen = new Set<string>()
  let emitted = 0
  for (const { target, line } of candidates) {
    const key = `${line}:${target}`
    if (seen.has(key)) continue
    seen.add(key)
    const resolved = target.startsWith("/")
      ? path.join(root, target.slice(1))
      : path.resolve(path.dirname(absolute), target)
    // Only local, in-root paths reach `existsSync`: a path outside the workspace
    // is not ours to check, and a network path would block on the SMB timeout.
    if (!isInside(root, resolved)) continue
    if (existsSync(resolved)) continue
    if (emitted >= MAX_BROKEN_LINKS) continue
    emitted += 1
    findings.push({
      severity: "MAJOR",
      kind: "broken_link",
      evidence: `${file.path}:${line}`,
      detail: clip(`missing path "${target}"`),
      fix: "Fix the link or remove it.",
    })
  }
}

function checkPlaceholders(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  let inFence = false
  let openQuestions = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length > MAX_LINE_LENGTH) continue
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      continue
    }
    // Fenced samples and inline code show syntax (`Array<string>`, `<!-- -->`);
    // they are examples, not placeholders of this file.
    if (inFence) continue
    if (HEADING.test(line)) openQuestions = OPEN_QUESTIONS_HEADING.test(line)
    const text = line.replace(INLINE_CODE, "").replace(HTML_COMMENT, "")
    for (const match of text.matchAll(PLACEHOLDER)) {
      const marker = /^(?:TODO|TBD|FIXME)$/i.test(match[0])
      if (marker && openQuestions) continue
      findings.push({
        severity: "MAJOR",
        kind: "other",
        evidence: `${file.path}:${index + 1}`,
        detail: clip(`placeholder "${match[0]}"`),
        fix: "Fill it or move it to an explicit open-questions block.",
      })
      break
    }
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

/** Non-goals of a SPEC: a heading or an inline `Non-goals: …`, with 3–7 list items. */
function countNonGoals(lines: readonly string[]): { readonly present: boolean; readonly count: number } {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (NON_GOALS_HEADING.test(line)) {
      let count = 0
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next]
        if (HEADING.test(candidate)) break
        if (LIST_ITEM.test(candidate)) count += 1
      }
      return { present: true, count }
    }
    const inline = NON_GOALS_INLINE.exec(line)
    if (inline !== null) {
      const rest = (inline[1] ?? "").trim()
      if (rest === "" || NONE_ITEM.test(rest)) return { present: true, count: 0 }
      const items = rest
        .split(/;|,(?![^(]*\))/)
        .map((item) => item.replace(/[.!]+$/, "").trim())
        .filter((item) => item !== "")
      return { present: true, count: items.length }
    }
  }
  return { present: false, count: 0 }
}

/** Cells of one Markdown table row, without the outer pipes. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

interface AcTable {
  /** Column index of the AC id (0 when the table has no dedicated column). */
  readonly ac: number
  /** Column index of the requirement id, or -1. */
  readonly r: number
  /** Column index of the test reference. */
  readonly test: number
  /** Number of header cells; a shorter row is malformed. */
  readonly columns: number
}

/**
 * The AC table, located by its header rather than by row shape: a header with
 * `Test` plus `AC` (or `Given`) and its separator row. Column indices are taken
 * from that header, so an extra `Notes` column does not hide `Test`, and a
 * traceability row (`| R1 | AC1.1 | …`) is never mistaken for an AC row.
 */
function findAcTable(lines: readonly string[]): AcTable | undefined {
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]
    if (!/^\s*\|/.test(header)) continue
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? "")) continue
    const cells = splitRow(header).map((cell) => cell.toLowerCase())
    const test = cells.findIndex((cell) => /\btest\b|\bтест/.test(cell))
    if (test === -1) continue
    const ac = cells.findIndex((cell) => /^ac(?:\s*id)?$/.test(cell))
    const given = cells.some((cell) => /^given\b/.test(cell))
    if (ac === -1 && !given) continue
    const r = cells.findIndex((cell) => /^(?:r|req|requirement)$/.test(cell))
    return { ac: ac === -1 ? 0 : ac, r, test, columns: cells.length }
  }
  return undefined
}

/** Requirement ids declared as `R\d+` list items, with their line numbers. */
function collectRequirements(lines: readonly string[]): Map<string, number> {
  const found = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*[-*]?\s*\*{0,2}(R\d+)(?!\d)/.exec(lines[index])
    if (match === null) continue
    if (!found.has(match[1])) found.set(match[1], index + 1)
  }
  return found
}

function checkSections(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  const text = lines.join("\n")
  if (file.kind === "agents" || file.kind === "claude") {
    if (!lines.some((line) => COMMANDS_HEADING.test(line)) && !TASK_TABLE_HEADER.test(text) && !SHELL_TOOL.test(text)) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no commands section",
        fix: "Add install/build/test/lint/run commands.",
      })
    }
    if (!BOUNDARIES.test(text)) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no Never / Ask first boundaries",
        fix: "Add secrets, generated files, prod and migration boundaries.",
      })
    }
    if (!VERIFICATION.test(text)) {
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
    const nonGoals = countNonGoals(lines)
    if (!nonGoals.present) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no non-goals",
        fix: "Add 3–7 things the feature deliberately does not do.",
      })
    } else if (nonGoals.count < 3 || nonGoals.count > 7) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: `${nonGoals.count} non-goals; expected 3–7 items`,
        fix: "List 3–7 things the feature deliberately does not do.",
      })
    }
    if (!REQUIREMENTS_HEADING.test(text) && !REQUIREMENT_LINE.test(text)) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no numbered requirements",
        fix: "Add R1..Rn, one observable behavior per requirement.",
      })
    }
    if (!ACCEPTANCE_HEADING.test(text) && findAcTable(lines) === undefined && !AC_ROW_LINE.test(text)) {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no acceptance criteria",
        fix: "Add Given/When/Then AC with a test per row.",
      })
    }
    if (!DEFINITION_OF_DONE.test(text)) {
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
  const table = findAcTable(lines)
  if (table === undefined) return
  const requirements = collectRequirements(lines)
  const covered = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s*\|/.test(line)) continue
    const cells = splitRow(line)
    const id = /^AC\d+(?:\.\d+)?$/.exec((cells[table.ac] ?? "").trim())
    if (id === null) continue // header, separator or a traceability row
    if (cells.length < table.columns) {
      findings.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:${index + 1}`,
        detail: "AC row lacks columns",
        fix: "Use AC | R | Given | When | Then | Test.",
      })
    }
    if (table.r !== -1) {
      for (const match of (cells[table.r] ?? "").matchAll(/R\d+/gi)) covered.add(match[0].toUpperCase())
    }
    const test = (cells[table.test] ?? "").trim()
    if (test === "" || test === "-" || test === "—") {
      findings.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:${index + 1}`,
        detail: "AC row has no test",
        fix: "Add a test name or reference.",
      })
    }
  }
  for (const [requirement, line] of requirements) {
    if (covered.has(requirement)) continue
    findings.push({
      severity: "MAJOR",
      kind: "missing_section",
      evidence: `${file.path}:${line}`,
      detail: `${requirement} has no acceptance criterion`,
      fix: "Add an AC row for it or drop the requirement.",
    })
  }
}

function checkAndChains(
  file: ContextFileResult,
  lines: readonly string[],
  findings: Omit<ContextFinding, "id">[],
): void {
  if (file.kind !== "spec") return
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(INLINE_CODE, "")
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

/** BOM out, CRLF/CR in; the trailing newline is not a content line. */
function normalizedLines(text: string): { readonly lines: string[]; readonly body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
  return { lines: body.split("\n"), body: normalized }
}

/**
 * Lint one file or the target files under a directory.
 * `ok: true` means the check ran; `verdict: "fail"` is a lint verdict, not an execution error.
 */
export async function lintContext(options: ContextLintOptions): Promise<ContextLintOutcome> {
  if (typeof options !== "object" || options === null || typeof options.root !== "string") {
    return { ok: false, code: "E_INPUT", message: "root must be a string" }
  }
  if (options.target !== undefined && typeof options.target !== "string") {
    return { ok: false, code: "E_INPUT", message: "target must be a string" }
  }
  const maxLines = options.maxLines ?? 200
  const maxTokens = options.maxTokens ?? 2500
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxFindingsPerFile = options.maxFindingsPerFile ?? DEFAULT_MAX_FINDINGS_PER_FILE
  const maxTotalFindings = options.maxTotalFindings ?? DEFAULT_MAX_TOTAL_FINDINGS
  for (const [name, value] of [
    ["maxLines", maxLines],
    ["maxTokens", maxTokens],
    ["maxFileBytes", maxFileBytes],
    ["maxFiles", maxFiles],
    ["maxFindingsPerFile", maxFindingsPerFile],
    ["maxTotalFindings", maxTotalFindings],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, code: "E_INPUT", message: `${name} must be a positive number` }
    }
  }
  if (options.signal?.aborted) return { ok: false, code: "E_ABORTED", message: "context lint aborted" }

  const root = path.resolve(options.root)
  const targets = await resolveTargets(root, options.target, maxFiles)
  if (!Array.isArray(targets)) return targets
  if (targets.length === 0) {
    return { ok: false, code: "E_NO_FILES", message: "no AGENTS.md, SPEC.md or CLAUDE.md found in the target" }
  }

  let counter = 0
  let remaining = maxTotalFindings
  let totalTruncated = false
  const files: ContextFileResult[] = []
  for (const absolute of targets) {
    if (options.signal?.aborted) return { ok: false, code: "E_ABORTED", message: "context lint aborted" }
    let size: number
    try {
      size = (await stat(absolute)).size
    } catch (error) {
      return {
        ok: false,
        code: "E_IO",
        message: `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // Measure before reading: a multi-megabyte file would be parsed line by line
    // and echoed back through findings, which is the failure this cap prevents.
    if (size > maxFileBytes) {
      return {
        ok: false,
        code: "E_LIMIT_FILE",
        message: `${relative(root, absolute)} is ${size} bytes; limit ${maxFileBytes}`,
        path: relative(root, absolute),
        bytes: size,
        max: maxFileBytes,
      }
    }
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
    const { lines, body } = normalizedLines(text)
    const chars = [...body].length
    const words = body.trim() === "" ? 0 : body.trim().split(/\s+/).length
    const file: ContextFileResult = {
      path: relative(root, absolute),
      kind: kindOf(absolute),
      lines: lines.length,
      words,
      chars,
      tokens_est: estimateTokens(body),
      findings: [],
    }
    const raw: Omit<ContextFinding, "id">[] = []
    checkBudget(file, raw, maxLines, maxTokens)
    checkVague(file, lines, raw)
    checkDuplicates(file, lines, raw)
    checkLinks(file, lines, root, absolute, raw)
    checkPlaceholders(file, lines, raw)
    checkFirstLines(file, lines, raw)
    checkSections(file, lines, raw)
    checkAcRows(file, lines, raw)
    checkAndChains(file, lines, raw)
    let kept = raw
    let fileTruncated = false
    if (raw.length > maxFindingsPerFile) {
      kept = raw.slice(0, maxFindingsPerFile)
      kept.push({
        severity: "INFO",
        kind: "other",
        evidence: `${file.path}:1`,
        detail: `findings truncated at ${maxFindingsPerFile}`,
        fix: "Fix the listed findings first; the rest are shown on the next run.",
      })
      fileTruncated = true
    }
    const findings: ContextFinding[] = []
    for (const finding of kept) {
      if (remaining <= 0) {
        totalTruncated = true
        break
      }
      remaining -= 1
      counter += 1
      findings.push({ id: `CTX-${String(counter).padStart(3, "0")}`, ...finding })
    }
    files.push({ ...file, findings, ...(fileTruncated ? { truncated: true } : {}) })
    if (totalTruncated) break
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
    ...(totalTruncated ? { truncated: true } : {}),
  }
}
