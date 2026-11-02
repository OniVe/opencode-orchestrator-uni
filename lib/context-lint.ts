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
 * - links and explicit targets never leave `root` (`E_OUT_OF_ROOT`); the
 *   lexical check is a fast path, the authoritative one is `realpath`, so a
 *   symlink/junction pointing outside the root is skipped or refused;
 * - a UNC/backslash/URI target is never handed to `existsSync` (a network path
 *   would block the event loop for the SMB timeout);
 * - reads are capped by `maxFileBytes`, directory expansion by `maxFiles`, and
 *   findings by `maxFindingsPerFile`/`maxTotalFindings` during the scan. A cap
 *   never hides MAJOR silently: above the per-file cap the excess is replaced by
 *   one MAJOR `truncated` finding that stays in `closing_list`; `truncated`
 *   reports every capped list;
 * - line-oriented parsers scan every line, however long: the link and placeholder
 *   regexes are linear, so a minified line cannot make matching quadratic and a
 *   long line cannot hide a broken link or placeholder behind a skip;
 * - code fences, inline code and HTML comments are masked once and every
 *   content check reads the masked lines: a sample is not a rule.
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
  /**
   * True when a cap dropped MINOR/INFO findings of this file or replaced excess
   * MAJOR findings with one MAJOR `truncated` marker (which stays in
   * `closing_list`).
   */
  readonly truncated?: boolean
}

export interface ContextLintResult {
  /** Schema id of this result, so the raw tool output is self-describing. */
  readonly schema: "context-lint/v1"
  readonly ok: true
  readonly verdict: "pass" | "fail"
  readonly closing_list: string[]
  readonly files: ContextFileResult[]
  readonly summary: string
  /**
   * True when a cap dropped findings. Above `maxTotalFindings` MAJOR findings
   * are kept first and the overflow is replaced by one MAJOR `truncated` marker
   * that stays in `closing_list`.
   */
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
  /** SPEC word budget. Default: 1500 (the authoring target; 2000 is the ceiling). */
  readonly maxWords?: number
  /** Largest file that may be read, in bytes. Default: 2_000_000. */
  readonly maxFileBytes?: number
  /** Most files a directory target may expand to. Default: 500. */
  readonly maxFiles?: number
  /** MINOR/INFO findings kept per file and the hard cap for MAJOR. Default: 100. */
  readonly maxFindingsPerFile?: number
  /**
   * Global cap for every finding. MAJOR findings are kept first; when they
   * overflow, `maxTotal` findings plus one MAJOR `truncated` marker are kept.
   * Default: 1000.
   */
  readonly maxTotalFindings?: number
  /** Optional abort signal, checked around reads and inside directory walks. */
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_FILE_BYTES = 2_000_000
const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_FINDINGS_PER_FILE = 100
const DEFAULT_MAX_TOTAL_FINDINGS = 1000
/** Upper bound of a `detail` field that echoes source text. */
const MAX_DETAIL_LENGTH = 120
/**
 * Link candidates collected from one file before the list is truncated; above
 * the cap the file is reported incomplete (MAJOR marker) instead of failing on
 * a merely large link list.
 */
const MAX_LINK_CANDIDATES = 20_000
/** Candidates between abort checks and a macrotask yield. */
const LINK_CHECK_YIELD = 100

const SKIP = new Set(["node_modules", ".git", ".ae", "dist", "build", "target", "vendor"])
const TARGET_NAME = /^(AGENTS|SPEC|CLAUDE)\.md$/i
/** `](target)` of a Markdown link, including the inner link of a badge. */
const LINK_TARGET = /\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
/**
 * Linear: `<...>` (three or more dots) or a TODO/TBD/FIXME marker. A tag such
 * as `<DoD>` or a named slot `<name>` is markup, not a placeholder.
 */
const PLACEHOLDER = /<\.{3,}>|\b(?:TODO|TBD|FIXME)\b/g
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HEADING = /^#{1,6}\s/
const HEADING_LEVEL = /^(#{1,6})\s/
const TABLE_ROW = /^\s*\|/
/** Optional `1.`/`2)` numbering after the `##` marker: `## 4. Requirements`. */
const HEADING_PREFIX = "^#{1,6}\\s*(?:\\d+[.)]\\s*)?"
const OPEN_QUESTIONS_HEADING = new RegExp(`${HEADING_PREFIX}(?:open questions|открытые вопросы)(?=$|[\\s:.,;—–-])`, "i")

const COMMANDS_HEADING = new RegExp(`${HEADING_PREFIX}(?:commands?|команды)(?=$|[\\s:.,;—–-])`, "i")
const TASK_TABLE_HEADER = /\|\s*(?:задача|task)\s*\|/i
const SHELL_TOOL = /\b(?:npm|bun|pnpm|yarn|make|cargo|pytest|go test)\b/i
const BOUNDARIES = /(never|никогда|ask first|сначала спроси|do not|не редактир|не коммит)/i
const VERIFICATION = /(verification|verify|definition of done|определение готовности|готовност|готово|проверк)/i
const DEFINITION_OF_DONE = /(definition of done|\bdod\b|готовност|готово)/i

/**
 * A non-goals heading: `## Non-goals`, `## 2. Goal and non-goals`,
 * `## Non-goals: A; B; C`. The optional group is the inline list after the label.
 */
const NON_GOALS_HEADING =
  /^#{1,6}\s*(?:\d+[.)]\s*)?.*?(?:non-goals?|non goals?|out of scope|не-цели|не цели|не делаем)\s*(?::\s*(.*))?$/i
/** A wrapped or inline `Non-goals:` label. */
const NON_GOALS_INLINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:non-goals?|non goals?|out of scope|не-цели|не цели|не делаем)(?:\*\*)?\s*[::]\s*(?:\*\*)?\s*(.*)$/i
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

/** Thrown by the directory walk when the caller aborted; mapped to `E_ABORTED`. */
class ScanAborted extends Error {
  constructor() {
    super("context lint aborted")
    this.name = "ScanAborted"
  }
}

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

/** `..` or `../x` is outside; `..foo` is a normal in-root name. */
function isInside(root: string, candidate: string): boolean {
  const from = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)
  const to = process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)
  const inside = path.relative(from, to)
  if (inside === "") return true
  if (path.isAbsolute(inside)) return false
  return inside !== ".." && !inside.startsWith(`..${path.sep}`)
}

/** Canonical path of an existing entry; a missing path falls back to the lexical one. */
async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return path.resolve(target)
  }
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
 * Target files under a directory, depth-first, depth ≤ 3. Every entry is
 * resolved through `realpath`; an entry whose real path is outside the real
 * root is skipped, so a junction/symlink cannot pull the scan (or a finding)
 * out of the workspace. The cycle guard also uses real paths: a link to an
 * ancestor stops at the visited set instead of recursing forever.
 */
async function collectFiles(
  start: string,
  realRoot: string,
  signal: AbortSignal | undefined,
  depth = 0,
  visited = new Set<string>(),
): Promise<string[]> {
  if (depth > 3) return []
  if (signal?.aborted) throw new ScanAborted()
  const identity = await canonical(start)
  if (!isInside(realRoot, identity)) return []
  if (visited.has(identity)) return []
  visited.add(identity)
  const entries = await readdir(start, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (signal?.aborted) throw new ScanAborted()
    const full = path.join(start, entry.name)
    if (entry.isSymbolicLink()) {
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(full)
      } catch {
        continue // dangling link
      }
      if (!isInside(realRoot, await canonical(full))) continue
      if (info.isFile()) {
        if (TARGET_NAME.test(entry.name)) files.push(full)
      } else if (info.isDirectory() && !SKIP.has(entry.name)) {
        files.push(...(await collectFiles(full, realRoot, signal, depth + 1, visited)))
      }
      continue
    }
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      if (!isInside(realRoot, await canonical(full))) continue
      files.push(...(await collectFiles(full, realRoot, signal, depth + 1, visited)))
    } else if (entry.isFile() && TARGET_NAME.test(entry.name)) {
      if (!isInside(realRoot, await canonical(full))) continue
      files.push(full)
    }
  }
  return files
}

async function resolveTargets(
  root: string,
  target: string | undefined,
  maxFiles: number,
  realRoot: string,
  signal: AbortSignal | undefined,
): Promise<string[] | ContextLintFailure> {
  const rootAbsolute = path.resolve(root)
  const start =
    target === undefined
      ? rootAbsolute
      : path.isAbsolute(target)
        ? path.normalize(target)
        : path.resolve(rootAbsolute, target)
  // Lexical fast path: a `../` target never reaches the filesystem.
  if (target !== undefined && !isInside(rootAbsolute, start)) {
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
  // Authoritative containment: a symlink/junction may lexically look in-root and
  // still resolve outside it.
  const resolvedStart = await canonical(start)
  if (!isInside(realRoot, resolvedStart)) {
    return {
      ok: false,
      code: "E_OUT_OF_ROOT",
      message: `target resolves outside the workspace root: ${start} -> ${resolvedStart}`,
      path: start,
    }
  }
  if (info.isFile()) return [start]
  if (!info.isDirectory())
    return { ok: false, code: "E_INPUT", message: `target is neither a file nor a directory: ${start}` }
  let files: string[]
  try {
    files = await collectFiles(start, realRoot, signal)
  } catch (error) {
    if (error instanceof ScanAborted || signal?.aborted) {
      return { ok: false, code: "E_ABORTED", message: "context lint aborted" }
    }
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

/** Length of the backtick run that starts at `index`. */
function backtickRun(text: string, index: number): number {
  let run = 1
  while (text[index + run] === "`") run += 1
  return run
}

/**
 * Replace code blocks, `<pre>`/`<code>` spans, indented code and (when
 * `options.inlineCode` is set) inline code and HTML comments with spaces,
 * keeping the line count and every line length. A fence opened with N markers
 * closes only with at least N markers of the same character; a code span
 * opened with a run of N backticks closes only on a run of exactly N, so
 * ``a, b`` is one span. `options.indentedCode` (default `true`) masks 4-space
 * indented code; non-goals counting turns it off to accept its 4-space bullets.
 */
function maskCode(
  lines: readonly string[],
  options: { readonly inlineCode: boolean; readonly indentedCode?: boolean },
): string[] {
  const masked: string[] = []
  let fence: { readonly char: string; readonly length: number } | undefined
  let inComment = false
  let inPre = false
  let inIndented = false
  let previousBlank = true
  for (const line of lines) {
    const blank = line.trim() === ""
    if (fence !== undefined) {
      const close = new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`)
      if (close.test(line)) fence = undefined
      masked.push(" ".repeat(line.length))
      previousBlank = false
      continue
    }
    if (inPre) {
      masked.push(" ".repeat(line.length))
      if (line.toLowerCase().includes("</pre>")) inPre = false
      previousBlank = false
      continue
    }
    if (!inComment) {
      // CommonMark indented code: four spaces (or a tab) after a blank line.
      const indented = options.indentedCode !== false && /^(?: {4,}|\t)/.test(line)
      if (indented && (inIndented || previousBlank)) {
        inIndented = true
        masked.push(" ".repeat(line.length))
        previousBlank = false
        continue
      }
      if (!indented && !blank) inIndented = false
      const open = /^\s*(`{3,}|~{3,})/.exec(line)
      if (open !== null) {
        fence = { char: open[1][0], length: open[1].length }
        masked.push(" ".repeat(line.length))
        previousBlank = false
        continue
      }
      const pre = /<pre\b/i.exec(line)
      if (pre !== null) {
        masked.push(" ".repeat(line.length))
        if (!line.slice(pre.index).toLowerCase().includes("</pre>")) inPre = true
        previousBlank = false
        continue
      }
    }
    let out = ""
    let inlineTicks = 0
    let inCodeTag = false
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]
      if (inComment) {
        if (line.startsWith("-->", index)) {
          out += "   "
          index += 2
          inComment = false
        } else {
          out += " "
        }
        continue
      }
      if (inCodeTag) {
        if (line.slice(index, index + 7).toLowerCase() === "</code>") {
          out += "       "
          index += 6
          inCodeTag = false
        } else {
          out += " "
        }
        continue
      }
      if (inlineTicks > 0) {
        if (character === "`") {
          const run = backtickRun(line, index)
          out += " ".repeat(run)
          index += run - 1
          if (run === inlineTicks) inlineTicks = 0
        } else {
          out += " "
        }
        continue
      }
      if (character === "`" && options.inlineCode) {
        const run = backtickRun(line, index)
        out += " ".repeat(run)
        index += run - 1
        inlineTicks = run
        continue
      }
      if (line.startsWith("<!--", index)) {
        out += "    "
        index += 3
        inComment = true
        continue
      }
      if (options.inlineCode && line.slice(index, index + 6).toLowerCase() === "<code>") {
        out += "      "
        index += 5
        inCodeTag = true
        continue
      }
      out += character
    }
    masked.push(out)
    previousBlank = blank
  }
  return masked
}

/** Fences, `<pre>`, comments and indented code only: AC/R cells keep their text. */
function maskFences(lines: readonly string[]): string[] {
  return maskCode(lines, { inlineCode: false })
}

/** Fences plus inline code and comments: links, vague phrases and placeholders. */
function maskAll(lines: readonly string[]): string[] {
  return maskCode(lines, { inlineCode: true })
}

/**
 * Fences, `<pre>` and comments only: indented code stays visible, so a 4-space
 * bullet under a non-goals label is counted as an item. Inline code keeps its
 * text, like `maskFences`.
 */
function maskSectionBlocks(lines: readonly string[]): string[] {
  return maskCode(lines, { inlineCode: false, indentedCode: false })
}

/** Heading level of a line, or `undefined` when it is not a heading. */
function headingLevel(line: string): number | undefined {
  const match = HEADING_LEVEL.exec(line)
  return match === null ? undefined : match[1].length
}

/**
 * One finding sink per file. Both severities respect `maxFindingsPerFile`; the
 * global `maxTotalFindings` cap is applied after the scan, with MAJOR findings
 * prioritized. When a per-file cap fires, one marker is appended (a MAJOR
 * marker for dropped MAJOR findings, an INFO marker for dropped MINOR/INFO), so
 * the verdict and the closing list still reflect what exists. Checks stop
 * pushing through the sink, so a 300k-line file stays bounded.
 */
interface FindingSink {
  readonly kept: Omit<ContextFinding, "id">[]
  readonly truncated: boolean
  readonly majorDropped: boolean
  readonly minorDropped: boolean
  push(finding: Omit<ContextFinding, "id">): void
}

function createSink(maxFindingsPerFile: number): FindingSink {
  const kept: Omit<ContextFinding, "id">[] = []
  let majors = 0
  let minors = 0
  let majorDropped = false
  let minorDropped = false
  return {
    kept,
    get truncated() {
      return majorDropped || minorDropped
    },
    get majorDropped() {
      return majorDropped
    },
    get minorDropped() {
      return minorDropped
    },
    push(finding) {
      if (finding.severity === "MAJOR") {
        if (majors >= maxFindingsPerFile) {
          majorDropped = true
          return
        }
        majors += 1
        kept.push(finding)
        return
      }
      if (minors >= maxFindingsPerFile) {
        minorDropped = true
        return
      }
      minors += 1
      kept.push(finding)
    },
  }
}

function checkBudget(
  file: ContextFileResult,
  sink: FindingSink,
  maxLines: number,
  maxTokens: number,
  maxWords: number,
): void {
  if (file.kind === "agents" || file.kind === "claude") {
    if (file.lines > maxLines) {
      sink.push({
        severity: "MAJOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.lines} lines > ${maxLines} budget`,
        fix: "Move procedures to docs/skills; keep commands, boundaries and pointers.",
      })
    } else if (file.lines > Math.round(maxLines * 0.75)) {
      sink.push({
        severity: "MINOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.lines} lines is close to the ${maxLines}-line budget`,
        fix: "Cut rules that are not used in most sessions.",
      })
    }
    if (file.tokens_est > maxTokens) {
      sink.push({
        severity: "MAJOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `~${file.tokens_est} tokens > ${maxTokens} budget`,
        fix: "Move long procedures to references; keep only high-signal rules.",
      })
    }
  } else if (file.kind === "spec") {
    if (file.words > maxWords) {
      sink.push({
        severity: "MAJOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.words} words > ${maxWords} budget`,
        fix: "Split the spec via a roadmap/spec-of-specs; keep one feature per file.",
      })
    } else if (file.words > Math.round(maxWords * 0.8)) {
      sink.push({
        severity: "MINOR",
        kind: "budget",
        evidence: `${file.path}:1`,
        detail: `${file.words} words is close to the ${maxWords}-word budget`,
        fix: "Remove restated context and implementation details.",
      })
    }
  }
}

function checkVague(file: ContextFileResult, lines: readonly string[], sink: FindingSink): void {
  const seen = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    for (const { term, pattern } of VAGUE) {
      if (pattern.test(lines[index]) && !seen.has(term)) seen.set(term, index + 1)
    }
  }
  if (seen.size >= 3) {
    const [term, line] = [...seen.entries()][0] as [string, number]
    sink.push({
      severity: "MAJOR",
      kind: "vague",
      evidence: `${file.path}:${line}`,
      detail: `${seen.size} distinct vague phrases (${[...seen.keys()].join(", ")}; first: ${term})`,
      fix: "Replace each with a testable rule or delete it.",
    })
    return
  }
  for (const [term, line] of seen) {
    sink.push({
      severity: "MINOR",
      kind: "vague",
      evidence: `${file.path}:${line}`,
      detail: `vague phrase "${term}"`,
      fix: "Make it testable or delete it.",
    })
  }
}

function checkDuplicates(file: ContextFileResult, masked: readonly string[], sink: FindingSink): void {
  const seen = new Map<string, number>()
  for (let index = 0; index < masked.length; index += 1) {
    // Code samples repeat on purpose: the mask blanks fences, inline code and
    // comments, so a copy-pasted snippet is not a duplicate rule.
    const line = masked[index].trim()
    if (line.length < 40 || line.startsWith("|")) continue
    const normalized = line.replace(/\s+/g, " ")
    const first = seen.get(normalized)
    if (first === undefined) {
      seen.set(normalized, index + 1)
      continue
    }
    // No inner duplicate cap: the finding sink bounds the output, and a cap here
    // would silently hide duplicates.
    sink.push({
      severity: "MINOR",
      kind: "duplicate",
      evidence: `${file.path}:${index + 1}`,
      detail: `duplicates line ${first}`,
      fix: "Keep one copy; link to the source instead.",
    })
  }
}

/**
 * Canonical path of an existing entry, or `undefined` when it does not exist or
 * cannot be resolved. Unlike `canonical`, a failure is not replaced by a
 * lexical guess: the caller must not probe a path whose real parent is unknown.
 */
async function existingRealPath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target)
  } catch {
    return undefined
  }
}

/**
 * Check local relative links. Cost and containment are bounded:
 * - at most `MAX_LINK_CANDIDATES` candidates are collected per file; exceeding
 *   the cap returns `truncated: true` and the caller adds one MAJOR marker (the
 *   unverified remainder must never let the verdict pass);
 * - every `LINK_CHECK_YIELD` candidates the signal is checked and the event
 *   loop is yielded to, so a timer-driven abort can win;
 * - the parent's real path is resolved (and cached) before `existsSync`; an
 *   unknown or out-of-root parent is skipped, so a junction pointing outside
 *   the root is never probed and never reported as a broken link; the real path
 *   of an existing target is cached as well, so 20k anchors to one file cost
 *   one `realpath`;
 * There is no per-file cap on reported broken links: the finding sink and the
 * global cap replace overflow with a MAJOR marker instead of dropping MAJORs.
 */
async function checkLinks(
  file: ContextFileResult,
  lines: readonly string[],
  root: string,
  realRoot: string,
  absolute: string,
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<{ readonly aborted: boolean; readonly truncated: boolean }> {
  const candidates: { readonly target: string; readonly line: number }[] = []
  let candidatesTruncated = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const match of line.matchAll(LINK_TARGET)) {
      const target = localLinkTarget(match[1])
      if (target === undefined) continue
      if (candidates.length >= MAX_LINK_CANDIDATES) {
        candidatesTruncated = true
        break
      }
      candidates.push({ target, line: index + 1 })
    }
    if (candidatesTruncated) break
  }
  const parentRealPaths = new Map<string, string | undefined>()
  const targetRealPaths = new Map<string, string | undefined>()
  const probed = new Map<string, boolean>()
  const seen = new Set<string>()
  for (let index = 0; index < candidates.length; index += 1) {
    if (index % LINK_CHECK_YIELD === 0) {
      if (signal?.aborted) return { aborted: true, truncated: candidatesTruncated }
      // A macrotask boundary lets setTimeout-driven abort timers fire; microtasks
      // alone would starve them.
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (signal?.aborted) return { aborted: true, truncated: candidatesTruncated }
    }
    const { target, line } = candidates[index]
    const key = `${line}:${target}`
    if (seen.has(key)) continue
    seen.add(key)
    const resolved = target.startsWith("/")
      ? path.join(root, target.slice(1))
      : path.resolve(path.dirname(absolute), target)
    // Only local, in-root paths reach the filesystem: a path outside the
    // workspace is not ours to check, and a network path would block on SMB.
    if (!isInside(root, resolved)) continue
    const parent = path.dirname(resolved)
    let parentReal = parentRealPaths.get(parent)
    if (!parentRealPaths.has(parent)) {
      parentReal = await existingRealPath(parent)
      if (parentReal === undefined) {
        // A missing suffix cannot contain a junction: resolve the nearest
        // existing ancestor instead and probe only if it is still in-root.
        let ancestor = parent
        while (true) {
          const up = path.dirname(ancestor)
          if (up === ancestor) break
          ancestor = up
          if (!isInside(root, ancestor)) break
          const real = await existingRealPath(ancestor)
          if (real !== undefined) {
            parentReal = real
            break
          }
        }
      }
      parentRealPaths.set(parent, parentReal)
    }
    // Unknown or out-of-root parent: do not probe the child (a junction could
    // otherwise pull `existsSync` outside the workspace).
    if (parentReal === undefined || !isInside(realRoot, parentReal)) continue
    // The probe itself is cached per resolved path: 20k anchors to one file are
    // one probe; a broken target repeated on many lines is still reported per
    // candidate line below.
    let exists = probed.get(resolved)
    if (exists === undefined) {
      exists = existsSync(resolved)
      probed.set(resolved, exists)
    }
    if (exists) {
      // An existing symlink/junction inside the root can still resolve outside
      // it; such a target is not ours to check either. The real path is cached:
      // a list of 20k anchors to one file must not cost 20k `realpath` calls.
      let targetReal = targetRealPaths.get(resolved)
      if (!targetRealPaths.has(resolved)) {
        targetReal = await existingRealPath(resolved)
        targetRealPaths.set(resolved, targetReal)
      }
      if (targetReal === undefined || !isInside(realRoot, targetReal)) continue
      continue
    }
    sink.push({
      severity: "MAJOR",
      kind: "broken_link",
      evidence: `${file.path}:${line}`,
      detail: clip(`missing path "${target}"`),
      fix: "Fix the link or remove it.",
    })
  }
  return { aborted: false, truncated: candidatesTruncated }
}

function checkPlaceholders(
  file: ContextFileResult,
  lines: readonly string[],
  masked: readonly string[],
  sink: FindingSink,
): void {
  let openQuestionsLevel: number | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    // Masked text loses code and comments but keeps headings: a `## Open
    // questions` inside a fence must not open the allowance.
    const line = masked[index] ?? raw
    const level = headingLevel(line)
    if (level !== undefined) {
      if (OPEN_QUESTIONS_HEADING.test(line)) openQuestionsLevel = level
      else if (openQuestionsLevel !== undefined && level <= openQuestionsLevel) openQuestionsLevel = undefined
    }
    const openQuestions = openQuestionsLevel !== undefined
    for (const match of line.matchAll(PLACEHOLDER)) {
      const marker = /^(?:TODO|TBD|FIXME)$/i.test(match[0])
      if (marker && openQuestions) continue
      sink.push({
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

function checkFirstLines(file: ContextFileResult, lines: readonly string[], sink: FindingSink): void {
  const head = lines.slice(0, 3).join("\n")
  if (/(?:19|20)\d{2}-\d{2}-\d{2}|\bv?\d+\.\d+\.\d+\b/.test(head)) {
    sink.push({
      severity: "MINOR",
      kind: "other",
      evidence: `${file.path}:1`,
      detail: "date or version in the first three lines",
      fix: "Move it down; it breaks prefix caching.",
    })
  }
}

/**
 * Split an inline list at the top level only: never inside `(…)`, `[…]`, a
 * backtick span of any width (``…``) or an HTML `<code>…</code>` span.
 * Separators are `;`, `,`, `X and Y` / `X и Y` and a numbered marker
 * (`1.`/`2)`); a comma or semicolon inside brackets or code is content.
 */
function splitTopLevelItems(text: string): string[] {
  const parts: string[] = []
  let current = ""
  let depth = 0
  let ticks = 0
  let inCodeTag = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inCodeTag) {
      if (text.slice(index, index + 7).toLowerCase() === "</code>") {
        current += text.slice(index, index + 7)
        index += 6
        inCodeTag = false
      } else {
        current += character
      }
      continue
    }
    if (ticks > 0) {
      if (character === "`") {
        const run = backtickRun(text, index)
        current += text.slice(index, index + run)
        index += run - 1
        if (run === ticks) ticks = 0
      } else {
        current += character
      }
      continue
    }
    if (character === "`") {
      const run = backtickRun(text, index)
      current += text.slice(index, index + run)
      index += run - 1
      ticks = run
      continue
    }
    if (text.slice(index, index + 6).toLowerCase() === "<code>") {
      current += text.slice(index, index + 6)
      index += 5
      inCodeTag = true
      continue
    }
    if (character === "(" || character === "[") depth += 1
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1)
    const previous = index === 0 ? " " : text[index - 1]
    if (depth === 0 && (character === ";" || character === ",")) {
      parts.push(current)
      current = ""
      continue
    }
    const joined = /^(?:and|и)\s+/i.exec(text.slice(index))
    if (depth === 0 && /\s/.test(previous) && joined !== null) {
      parts.push(current)
      current = ""
      index += joined[0].length - 1
      continue
    }
    // A numbered marker starts an item only at the start or after whitespace;
    // `AC1.1` and `v1.2` stay inside their item.
    const numbered = /^\d+[.)]\s+/.exec(text.slice(index))
    if (depth === 0 && /\s/.test(previous) && numbered !== null) {
      parts.push(current)
      current = ""
      index += numbered[0].length - 1
      continue
    }
    current += character
  }
  parts.push(current)
  return parts
}

/** Split an inline `Non-goals: …` value into top-level items (`;`, `,`, `and`/`и`, `1)`). */
function inlineItems(rest: string): string[] {
  const text = rest.trim()
  if (text === "" || NONE_ITEM.test(text)) return []
  return splitTopLevelItems(text)
    .map((item) =>
      item
        .replace(/^[-*+]\s+/, "")
        .replace(/[.!]+$/, "")
        .trim(),
    )
    .filter((item) => item !== "")
}

/** Separator row of a table: `|---|:--:|`. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line)
}

/**
 * Count top-level items in a section: bullets, numbered items, table rows and
 * paragraphs. A wrapped paragraph is one item (not one per line); a bullet is
 * top-level when it is not nested deeper than the list's base indent, so a
 * 2-space list under a bold label stays top-level. A bullet at 0–4 spaces is
 * an item; anything indented 5+ is code or a continuation, not an item.
 */
function countSectionItems(lines: readonly string[], start: number): number {
  let count = 0
  let bulletIndent: number | undefined
  let paragraphOpen = false
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]
    if (HEADING.test(raw)) break
    const trimmed = raw.trim()
    if (trimmed === "" || isSeparatorRow(raw)) {
      paragraphOpen = false
      continue
    }
    const indent = raw.length - raw.trimStart().length
    if (TABLE_ROW.test(raw)) {
      // The header row of a table is not an item; its data rows are.
      paragraphOpen = false
      if (isSeparatorRow(lines[index + 1] ?? "")) continue
      count += 1
      continue
    }
    if (/^(?:[-*+]|\d+[.)])\s+/.test(raw.trimStart())) {
      paragraphOpen = false
      if (indent > 4) continue // code, not a list item
      bulletIndent = bulletIndent === undefined ? indent : Math.min(bulletIndent, indent)
      // A sub-bullet belongs to its parent item, not to the count.
      if (indent > bulletIndent + 1) continue
      count += 1
      continue
    }
    // An indented non-bullet line is a continuation of the previous item.
    if (indent >= 2) {
      paragraphOpen = false
      continue
    }
    // Consecutive prose lines are one paragraph, hence one item.
    if (!paragraphOpen) {
      count += 1
      paragraphOpen = true
    }
  }
  return count
}

/**
 * A non-goals section: a heading (numbered too, alone or combined as
 * `Goal and non-goals`), an inline `Non-goals: A; B; C`, or a wrapped label
 * followed by bullets. The count is top-level items, 3–7 by contract; bullets
 * at 0–4 spaces under the label count, deeper indentation and fenced code do not.
 */
function countNonGoals(lines: readonly string[]): { readonly present: boolean; readonly count: number } {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = NON_GOALS_HEADING.exec(line)
    if (heading !== null) {
      const rest = (heading[1] ?? "").trim()
      if (rest !== "") return { present: true, count: inlineItems(rest).length }
      // A combined `Goal and non-goals` section may carry a separate label.
      for (let next = index + 1; next < lines.length; next += 1) {
        if (HEADING.test(lines[next])) break
        const label = NON_GOALS_INLINE.exec(lines[next])
        if (label === null) continue
        const inline = (label[1] ?? "").trim()
        if (inline !== "") return { present: true, count: inlineItems(inline).length }
        return { present: true, count: countSectionItems(lines, next + 1) }
      }
      return { present: true, count: countSectionItems(lines, index + 1) }
    }
    const inline = NON_GOALS_INLINE.exec(line)
    if (inline !== null) {
      const rest = (inline[1] ?? "").trim()
      if (rest !== "") return { present: true, count: inlineItems(rest).length }
      // A wrapped `Non-goals:` label: the bullets below are the items.
      return { present: true, count: countSectionItems(lines, index + 1) }
    }
  }
  return { present: false, count: 0 }
}

/**
 * Cells of one Markdown table row, without the outer pipes. An escaped pipe
 * (`\|`) is cell content, not a separator.
 */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith("|")) text = text.slice(1)
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ""
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === "\\" && text[index + 1] === "|") {
      current += "|"
      index += 1
      continue
    }
    if (character === "|") {
      cells.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}

interface TableBlock {
  readonly start: number
  readonly end: number
  /** Header cells when the block has a separator row; `undefined` when headerless. */
  readonly header: readonly string[] | undefined
  readonly rows: readonly { readonly line: number; readonly cells: readonly string[] }[]
}

/** Every contiguous table block, with its header row (when it has one). */
function tableBlocks(lines: readonly string[]): TableBlock[] {
  const blocks: TableBlock[] = []
  let index = 0
  while (index < lines.length) {
    if (!TABLE_ROW.test(lines[index])) {
      index += 1
      continue
    }
    const start = index
    const collected: { line: number; cells: string[] }[] = []
    while (index < lines.length && TABLE_ROW.test(lines[index])) {
      collected.push({ line: index, cells: splitRow(lines[index]) })
      index += 1
    }
    const hasHeader = collected.length >= 2 && isSeparatorRow(lines[collected[1].line])
    blocks.push({
      start,
      end: index - 1,
      header: hasHeader ? collected[0].cells : undefined,
      rows: hasHeader ? collected.slice(2) : collected,
    })
  }
  return blocks
}

interface AcTable {
  /** Column index of the AC id. */
  readonly ac: number
  /** Column index of the requirement id, or -1. */
  readonly r: number
  /** Column index of the test reference. */
  readonly test: number
  /** Number of header cells; a shorter row is malformed. */
  readonly columns: number
}

const AC_HEADER = /^ac(?:\s*id)?$/i
const AC_HEADER_NUMBERED = /^ac\d+$/i
const AC_ID = /^AC\d+(?:\.\d+)?$/

/** Cell text without surrounding backticks: `` `test_export` `` → `test_export`. */
function cellText(cell: string | undefined): string {
  const trimmed = (cell ?? "").trim()
  const unwrapped = /^`+([\s\S]*?)`+$/.exec(trimmed)
  return (unwrapped === null ? trimmed : unwrapped[1]).trim()
}

/** A Test cell counts as missing when blank, `-` or an em dash. */
function hasTestValue(cell: string | undefined): boolean {
  const value = cellText(cell)
  return value !== "" && value !== "-" && value !== "—"
}

interface AcScan {
  /** Valid AC tables: header has AC, Test and Given/When/Then. */
  readonly tables: readonly { readonly table: AcTable; readonly block: TableBlock }[]
  /** Headed blocks with an AC column but no Test column: a MAJOR, never a pass. */
  readonly withoutTest: readonly { readonly block: TableBlock; readonly r: number }[]
  /** Rows of headerless blocks whose first cell is an AC id. */
  readonly headerless: readonly { readonly line: number; readonly cells: readonly string[] }[]
}

/**
 * Locate AC material by block, not by row shape. An AC table needs a header with
 * an `AC`/`AC1` cell, a `Test`/`Tests` cell and `Given`/`When`/`Then`; a
 * traceability table (`| AC | R | Task | Test |`) is not an AC table. A headed
 * table with AC ids but no Test column is recorded separately, and headerless
 * AC-id rows are collected per block, so a headed traceability table cannot
 * masquerade as headerless acceptance criteria.
 */
function scanAcTables(lines: readonly string[]): AcScan {
  const tables: { table: AcTable; block: TableBlock }[] = []
  const withoutTest: { block: TableBlock; r: number }[] = []
  const headerless: { line: number; cells: readonly string[] }[] = []
  for (const block of tableBlocks(lines)) {
    const header = block.header
    if (header === undefined) {
      for (const row of block.rows) {
        if (AC_ID.exec(cellText(row.cells[0])) !== null) headerless.push({ line: row.line, cells: row.cells })
      }
      continue
    }
    const cells = header.map((cell) => cellText(cell).toLowerCase())
    const ac = cells.findIndex((cell) => AC_HEADER.test(cell) || AC_HEADER_NUMBERED.test(cell))
    if (ac === -1) continue
    const r = cells.findIndex((cell) => /^(?:r|req|requirement|требование)$/.test(cell))
    const test = cells.findIndex((cell) => /\btests?\b|\bтест/.test(cell))
    const scenario = cells.some((cell) => /^(?:given|when|then|дано|когда|тогда)\b/.test(cell))
    if (test === -1) {
      // Given/When/Then without Test is a defective AC table; no scenario and no
      // Test is a traceability table, not acceptance criteria.
      if (scenario) withoutTest.push({ block, r })
      continue
    }
    if (!scenario) continue
    tables.push({ table: { ac, r, test, columns: cells.length }, block })
  }
  return { tables, withoutTest, headerless }
}

/** Lines that belong to AC material: their R cells are not requirement declarations. */
function acSkipLines(scan: AcScan): Set<number> {
  const skip = new Set<number>()
  // A defective AC table (no Test column) still maps R→AC: its R cells must not
  // be read as requirement declarations, or the table would declare its own R.
  for (const { block } of [...scan.tables, ...scan.withoutTest]) {
    for (let index = block.start; index <= block.end; index += 1) skip.add(index)
  }
  for (const row of scan.headerless) skip.add(row.line)
  return skip
}

/**
 * Requirement ids: `R\d+` list lines and R cells of tables outside the AC
 * material. An AC R column maps requirements to criteria; it never declares
 * one, so `## Requirements` with only an AC table is empty.
 */
function collectRequirements(lines: readonly string[], skip: ReadonlySet<number>): Map<string, number> {
  const found = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // Backticks around an id are markup: `` `R1` `` still declares R1.
    const plain = line.replace(/`/g, "")
    const listMatch = /^\s*[-*]?\s*\*{0,2}(R\d+)(?!\d)/.exec(plain)
    if (listMatch !== null) {
      if (!found.has(listMatch[1])) found.set(listMatch[1], index + 1)
      continue
    }
    if (!TABLE_ROW.test(line) || skip.has(index)) continue
    for (const cell of splitRow(line)) {
      const match = /^(R\d+)$/.exec(cellText(cell))
      if (match !== null && !found.has(match[1])) found.set(match[1], index + 1)
    }
  }
  return found
}

/** Headerless AC rows: `AC | R | Given | When | Then | Test` (six cells). */
const HEADERLESS_TEST_COLUMN = 5
const HEADERLESS_COLUMNS = 6

function checkAcRows(file: ContextFileResult, lines: readonly string[], sink: FindingSink): void {
  if (file.kind !== "spec") return
  const scan = scanAcTables(lines)
  const requirements = collectRequirements(lines, acSkipLines(scan))
  const covered = new Set<string>()
  let hasRequirementColumn = false
  let hasHeaderlessR = false
  // A header-only AC table still declares the mapping contract, so R coverage
  // is checked even when the table has no data rows.
  let sawAc = scan.tables.length > 0 || scan.withoutTest.length > 0 || scan.headerless.length > 0
  // A headed table with an AC column and no Test column is a MAJOR on its own;
  // headerless detection must not hide it.
  for (const { block, r } of scan.withoutTest) {
    sink.push({
      severity: "MAJOR",
      kind: "missing_section",
      evidence: `${file.path}:${block.start + 1}`,
      detail: "AC table lacks Test column",
      fix: "Add the Test column; every AC row needs a test name or reference.",
    })
    if (r === -1) continue
    hasRequirementColumn = true
    for (const row of block.rows) {
      for (const match of cellText(row.cells[r]).matchAll(/R\d+/gi)) covered.add(match[0].toUpperCase())
    }
  }
  for (const { table, block } of scan.tables) {
    if (table.r !== -1) hasRequirementColumn = true
    for (const row of block.rows) {
      const id = AC_ID.exec(cellText(row.cells[table.ac]))
      if (id === null) continue // header, separator or a traceability row
      sawAc = true
      if (row.cells.length < table.columns) {
        sink.push({
          severity: "MINOR",
          kind: "missing_section",
          evidence: `${file.path}:${row.line + 1}`,
          detail: "AC row lacks columns",
          fix: "Use AC | R | Given | When | Then | Test.",
        })
      }
      if (table.r !== -1) {
        for (const match of cellText(row.cells[table.r]).matchAll(/R\d+/gi)) covered.add(match[0].toUpperCase())
      }
      if (!hasTestValue(row.cells[table.test])) {
        sink.push({
          severity: "MAJOR",
          kind: "missing_section",
          evidence: `${file.path}:${row.line + 1}`,
          detail: "AC row has no test",
          fix: "Add a test name or reference.",
        })
      }
    }
  }
  // Headerless rows are inspected even when a normal AC table exists: otherwise
  // a malformed row next to a valid table would pass silently.
  let headerless = 0
  for (const row of scan.headerless) {
    const cells = row.cells
    headerless += 1
    sawAc = true
    // The R column of a headerless row still proves coverage.
    const requirement = cellText(cells[1])
    if (/^R\d+$/.test(requirement)) {
      hasHeaderlessR = true
      covered.add(requirement.toUpperCase())
    }
    // A 5-cell row has no Test column at all; that is a missing test, not a pass.
    if (cells.length < HEADERLESS_COLUMNS || !hasTestValue(cells[HEADERLESS_TEST_COLUMN])) {
      sink.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:${row.line + 1}`,
        detail: "AC row has no test",
        fix: "Add a test name or reference.",
      })
    }
  }
  if (headerless > 0) {
    sink.push({
      severity: "MINOR",
      kind: "missing_section",
      evidence: `${file.path}:1`,
      detail: "AC table lacks header",
      fix: "Add the header AC | R | Given | When | Then | Test.",
    })
  }
  if (!sawAc) return
  if (!hasRequirementColumn && !hasHeaderlessR) {
    // Without an R column there is no R→AC mapping: report the structural gap
    // once instead of one false MAJOR per requirement.
    sink.push({
      severity: "MINOR",
      kind: "missing_section",
      evidence: `${file.path}:1`,
      detail: "AC table lacks R column",
      fix: "Add the R column and map every requirement to its AC rows.",
    })
    return
  }
  for (const [requirement, line] of requirements) {
    if (covered.has(requirement)) continue
    sink.push({
      severity: "MAJOR",
      kind: "missing_section",
      evidence: `${file.path}:${line}`,
      detail: `${requirement} has no acceptance criterion`,
      fix: "Add an AC row for it or drop the requirement.",
    })
  }
}

/**
 * Structural section checks. Commands/Boundaries/Verification/Definition of done
 * read the full mask (`masked`): a command or a check that exists only as inline
 * code is a sample, not a rule. Requirements and AC read `fenceMasked`: inline
 * code keeps its text there (`AC1.1`, `R1`). Non-goals read `sectionMasked`,
 * which also keeps 4-space bullets visible: a bullet under the label is an item,
 * not code.
 */
function checkSections(
  file: ContextFileResult,
  fenceMasked: readonly string[],
  sectionMasked: readonly string[],
  masked: readonly string[],
  sink: FindingSink,
): void {
  const text = masked.join("\n")
  if (file.kind === "agents" || file.kind === "claude") {
    if (
      !masked.some((line) => COMMANDS_HEADING.test(line)) &&
      !TASK_TABLE_HEADER.test(text) &&
      !SHELL_TOOL.test(text)
    ) {
      sink.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no commands section",
        fix: "Add install/build/test/lint/run commands.",
      })
    }
    if (!BOUNDARIES.test(text)) {
      sink.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no Never / Ask first boundaries",
        fix: "Add secrets, generated files, prod and migration boundaries.",
      })
    }
    if (!VERIFICATION.test(text)) {
      sink.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no verification / definition of done",
        fix: "Add the check chain that must be green before done.",
      })
    }
  }
  if (file.kind === "spec") {
    const nonGoals = countNonGoals(sectionMasked)
    if (!nonGoals.present) {
      sink.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no non-goals",
        fix: "Add 3–7 things the feature deliberately does not do.",
      })
    } else if (nonGoals.count < 3 || nonGoals.count > 7) {
      sink.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: `${nonGoals.count} non-goals; expected 3–7 items`,
        fix: "List 3–7 things the feature deliberately does not do.",
      })
    }
    const scan = scanAcTables(fenceMasked)
    const requirements = collectRequirements(fenceMasked, acSkipLines(scan))
    // A heading alone is not a requirement set: at least one R line or R table
    // row outside the AC material must exist, otherwise a `## Requirements`
    // stub with an AC table R cell would pass.
    if (requirements.size === 0) {
      sink.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no numbered requirements",
        fix: "Add R1..Rn, one observable behavior per requirement.",
      })
    }
    // Acceptance evidence is block-aware: a valid AC table, a headed AC table
    // that is missing its Test column (reported by `checkAcRows`), or a
    // headerless AC-id row. A headed traceability table is none of these.
    const hasAcceptance = scan.tables.length > 0 || scan.withoutTest.length > 0 || scan.headerless.length > 0
    if (!hasAcceptance) {
      sink.push({
        severity: "MAJOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no acceptance criteria",
        fix: "Add Given/When/Then AC with a test per row.",
      })
    }
    if (!DEFINITION_OF_DONE.test(text)) {
      sink.push({
        severity: "MINOR",
        kind: "missing_section",
        evidence: `${file.path}:1`,
        detail: "no definition of done",
        fix: "Add a 5–8 item done checklist.",
      })
    }
  }
}

/**
 * A top-level `and`/`и` join: never inside `(…)`, `[…]` or a code span. `and`
 * must be a whole word and `и` a separate word, so `Android` and `импорт` do
 * not match.
 */
function topLevelJoin(text: string): boolean {
  let depth = 0
  let ticks = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === "`") {
      const run = backtickRun(text, index)
      ticks = ticks === 0 ? run : run === ticks ? 0 : ticks
      index += run - 1
      continue
    }
    if (ticks > 0) continue
    if (character === "(" || character === "[") {
      depth += 1
      continue
    }
    if (character === ")" || character === "]") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0 || index === 0) continue
    if (!/[\s,;:(]/.test(text[index - 1])) continue
    const rest = text.slice(index)
    if (/^and\b/i.test(rest)) return true
    if (/^и(?=$|[\s,;:.!?—–-])/i.test(rest)) return true
  }
  return false
}

function checkAndChains(file: ContextFileResult, lines: readonly string[], sink: FindingSink): void {
  if (file.kind !== "spec") return
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s*[-*]?\s*\*{0,2}R\d+/i.test(line)) continue
    if (topLevelJoin(line)) {
      sink.push({
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
  if (options.target !== undefined && (typeof options.target !== "string" || options.target.trim() === "")) {
    // The tool rejects `path: ""` as E_INPUT; the library keeps the same contract.
    return { ok: false, code: "E_INPUT", message: "target must be a non-empty string" }
  }
  const maxLines = options.maxLines ?? 200
  const maxTokens = options.maxTokens ?? 2500
  const maxWords = options.maxWords ?? 1500
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxFindingsPerFile = options.maxFindingsPerFile ?? DEFAULT_MAX_FINDINGS_PER_FILE
  const maxTotalFindings = options.maxTotalFindings ?? DEFAULT_MAX_TOTAL_FINDINGS
  for (const [name, value] of [
    ["maxLines", maxLines],
    ["maxTokens", maxTokens],
    ["maxWords", maxWords],
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
  const realRoot = await canonical(root)
  const targets = await resolveTargets(root, options.target, maxFiles, realRoot, options.signal)
  if (!Array.isArray(targets)) return targets
  if (targets.length === 0) {
    return { ok: false, code: "E_NO_FILES", message: "no AGENTS.md, SPEC.md or CLAUDE.md found in the target" }
  }

  interface ScannedFile {
    readonly path: string
    readonly kind: ContextKind
    readonly lines: number
    readonly words: number
    readonly chars: number
    readonly tokens_est: number
    readonly findings: Omit<ContextFinding, "id">[]
    readonly truncated: boolean
  }
  const scanned: ScannedFile[] = []
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
    // The read itself is not abortable here; a caller that aborted while a 2 MB
    // file was being read must still get E_ABORTED rather than a full report.
    if (options.signal?.aborted) return { ok: false, code: "E_ABORTED", message: "context lint aborted" }
    const { lines, body } = normalizedLines(text)
    // Requirements, AC ids and non-goals read the fence mask: inline code keeps
    // its text, so `AC1.1`, `R1` and `test_export` in backticks still parse.
    // Links, vague phrases, placeholders and the structural section checks read
    // the full mask: a command or a check that exists only as inline code is a
    // sample, not a rule.
    const fenceMasked = maskFences(lines)
    const masked = maskAll(lines)
    const sectionMasked = maskSectionBlocks(lines)
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
    const sink = createSink(maxFindingsPerFile)
    checkBudget(file, sink, maxLines, maxTokens, maxWords)
    checkVague(file, masked, sink)
    checkDuplicates(file, masked, sink)
    const links = await checkLinks(file, masked, root, realRoot, absolute, sink, options.signal)
    if (links.aborted || options.signal?.aborted) {
      return { ok: false, code: "E_ABORTED", message: "context lint aborted" }
    }
    checkPlaceholders(file, lines, masked, sink)
    checkFirstLines(file, lines, sink)
    checkSections(file, fenceMasked, sectionMasked, masked, sink)
    checkAcRows(file, fenceMasked, sink)
    checkAndChains(file, masked, sink)
    if (options.signal?.aborted) return { ok: false, code: "E_ABORTED", message: "context lint aborted" }
    // Markers are appended directly after the checks: they never displace a kept
    // finding. The MAJOR marker is itself MAJOR, so it is closed with the rest.
    if (links.truncated) {
      // The unverified remainder must not let the verdict pass: a capped link
      // list is incomplete, and a deterministic rerun is identical.
      sink.kept.push({
        severity: "MAJOR",
        kind: "other",
        evidence: `${file.path}:1`,
        detail: `link candidates truncated at ${MAX_LINK_CANDIDATES}; result incomplete (further links are not checked)`,
        fix: "Split the file or remove generated links so every target is checked.",
      })
    }
    if (sink.majorDropped) {
      sink.kept.push({
        severity: "MAJOR",
        kind: "other",
        evidence: `${file.path}:1`,
        detail: `findings truncated at ${maxFindingsPerFile} MAJOR (further MAJOR findings are not listed)`,
        fix: "Fix the listed findings or increase max_findings/max_total, then rerun; a deterministic rerun with the same caps shows the same prefix.",
      })
    }
    if (sink.minorDropped) {
      sink.kept.push({
        severity: "INFO",
        kind: "other",
        evidence: `${file.path}:1`,
        detail: `findings truncated at ${maxFindingsPerFile} (MAJOR findings are kept)`,
        fix: "Fix the listed findings or increase max_findings/max_total, then rerun; a deterministic rerun with the same caps shows the same prefix.",
      })
    }
    scanned.push({
      ...file,
      findings: sink.kept,
      truncated: sink.truncated || links.truncated,
    })
  }

  // The global cap applies to every finding and prioritizes MAJOR: a pathological
  // scan (500 files × 101 MAJOR) stays bounded, and a dropped MAJOR is replaced
  // by one MAJOR marker that is itself in `closing_list`, never hidden.
  const flat: { readonly fileIndex: number; readonly order: number; readonly finding: Omit<ContextFinding, "id"> }[] =
    []
  for (const [fileIndex, file] of scanned.entries()) {
    for (const [order, finding] of file.findings.entries()) flat.push({ fileIndex, order, finding })
  }
  const truncatedFiles = new Set<number>(scanned.flatMap((file, index) => (file.truncated ? [index] : [])))
  let selected = flat
  let globalTruncated = false
  if (flat.length > maxTotalFindings) {
    globalTruncated = true
    const byPosition = (
      left: { readonly fileIndex: number; readonly order: number },
      right: { readonly fileIndex: number; readonly order: number },
    ): number => left.fileIndex - right.fileIndex || left.order - right.order
    const majors = flat.filter((item) => item.finding.severity === "MAJOR").sort(byPosition)
    const rest = flat.filter((item) => item.finding.severity !== "MAJOR").sort(byPosition)
    const majorOverflow = majors.length > maxTotalFindings
    selected = majorOverflow
      ? majors.slice(0, maxTotalFindings)
      : [...majors, ...rest.slice(0, maxTotalFindings - majors.length)].sort(byPosition)
    const markerFile = selected.length > 0 ? selected[selected.length - 1].fileIndex : 0
    const kept = new Set(selected.map((item) => `${item.fileIndex}:${item.order}`))
    for (const item of flat) if (!kept.has(`${item.fileIndex}:${item.order}`)) truncatedFiles.add(item.fileIndex)
    selected = [
      ...selected,
      {
        fileIndex: markerFile,
        order: Number.MAX_SAFE_INTEGER,
        finding: {
          severity: majorOverflow ? "MAJOR" : "INFO",
          kind: "other",
          evidence: `${scanned[markerFile]?.path ?? ""}:1`,
          detail: majorOverflow
            ? `findings truncated at ${maxTotalFindings}; further MAJOR findings are not listed`
            : `findings truncated at ${maxTotalFindings} (MAJOR findings are kept)`,
          fix: "Fix the listed findings or increase max_findings/max_total, then rerun; a deterministic rerun with the same caps shows the same prefix.",
        },
      },
    ]
    truncatedFiles.add(markerFile)
  }

  let counter = 0
  const files: ContextFileResult[] = []
  for (const [fileIndex, file] of scanned.entries()) {
    const findings: ContextFinding[] = []
    for (const item of selected) {
      if (item.fileIndex !== fileIndex) continue
      counter += 1
      findings.push({ id: `CTX-${String(counter).padStart(3, "0")}`, ...item.finding })
    }
    files.push({
      path: file.path,
      kind: file.kind,
      lines: file.lines,
      words: file.words,
      chars: file.chars,
      tokens_est: file.tokens_est,
      findings,
      ...(truncatedFiles.has(fileIndex) ? { truncated: true } : {}),
    })
  }

  const all = files.flatMap((file) => file.findings)
  const major = all.filter((finding) => finding.severity === "MAJOR")
  const minor = all.filter((finding) => finding.severity === "MINOR").length
  const info = all.filter((finding) => finding.severity === "INFO").length
  const truncated = globalTruncated || truncatedFiles.size > 0
  return {
    schema: "context-lint/v1",
    ok: true,
    verdict: major.length > 0 ? "fail" : "pass",
    closing_list: major.map((finding) => finding.id),
    files,
    summary: `${files.length} file(s); MAJOR ${major.length}, MINOR ${minor}, INFO ${info}`,
    ...(truncated ? { truncated: true } : {}),
  }
}
