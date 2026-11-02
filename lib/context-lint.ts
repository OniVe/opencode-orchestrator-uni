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
 * - line-oriented parsers scan every line, however long: the link, placeholder
 *   and section-heading regexes are linear (no unbounded `\s*` chain next to a
 *   lazy `.*?`), so a minified line cannot make matching quadratic and a long
 *   line cannot hide a broken link or placeholder behind a skip; the section
 *   checks yield to the event loop every `SECTION_ABORT_LINES` lines, so a
 *   timer-driven abort wins there too;
 * - code fences, inline code and HTML comments are masked once and every
 *   content check reads the masked lines: a sample is not a rule;
 * - nothing is dropped silently: an unclosed fence, a link target outside the
 *   root and a directory below the depth limit each leave an INFO finding, and
 *   a code span without a closing run is literal text (CommonMark), not a mask
 *   to the end of the line.
 */
import { existsSync } from "node:fs"
import { open, readdir, realpath, stat } from "node:fs/promises"
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
  /** Schema id of this payload, so a failure is self-describing like a report. */
  readonly schema: "context-lint-failure/v1"
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
/** Skipped-link INFO findings per scan; the rest is one counter finding. */
const MAX_SKIPPED_LINK_FINDINGS = 10
/**
 * Link candidates collected from one file before the list is truncated; above
 * the cap the file is reported incomplete (MAJOR marker) instead of failing on
 * a merely large link list.
 */
const MAX_LINK_CANDIDATES = 50_000
/** Candidates between abort checks and a macrotask yield. */
const LINK_CHECK_YIELD = 100
/** Source characters between abort checks inside the linear link scanner. */
const LINK_SCAN_ABORT_INTERVAL = 1_000
/**
 * Upper bound of every link-check cache (parent real paths, target real paths,
 * probed paths). A pathological file can mention 50k distinct parents/targets;
 * capping keeps the caches small without changing which links are reported
 * (a cache miss only costs one extra `realpath`/`existsSync`).
 */
const LINK_CACHE_LIMIT = 5_000

const SKIP = new Set(["node_modules", ".git", ".ae", "dist", "build", "target", "vendor"])
const TARGET_NAME = /^(AGENTS|SPEC|CLAUDE)\.md$/i
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
/**
 * Shell tools a command section may name. `make` is matched separately: prose
 * "Make sure to be careful" is not a command, only a `make <target>` form is.
 */
const SHELL_TOOL = /\b(?:npm|bun|pnpm|yarn|cargo|pytest)\b|\bgo[ \t]+test\b/i
/** `make` with a target; the stoplist keeps ordinary English prose out. */
const MAKE_TARGET =
  /\bmake[ \t]+(?!sure\b|sense\b|it\b|them\b|this\b|that\b|these\b|those\b|a\b|an\b|the\b|no\b|not\b|any\b|both\b|your\b|our\b|their\b|him\b|her\b|me\b|us\b)(?:-{1,2}[\w-]+|[\w][\w./:-]*)/i
const BOUNDARIES = /(never|никогда|ask first|сначала спроси|do not|не редактир|не коммит)/i
const VERIFICATION = /(verification|verify|definition of done|определение готовности|готовност|готово|проверк)/i
const DEFINITION_OF_DONE = /(definition of done|\bdod\b|готовност|готово)/i

/**
 * A non-goals heading: `## Non-goals`, `## 2. Goal and non-goals`,
 * `## Non-goals: A; B; C`. The optional group is the inline list after the label.
 * Every whitespace run is bounded: an unbounded `\s*` next to the lazy `.*?`
 * made a line of N spaces cost O(N²). `.*?` itself is linear because the tail
 * after the label is bounded.
 */
const NON_GOALS_HEADING =
  /^#{1,6}[ \t]{0,8}(?:\d+[.)][ \t]{0,8})?.*?(?:non-goals?|non goals?|out of scope|не-цели|не цели|не делаем)(?:[ \t]{0,8}:[ \t]{0,8}(.*)|[ \t]{0,8})$/i

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

/** Thrown by the directory walk when `maxFiles` is exceeded; refusal is early. */
class FilesLimitExceeded extends Error {
  constructor() {
    super("context lint file limit")
    this.name = "FilesLimitExceeded"
  }
}

/** Lines between abort checks and event-loop yields inside a line-oriented check. */
const SECTION_ABORT_LINES = 2048

/**
 * Cooperative abort point inside a synchronous per-line check. Called every
 * `SECTION_ABORT_LINES` lines: the yield lets a timer-driven abort fire, and an
 * already-aborted signal surfaces as `ScanAborted` (mapped to `E_ABORTED`) so a
 * section check can never return a full verdict after the caller aborted.
 */
async function abortGate(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return
  if (signal.aborted) throw new ScanAborted()
  await new Promise<void>((resolve) => setImmediate(resolve))
  if (signal.aborted) throw new ScanAborted()
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
  const chars = codePointLength(text)
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length
  return Math.round(cyrillic / 3 + (chars - cyrillic) / 4)
}

/**
 * Number of Unicode code points, counted without materializing `[...text]`
 * (a 2 MB line would otherwise allocate one array entry per character).
 */
function codePointLength(text: string): number {
  let length = 0
  for (const _ of text) length += 1
  return length
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

/** Chunk size of a capped read; memory stays bounded by the cap, not the file. */
const READ_CHUNK_BYTES = 64 * 1024

/**
 * Read at most `maxBytes + 1` bytes through a FileHandle. `stat` is only the fast
 * path with the exact size for the message: the authoritative cap is enforced
 * here, so a file that grows between the `stat` and the read (TOCTOU) is refused
 * with its observed size instead of being loaded whole. Exported for the cap
 * test; it is an implementation detail, not part of the tool contract.
 */
export async function readCappedFile(
  file: string,
  maxBytes: number,
): Promise<{ readonly text: string } | { readonly bytes: number }> {
  const handle = await open(file, "r")
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
      if (total > maxBytes) return { bytes: total }
    }
    return { text: Buffer.concat(chunks).toString("utf8") }
  } finally {
    await handle.close()
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
 *
 * The walk keeps a shared state instead of returning arrays: the file list is
 * bounded by `maxFiles` and refuses *early* (the walk stops on the first file
 * above the limit instead of expanding the whole tree), and every directory cut
 * by the depth limit is counted, so the caller can report it instead of
 * dropping files silently.
 */
interface CollectState {
  readonly files: string[]
  readonly maxFiles: number
  /** Directories below the depth limit that were not scanned. */
  skippedDepth: number
  /** Entries whose real path resolves outside the root (junction/symlink). */
  readonly skippedLinks: string[]
}

async function collectFiles(
  start: string,
  realRoot: string,
  signal: AbortSignal | undefined,
  state: CollectState,
  depth = 0,
  visited = new Set<string>(),
): Promise<void> {
  if (depth > 3) {
    state.skippedDepth += 1
    return
  }
  if (signal?.aborted) throw new ScanAborted()
  const identity = await canonical(start)
  if (!isInside(realRoot, identity)) return
  if (visited.has(identity)) return
  visited.add(identity)
  const entries = await readdir(start, { withFileTypes: true })
  const push = (file: string): void => {
    state.files.push(file)
    if (state.files.length > state.maxFiles) throw new FilesLimitExceeded()
  }
  for (const entry of entries) {
    if (signal?.aborted) throw new ScanAborted()
    const full = path.join(start, entry.name)
    const skipOutside = async (candidate: string): Promise<boolean> => {
      if (isInside(realRoot, await canonical(candidate))) return false
      // A junction/symlink that resolves outside the root is never scanned; the
      // skip is recorded so the caller can report it instead of dropping it.
      state.skippedLinks.push(candidate)
      return true
    }
    if (entry.isSymbolicLink()) {
      // A junction/symlink with a skipped name (`node_modules`, `dist`, `vendor`, …)
      // is excluded by name, exactly like a real directory of that name: it is not
      // reported as an out-of-root link, because the name already says it is not a
      // workspace source (on Windows/pnpm `node_modules` is a junction by default).
      if (SKIP.has(entry.name)) continue
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(full)
      } catch {
        continue // dangling link
      }
      if (await skipOutside(full)) continue
      if (info.isFile()) {
        if (TARGET_NAME.test(entry.name)) push(full)
      } else if (info.isDirectory() && !SKIP.has(entry.name)) {
        await collectFiles(full, realRoot, signal, state, depth + 1, visited)
      }
      continue
    }
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      if (await skipOutside(full)) continue
      await collectFiles(full, realRoot, signal, state, depth + 1, visited)
    } else if (entry.isFile() && TARGET_NAME.test(entry.name)) {
      if (await skipOutside(full)) continue
      push(full)
    }
  }
}

interface TargetBatch {
  readonly files: string[]
  /** Directories below the depth limit; reported as an INFO finding. */
  readonly skippedDepth: number
  /** In-root entries whose real path resolves outside the root; reported as INFO. */
  readonly skippedLinks: readonly string[]
}

async function resolveTargets(
  root: string,
  target: string | undefined,
  maxFiles: number,
  realRoot: string,
  signal: AbortSignal | undefined,
): Promise<TargetBatch | ContextLintFailure> {
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
      schema: "context-lint-failure/v1",
      code: "E_OUT_OF_ROOT",
      message: `target is outside the workspace root: ${start}`,
      path: start,
    }
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(start)
  } catch {
    return { ok: false, schema: "context-lint-failure/v1", code: "E_NOT_FOUND", message: `target not found: ${start}` }
  }
  // Authoritative containment: a symlink/junction may lexically look in-root and
  // still resolve outside it.
  const resolvedStart = await canonical(start)
  if (!isInside(realRoot, resolvedStart)) {
    return {
      ok: false,
      schema: "context-lint-failure/v1",
      code: "E_OUT_OF_ROOT",
      message: `target resolves outside the workspace root: ${start} -> ${resolvedStart}`,
      path: start,
    }
  }
  if (info.isFile()) return { files: [start], skippedDepth: 0, skippedLinks: [] }
  if (!info.isDirectory())
    return {
      ok: false,
      schema: "context-lint-failure/v1",
      code: "E_INPUT",
      message: `target is neither a file nor a directory: ${start}`,
    }
  const state: CollectState = { files: [], maxFiles, skippedDepth: 0, skippedLinks: [] }
  try {
    await collectFiles(start, realRoot, signal, state)
  } catch (error) {
    if (error instanceof FilesLimitExceeded) {
      return {
        ok: false,
        schema: "context-lint-failure/v1",
        code: "E_LIMIT_FILES",
        message: `more than ${maxFiles} files under ${start}; limit ${maxFiles}`,
        path: start,
        files: state.files.length,
        max: maxFiles,
      }
    }
    if (error instanceof ScanAborted || signal?.aborted) {
      return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }
    }
    return {
      ok: false,
      schema: "context-lint-failure/v1",
      code: "E_IO",
      message: `cannot read ${start}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  state.files.sort()
  state.skippedLinks.sort()
  return { files: state.files, skippedDepth: state.skippedDepth, skippedLinks: state.skippedLinks }
}

/** Length of the backtick run that starts at `index`. */
function backtickRun(text: string, index: number): number {
  let run = 1
  while (text[index + run] === "`") run += 1
  return run
}

/**
 * End index (inclusive) of an HTML open tag `<name …>` starting at `index`, or
 * `undefined` when this position is not that tag. `<code>`/`<code class=…>` and
 * `<pre>`/`<pre class=…>` match; `<codes>` does not.
 */
function htmlOpenTagEnd(text: string, index: number, name: string): number | undefined {
  if (text.slice(index, index + name.length + 1).toLowerCase() !== `<${name}`) return undefined
  const next = text[index + name.length + 1]
  if (next !== ">" && next !== undefined && !/\s/.test(next)) return undefined
  const close = text.indexOf(">", index + name.length + 1)
  return close === -1 ? undefined : close
}

/**
 * End index (inclusive) of an HTML close tag `</name …>` starting at `index`,
 * or `undefined` when this position is not that tag. Matching is
 * case-insensitive and only whitespace may separate the name from `>`, so
 * `</code >` and `</PRE\t>` close their span while `</codes>` does not.
 */
function htmlCloseTagEnd(text: string, index: number, name: string): number | undefined {
  if (text.slice(index, index + name.length + 2).toLowerCase() !== `</${name}`) return undefined
  const next = text[index + name.length + 2]
  if (next !== undefined && next !== ">" && !/\s/.test(next)) return undefined
  const close = text.indexOf(">", index + name.length + 2)
  if (close < 0) return undefined
  if (text.slice(index + name.length + 2, close).trim() !== "") return undefined
  return close
}

/**
 * Markup that makes `maskCode` rewrite a line: a backtick, an HTML comment or a
 * `<pre>`/`<code>` open tag (any letter case; a false positive such as
 * `<prefix` only costs the slow path). A line without it masks to itself.
 */
const MASK_MARKUP = /<!--|<pre|<code/i

/**
 * Result of one mask pass: the masked lines plus the 1-based line where a state
 * that swallows the rest of the file is still open at EOF. One parser reports the
 * masking state, so a marker inside a fence/comment/`<pre>` is never mistaken for
 * an unclosed one.
 */
interface MaskedLines {
  readonly masked: string[]
  /** A fenced block still open at EOF. */
  readonly unclosedFenceLine?: number
  /** A `<pre>` span still open at EOF. */
  readonly unclosedPreLine?: number
  /** An HTML comment still open at EOF. */
  readonly unclosedCommentLine?: number
}

interface MaskOptions {
  readonly inlineCode: boolean
  readonly indentedCode?: boolean
  /** Mask HTML comments (default `true`); the commands check reads code with comments visible. */
  readonly comments?: boolean
}

/**
 * Replace code blocks, `<pre>`/`<code>` spans, indented code and (when
 * `options.inlineCode` is set) inline code and HTML comments with spaces,
 * keeping the line count and every line length. A fence opened with N markers
 * closes only with at least N markers of the same character; a code span
 * opened with a run of N backticks closes only on a run of exactly N, so
 * ``a, b`` is one span, and a run without a closing match in the same line is
 * literal text (CommonMark), not a mask to the end of the line.
 * `options.indentedCode` (default `true`) masks 4-space indented code;
 * non-goals counting turns it off to accept its 4-space bullets.
 * A `<pre>…</pre>` span is masked in place, preserving the text before and
 * after it; an unclosed `<pre>` masks the following lines too, but never the
 * current line prefix. The same pass reports which of those states is still open
 * at EOF, so the caller can flag the masked remainder instead of passing it.
 */
function maskCode(lines: readonly string[], options: MaskOptions): MaskedLines {
  const masked: string[] = []
  let fence: { readonly char: string; readonly length: number; readonly line: number } | undefined
  let inComment = false
  let commentFrom: number | undefined
  let inPre = false
  let preFrom: number | undefined
  let inIndented = false
  let previousBlank = true
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const lineNumber = lineIndex + 1
    const blank = line.trim() === ""
    if (fence !== undefined) {
      const close = new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`)
      if (close.test(line)) fence = undefined
      masked.push(" ".repeat(line.length))
      previousBlank = false
      continue
    }
    if (!inComment && !inPre) {
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
        fence = { char: open[1][0], length: open[1].length, line: lineNumber }
        masked.push(" ".repeat(line.length))
        previousBlank = false
        continue
      }
    }
    // Fast path: outside a fence/comment/`<pre>` span, a line with no backtick
    // and no `<pre>`/`<code>`/`<!--` masks to itself. Reuse the original string
    // (no per-character rebuild, no copy); the state above was already updated
    // and `previousBlank` is set exactly as the slow path would.
    if (!inComment && !inPre && !line.includes("`") && !MASK_MARKUP.test(line)) {
      masked.push(line)
      previousBlank = blank
      continue
    }
    let out = ""
    let inCodeTag = false
    // Inline code spans: a run of N backticks opens a span only when a later run
    // of exactly N backticks exists on the same line (CommonMark). A run with no
    // closing match stays literal text, so a stray backtick cannot mask the rest
    // of the line and hide a link behind it. Runs are indexed per line and looked
    // up by binary search, so the scan stays O(line length · log runs) instead of
    // rescanning the line for every unmatched run.
    const runStarts = new Map<number, number[]>()
    if (options.inlineCode) {
      let at = line.indexOf("`")
      while (at >= 0) {
        const run = backtickRun(line, at)
        const list = runStarts.get(run)
        if (list === undefined) runStarts.set(run, [at])
        else list.push(at)
        at = line.indexOf("`", at + run)
      }
    }
    const closingRun = (run: number, after: number): number | undefined => {
      const list = runStarts.get(run)
      if (list === undefined) return undefined
      let low = 0
      let high = list.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (list[middle] <= after) low = middle + 1
        else high = middle
      }
      return list[low]
    }
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]
      if (inPre) {
        const end = htmlCloseTagEnd(line, index, "pre")
        if (end !== undefined) {
          out += " ".repeat(end - index + 1)
          index = end
          inPre = false
          preFrom = undefined
        } else {
          out += " "
        }
        continue
      }
      if (inComment) {
        if (line.startsWith("-->", index)) {
          out += "   "
          index += 2
          inComment = false
          commentFrom = undefined
        } else {
          out += " "
        }
        continue
      }
      if (inCodeTag) {
        const end = htmlCloseTagEnd(line, index, "code")
        if (end !== undefined) {
          out += " ".repeat(end - index + 1)
          index = end
          inCodeTag = false
        } else {
          out += " "
        }
        continue
      }
      if (character === "`" && options.inlineCode) {
        const run = backtickRun(line, index)
        const close = closingRun(run, index + run - 1)
        if (close === undefined) {
          // No closing run of this width: literal text, the line stays checked.
          out += "`".repeat(run)
          index += run - 1
          continue
        }
        const end = close + run - 1
        out += " ".repeat(end - index + 1)
        index = end
        continue
      }

      if (options.comments !== false && line.startsWith("<!--", index)) {
        out += "    "
        index += 3
        inComment = true
        commentFrom ??= lineNumber
        continue
      }
      if (options.inlineCode) {
        const codeEnd = htmlOpenTagEnd(line, index, "code")
        if (codeEnd !== undefined) {
          out += " ".repeat(codeEnd - index + 1)
          index = codeEnd
          inCodeTag = true
          continue
        }
      }
      const preEnd = htmlOpenTagEnd(line, index, "pre")
      if (preEnd !== undefined) {
        out += " ".repeat(preEnd - index + 1)
        index = preEnd
        inPre = true
        preFrom ??= lineNumber
        continue
      }
      out += character
    }
    masked.push(out)
    previousBlank = inPre ? false : blank
  }
  return {
    masked,
    ...(fence === undefined ? {} : { unclosedFenceLine: fence.line }),
    ...(preFrom === undefined ? {} : { unclosedPreLine: preFrom }),
    ...(commentFrom === undefined ? {} : { unclosedCommentLine: commentFrom }),
  }
}

/** Fences, `<pre>`, comments and indented code only: AC/R cells keep their text. */
function maskFences(lines: readonly string[]): MaskedLines {
  return maskCode(lines, { inlineCode: false })
}

/** Fences plus inline code and comments: links, vague phrases and placeholders. */
function maskAll(lines: readonly string[]): MaskedLines {
  return maskCode(lines, { inlineCode: true })
}

/**
 * Fences, `<pre>` and comments only: indented code stays visible, so a 4-space
 * bullet under a non-goals label is counted as an item. Inline code keeps its
 * text, like `maskFences`.
 */
function maskSectionBlocks(lines: readonly string[]): MaskedLines {
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

async function checkVague(
  file: ContextFileResult,
  lines: readonly string[],
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<void> {
  const seen = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (index % SECTION_ABORT_LINES === 0) await abortGate(signal)
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

async function checkDuplicates(
  file: ContextFileResult,
  masked: readonly string[],
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<void> {
  const seen = new Map<string, number>()
  for (let index = 0; index < masked.length; index += 1) {
    if (index % SECTION_ABORT_LINES === 0) await abortGate(signal)
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

/** Whitespace test used by the link scanner; `\s` matches CommonMark spaces. */
const LINK_WHITESPACE = /\s/

/** A UNC (`\\host\share`) or protocol-relative (`//host/x`) destination: never probed. */
function isNetworkTarget(raw: string): boolean {
  const target = raw.trim()
  return target.startsWith("\\\\") || target.startsWith("//")
}

function skipLinkWhitespace(line: string, index: number): number {
  let at = index
  while (at < line.length && LINK_WHITESPACE.test(line[at])) at += 1
  return at
}

/** True when the bracket at `open` is escaped by an odd run of backslashes (prose). */
function isEscapedOpen(line: string, open: number): boolean {
  let backslashes = 0
  while (open - backslashes - 1 >= 0 && line[open - backslashes - 1] === "\\") backslashes += 1
  return backslashes % 2 === 1
}

/**
 * Targets of every `](target)` on one line in a single forward pass, with no
 * stack and no per-candidate scan to the end of the line: `indexOf("](")`
 * locates the next open, the target and the optional title are consumed
 * locally, and `i` either jumps past the closing `)` or past the rejected
 * `](`. Total work is O(line length): a line of `](` without `)` stops at the
 * end of the first target (break), and closed pairs advance past the `)`.
 * A target is the run up to whitespace or `)` (an escaped `](` is prose, and so
 * is a candidate whose enclosing `[` is escaped: `\[o1](m1.md)` is literal text
 * under CommonMark), `<…>` strips the angles (literal spaces are percent-encoded, because an
 * angle destination may contain them), and a `'…'`/`"…"` title may contain
 * `)`, `](` and escaped quotes. An unclosed angle or title rejects only its
 * own candidate and resumes at `open + 2`, so a later valid link on the same
 * line is still checked; only a non-angle target with no `)` left stops the
 * scan (no later link can close). The next `>` is cached, so a run of
 * `](<` without `>` stays linear instead of rescanning to the end.
 * Yields one target at a time instead of collecting a `targets[]` array, so a
 * single line never materializes every link it contains. Aborts are checked at
 * the start, at the end and every `LINK_SCAN_ABORT_INTERVAL` candidates; on an
 * abort the generator stops yielding and the caller sees `signal.aborted`.
 */
function* scanLinkTargets(line: string, signal: AbortSignal | undefined): Generator<string> {
  const length = line.length
  let index = 0
  let checked = 0
  // Cached position of the first `>` at or after `angleFrom` (-1: none left).
  // Candidate cursors only grow, so a found close stays valid until it is
  // passed and a missing close stays missing; a run of unclosed `](<` costs one
  // scan to the end, not one per candidate.
  let angleFrom = -1
  let angleNext = -1
  // Position of the last `[` before the current candidate: an odd backslash run
  // before it (`\[o1](m1.md)`) makes the bracket literal, so the candidate is
  // prose. The pointer only moves forward over the line, so the check stays
  // linear.
  let bracketFrom = 0
  let bracketEscaped = false
  if (signal?.aborted) return
  while (index < length) {
    checked += 1
    if (checked >= LINK_SCAN_ABORT_INTERVAL) {
      if (signal?.aborted) return
      checked = 0
    }
    const open = line.indexOf("](", index)
    if (open < 0) break
    while (bracketFrom < open) {
      const at = line.indexOf("[", bracketFrom)
      if (at < 0 || at >= open) {
        bracketFrom = open
        break
      }
      bracketEscaped = isEscapedOpen(line, at)
      bracketFrom = at + 1
    }
    if (bracketEscaped) {
      index = open + 2
      continue
    }
    if (isEscapedOpen(line, open)) {
      index = open + 2
      continue
    }
    let cursor = open + 2
    let target: string
    if (line[cursor] === "<") {
      if (angleFrom < 0 || (angleNext >= 0 && angleNext < cursor)) {
        angleFrom = cursor
        angleNext = line.indexOf(">", cursor + 1)
      }
      if (angleNext < 0) {
        // Unclosed angle: this candidate is not a link, but the rest of the
        // line may still hold one.
        index = open + 2
        continue
      }
      // An unescaped `<` inside the angle destination makes it malformed
      // (CommonMark forbids `<` there). A later link's `<...>` produces one;
      // a literal `](` in a valid destination does not. Recover at the next
      // `](` instead of swallowing the later link.
      const nestedOpen = line.indexOf("<", cursor + 1)
      if (nestedOpen >= 0 && nestedOpen < angleNext) {
        index = open + 2
        continue
      }
      // An angle destination may contain raw spaces; encode them so the target
      // survives `localLinkTarget`'s whitespace rejection and decodes back.
      // Padding stays trimmed like the non-angle path (the target is trimmed
      // before the whitespace check there too).
      target = line
        .slice(cursor + 1, angleNext)
        .trim()
        .replace(/ /g, "%20")
      cursor = angleNext + 1
    } else {
      const start = cursor
      while (cursor < length && !LINK_WHITESPACE.test(line[cursor]) && line[cursor] !== ")") cursor += 1
      // No `)` can follow the end of the line: stop instead of rescanning.
      if (cursor >= length) break
      target = line.slice(start, cursor)
    }
    let after = skipLinkWhitespace(line, cursor)
    const quote = line[after]
    if (after < length && (quote === "'" || quote === '"')) {
      let at = after + 1
      while (at < length && line[at] !== quote) at += line[at] === "\\" ? 2 : 1
      if (at >= length) {
        // Unclosed title: reject this candidate only; later `](` may be valid.
        index = open + 2
        continue
      }
      after = skipLinkWhitespace(line, at + 1)
    }
    if (after < length && line[after] === ")") {
      yield target
      index = after + 1
    } else {
      index = open + 2
    }
  }
  if (signal?.aborted) return
}

/**
 * Check local relative links. Cost and containment are bounded:
 * - the parser is a single forward state machine with no stack and no
 *   per-candidate scan to the end of the line, so `](` without a closing `)`
 *   cannot trigger quadratic backtracking;
 * - targets are consumed one at a time from the generator and resolved inline:
 *   no `candidates[]` array and no per-candidate record survive, so memory does
 *   not grow with the number of links. At most `MAX_LINK_CANDIDATES` candidates
 *   are counted per file; exceeding the cap returns `truncated: true` and the
 *   caller adds one MAJOR marker (the unverified remainder must never let the
 *   verdict pass); the file itself is capped at 2 MB, so even a pathological
 *   50k-link list keeps only the current line's dedupe set plus the bounded
 *   path caches;
 * - every `LINK_CHECK_YIELD` candidates the signal is checked and the event
 *   loop is yielded to, and `signal.aborted` is checked per line before and
 *   after the generator, so a timer-driven abort wins inside a long line too;
 * - the parent's real path is resolved (and cached) before `existsSync`; an
 *   unknown or out-of-root parent is skipped, so a junction pointing outside
 *   the root is never probed and never reported as a broken link; the real path
 *   of an existing target is cached as well, so 20k anchors to one file cost
 *   one `realpath`. Every cache keeps at most `LINK_CACHE_LIMIT` entries, so a
 *   hostile list of 50k distinct parents/targets cannot grow them without
 *   bound (a miss costs one extra probe, never a wrong finding);
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
  const parentRealPaths = new Map<string, string | undefined>()
  const targetRealPaths = new Map<string, string | undefined>()
  const probed = new Map<string, boolean>()
  let candidates = 0
  let sinceYield = 0
  let candidatesTruncated = false
  for (let index = 0; index < lines.length; index += 1) {
    // N56: a timer abort must win at least between lines even if the current
    // line is short.
    if (signal?.aborted) return { aborted: true, truncated: candidatesTruncated }
    const line = lines[index]
    // Fast path: without `](` the scanner yields nothing, so most prose lines
    // never allocate a generator or a dedupe set.
    if (!line.includes("](")) continue
    // Dedupe is per line (`line:target` before): a repeated target on one line
    // is checked once, and the set dies with the line. Created on first use so
    // a link-free line allocates nothing.
    let seen: Set<string> | undefined
    for (const raw of scanLinkTargets(line, signal)) {
      const target = localLinkTarget(raw)
      if (target === undefined) {
        // A UNC or protocol-relative destination is never probed (a network path
        // would block on the SMB timeout); it is reported instead of dropped, so
        // an unchecked target never reads as a checked one. Ordinary URI schemes
        // (`https:`, `mailto:`) are out of scope and stay silent.
        if (isNetworkTarget(raw)) {
          sink.push({
            severity: "INFO",
            kind: "other",
            evidence: `${file.path}:${index + 1}`,
            detail: clip(`network path is outside the workspace root and was not checked: "${raw.trim()}"`),
            fix: "Point the link at a file inside the workspace or remove it.",
          })
        }
        continue
      }
      if (candidates >= MAX_LINK_CANDIDATES) {
        candidatesTruncated = true
        break
      }
      candidates += 1
      sinceYield += 1
      if (sinceYield >= LINK_CHECK_YIELD) {
        sinceYield = 0
        if (signal?.aborted) return { aborted: true, truncated: candidatesTruncated }
        // A macrotask boundary lets setTimeout-driven abort timers fire; microtasks
        // alone would starve them.
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (signal?.aborted) return { aborted: true, truncated: candidatesTruncated }
      }
      if (seen?.has(target)) continue
      seen ??= new Set<string>()
      seen.add(target)
      const resolved = target.startsWith("/")
        ? path.join(root, target.slice(1))
        : path.resolve(path.dirname(absolute), target)
      // Only local, in-root paths reach the filesystem: a path outside the
      // workspace is not ours to check, and a network path would block on SMB.
      // Such a link is reported (INFO): silence would be indistinguishable from
      // "checked and valid".
      if (!isInside(root, resolved)) {
        sink.push({
          severity: "INFO",
          kind: "other",
          evidence: `${file.path}:${index + 1}`,
          detail: clip(`link target is outside the workspace root and was not checked: "${raw.trim()}"`),
          fix: "Point the link at a file inside the workspace or remove it.",
        })
        continue
      }
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
        if (parentRealPaths.size < LINK_CACHE_LIMIT) parentRealPaths.set(parent, parentReal)
      }
      // Unknown or out-of-root parent: do not probe the child (a junction could
      // otherwise pull `existsSync` outside the workspace). The skip is reported:
      // an unverified link must not read as a verified one.
      if (parentReal === undefined || !isInside(realRoot, parentReal)) {
        sink.push({
          severity: "INFO",
          kind: "other",
          evidence: `${file.path}:${index + 1}`,
          detail: clip(`link target is outside the workspace root and was not checked: "${raw.trim()}"`),
          fix: "Point the link at a file inside the workspace or remove it.",
        })
        continue
      }
      // The probe itself is cached per resolved path: 20k anchors to one file are
      // one probe; a broken target repeated on many lines is still reported per
      // candidate line below. The cache keeps at most LINK_CACHE_LIMIT entries,
      // so 50k distinct broken targets are not retained.
      let exists = probed.get(resolved)
      if (exists === undefined) {
        exists = existsSync(resolved)
        if (probed.size < LINK_CACHE_LIMIT) probed.set(resolved, exists)
      }
      if (exists) {
        // An existing symlink/junction inside the root can still resolve outside
        // it; such a target is not ours to check either. The real path is cached:
        // a list of 20k anchors to one file must not cost 20k `realpath` calls.
        let targetReal = targetRealPaths.get(resolved)
        if (!targetRealPaths.has(resolved)) {
          targetReal = await existingRealPath(resolved)
          if (targetRealPaths.size < LINK_CACHE_LIMIT) targetRealPaths.set(resolved, targetReal)
        }
        if (targetReal === undefined || !isInside(realRoot, targetReal)) {
          sink.push({
            severity: "INFO",
            kind: "other",
            evidence: `${file.path}:${index + 1}`,
            detail: clip(`link target could not be resolved inside the workspace and was not checked: "${raw.trim()}"`),
            fix: "Point the link at a file inside the workspace or remove it.",
          })
          continue
        }
        continue
      }
      sink.push({
        severity: "MAJOR",
        kind: "broken_link",
        evidence: `${file.path}:${index + 1}`,
        detail: clip(`missing path "${target}"`),
        fix: "Fix the link or remove it.",
      })
    }
    // The generator stops on its own abort check (every
    // LINK_SCAN_ABORT_INTERVAL characters); surface that as an abort here.
    if (signal?.aborted) return { aborted: true, truncated: candidatesTruncated }
    if (candidatesTruncated) break
  }
  return { aborted: false, truncated: candidatesTruncated }
}

async function checkPlaceholders(
  file: ContextFileResult,
  lines: readonly string[],
  masked: readonly string[],
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<void> {
  let openQuestionsLevel: number | undefined
  for (let index = 0; index < lines.length; index += 1) {
    if (index % SECTION_ABORT_LINES === 0) await abortGate(signal)
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

/**
 * Report every region the mask swallowed to the end of the file. The state comes
 * from the same `maskCode` pass that produced the masked lines, so a fence marker
 * inside a comment, `<pre>` or indented code is never mistaken for an unclosed
 * fence. INFO keeps the verdict unchanged (CommonMark says it is code) while
 * making the unchecked remainder visible.
 */
function checkMaskedRegions(file: ContextFileResult, mask: MaskedLines, sink: FindingSink): void {
  const unclosed: readonly (readonly [string, number | undefined])[] = [
    ["fence", mask.unclosedFenceLine],
    ["<pre>", mask.unclosedPreLine],
    ["HTML comment", mask.unclosedCommentLine],
  ]
  for (const [marker, line] of unclosed) {
    if (line === undefined) continue
    sink.push({
      severity: "INFO",
      kind: "other",
      evidence: `${file.path}:${line}`,
      detail: `unclosed ${marker} at line ${line}; the rest of the file is masked and not checked`,
      fix: `Close the ${marker} so the following content is checked.`,
    })
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
 * Split an inline list at the top level only: never inside `(…)`, `[…]`, `{…}`,
 * a backtick span of any width (``…``), an HTML `<code …>…</code>` span or a
 * `<pre>…</pre>` span. Separators are `;`, `,`, `X and Y` / `X и Y` and a
 * numbered marker (`1.`/`2)`); a comma or semicolon inside brackets or code is
 * content.
 */
function splitTopLevelItems(text: string): string[] {
  const parts: string[] = []
  let current = ""
  let depth = 0
  let ticks = 0
  let inCodeTag = false
  let inPre = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inPre) {
      const end = htmlCloseTagEnd(text, index, "pre")
      if (end !== undefined) {
        current += text.slice(index, end + 1)
        index = end
        inPre = false
      } else {
        current += character
      }
      continue
    }
    if (inCodeTag) {
      const end = htmlCloseTagEnd(text, index, "code")
      if (end !== undefined) {
        current += text.slice(index, end + 1)
        index = end
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
    const preEnd = htmlOpenTagEnd(text, index, "pre")
    if (preEnd !== undefined) {
      current += text.slice(index, preEnd + 1)
      index = preEnd
      inPre = true
      continue
    }
    const codeEnd = htmlOpenTagEnd(text, index, "code")
    if (codeEnd !== undefined) {
      current += text.slice(index, codeEnd + 1)
      index = codeEnd
      inCodeTag = true
      continue
    }
    if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1)
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
async function countNonGoals(
  lines: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ readonly present: boolean; readonly count: number }> {
  for (let index = 0; index < lines.length; index += 1) {
    if (index % SECTION_ABORT_LINES === 0) await abortGate(signal)
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
 * one, so `## Requirements` with only an AC table is empty. The list pattern
 * starts at `trimStart()`, so an N-space line costs one pass instead of the old
 * `^\s*…\s*` backtracking chain (O(N²) on a run of whitespace).
 */
async function collectRequirements(
  lines: readonly string[],
  skip: ReadonlySet<number>,
  signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (index % SECTION_ABORT_LINES === 0) await abortGate(signal)
    const line = lines[index]
    // Backticks around an id are markup: `` `R1` `` still declares R1.
    const plain = line.replace(/`/g, "")
    const listMatch = /^(?:[-*][ \t]*)?\*{0,2}(R\d+)(?!\d)/.exec(plain.trimStart())
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

async function checkAcRows(
  file: ContextFileResult,
  lines: readonly string[],
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (file.kind !== "spec") return
  const scan = scanAcTables(lines)
  const requirements = await collectRequirements(lines, acSkipLines(scan), signal)
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
 * Lines that may carry a shell command: the body of a fenced/indented code
 * block, inline code spans, a table whose header names a Task/Задача, and the
 * body of a Commands/Команды section. Prose outside those regions is not a
 * command source, so "Make sure to be careful" cannot satisfy the commands
 * check; `make` additionally needs a target (`MAKE_TARGET`). An HTML comment is
 * not code: `<!-- npm install -->` must not pass the check, so a line that is
 * blank in the comment-aware mask but not in the code mask is skipped.
 */
function commandSources(lines: readonly string[], fenceMasked: readonly string[]): string {
  const parts: string[] = []
  // Fences, `<pre>` and indented code only: a comment line is not blanked here,
  // so a commented command is not mistaken for a code block.
  const code = maskCode(lines, { inlineCode: false, comments: false }).masked
  let commandsLevel: number | undefined
  let taskTable = false
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const level = headingLevel(raw)
    if (level !== undefined) {
      if (COMMANDS_HEADING.test(raw)) commandsLevel = level
      else if (commandsLevel !== undefined && level <= commandsLevel) commandsLevel = undefined
    }
    taskTable = TABLE_ROW.test(raw) ? taskTable || TASK_TABLE_HEADER.test(raw) : false
    const fenced = raw.trim() !== "" && (code[index] ?? "").trim() === ""
    // A line that is blank in the comment-aware mask but not in the code mask is
    // comment content: `<!-- npm install -->` and a backticked command inside a
    // multi-line comment are not commands.
    const commented = !fenced && raw.trim() !== "" && (fenceMasked[index] ?? "").trim() === ""
    if (commented) continue
    if (fenced || commandsLevel !== undefined || taskTable) parts.push(raw)
    if (raw.includes("`")) {
      for (const match of raw.matchAll(/`+([^`\n]*)`+/g)) parts.push(match[1])
    }
  }
  return parts.join("\n")
}

function hasCommand(commands: string): boolean {
  return SHELL_TOOL.test(commands) || MAKE_TARGET.test(commands)
}

/**
 * Structural section checks. Commands/Boundaries/Verification/Definition of done
 * read the full mask (`masked`): a command or a check that exists only as inline
 * code is a sample, not a rule. Requirements and AC read `fenceMasked`: inline
 * code keeps its text there (`AC1.1`, `R1`). Non-goals read `sectionMasked`,
 * which also keeps 4-space bullets visible: a bullet under the label is an item,
 * not code. `lines` is the raw text: it is the only place where the body of a
 * fenced block is still visible for the commands check.
 */
async function checkSections(
  file: ContextFileResult,
  lines: readonly string[],
  fenceMasked: readonly string[],
  sectionMasked: readonly string[],
  masked: readonly string[],
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<void> {
  const text = masked.join("\n")
  if (file.kind === "agents" || file.kind === "claude") {
    if (
      !masked.some((line) => COMMANDS_HEADING.test(line)) &&
      !TASK_TABLE_HEADER.test(text) &&
      !hasCommand(commandSources(lines, fenceMasked))
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
    const nonGoals = await countNonGoals(sectionMasked, signal)
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
    const requirements = await collectRequirements(fenceMasked, acSkipLines(scan), signal)
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
 * A top-level `and`/`и` join: never inside `(…)`, `[…]`, `{…}` or a code span.
 * `and` must be a whole word and `и` a separate word, so `Android` and `импорт`
 * do not match.
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
    if (character === "(" || character === "[" || character === "{") {
      depth += 1
      continue
    }
    if (character === ")" || character === "]" || character === "}") {
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

async function checkAndChains(
  file: ContextFileResult,
  lines: readonly string[],
  sink: FindingSink,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (file.kind !== "spec") return
  for (let index = 0; index < lines.length; index += 1) {
    if (index % SECTION_ABORT_LINES === 0) await abortGate(signal)
    const line = lines[index]
    // `trimStart()` + a bounded run: the old `^\s*[-*]?\s*\*{0,2}` chain was
    // O(N²) on a line of N spaces.
    if (!/^(?:[-*][ \t]*)?\*{0,2}R\d+/i.test(line.trimStart())) continue
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
    return { ok: false, schema: "context-lint-failure/v1", code: "E_INPUT", message: "root must be a string" }
  }
  if (options.target !== undefined && (typeof options.target !== "string" || options.target.trim() === "")) {
    // The tool rejects `path: ""` as E_INPUT; the library keeps the same contract.
    return {
      ok: false,
      schema: "context-lint-failure/v1",
      code: "E_INPUT",
      message: "target must be a non-empty string",
    }
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
      return {
        ok: false,
        schema: "context-lint-failure/v1",
        code: "E_INPUT",
        message: `${name} must be a positive number`,
      }
    }
  }
  if (options.signal?.aborted)
    return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }

  const root = path.resolve(options.root)
  const realRoot = await canonical(root)
  const targets = await resolveTargets(root, options.target, maxFiles, realRoot, options.signal)
  if ("ok" in targets) return targets
  if (targets.files.length === 0) {
    return {
      ok: false,
      schema: "context-lint-failure/v1",
      code: "E_NO_FILES",
      message: "no AGENTS.md, SPEC.md or CLAUDE.md found in the target",
    }
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
  for (const absolute of targets.files) {
    if (options.signal?.aborted)
      return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }
    let size: number
    try {
      size = (await stat(absolute)).size
    } catch (error) {
      return {
        ok: false,
        schema: "context-lint-failure/v1",
        code: "E_IO",
        message: `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // Measure before reading: a multi-megabyte file would be parsed line by line
    // and echoed back through findings, which is the failure this cap prevents.
    // `stat` is a fast path with an exact size for the message; the read below
    // enforces the same cap on the bytes actually consumed, so a file replaced
    // between `stat` and the read cannot slip past it (TOCTOU).
    if (size > maxFileBytes) {
      return {
        ok: false,
        schema: "context-lint-failure/v1",
        code: "E_LIMIT_FILE",
        message: `${relative(root, absolute)} is ${size} bytes; limit ${maxFileBytes}`,
        path: relative(root, absolute),
        bytes: size,
        max: maxFileBytes,
      }
    }
    let text: string
    try {
      const read = await readCappedFile(absolute, maxFileBytes)
      if ("bytes" in read) {
        return {
          ok: false,
          schema: "context-lint-failure/v1",
          code: "E_LIMIT_FILE",
          message: `${relative(root, absolute)} grew past the ${maxFileBytes}-byte limit while it was read`,
          path: relative(root, absolute),
          bytes: read.bytes,
          max: maxFileBytes,
        }
      }
      text = read.text
    } catch (error) {
      return {
        ok: false,
        schema: "context-lint-failure/v1",
        code: "E_IO",
        message: `cannot read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // The read itself is not abortable here; a caller that aborted while a 2 MB
    // file was being read must still get E_ABORTED rather than a full report.
    if (options.signal?.aborted)
      return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }
    const { lines, body } = normalizedLines(text)
    // Requirements, AC ids and non-goals read the fence mask: inline code keeps
    // its text, so `AC1.1`, `R1` and `test_export` in backticks still parse.
    // Links, vague phrases, placeholders and the structural section checks read
    // the full mask: a command or a check that exists only as inline code is a
    // sample, not a rule.
    const fenceMask = maskFences(lines)
    const fullMask = maskAll(lines)
    const sectionMask = maskSectionBlocks(lines)
    const fenceMasked = fenceMask.masked
    const masked = fullMask.masked
    const sectionMasked = sectionMask.masked
    const chars = codePointLength(body)
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
    let linksTruncated = false
    try {
      await checkVague(file, masked, sink, options.signal)
      await checkDuplicates(file, masked, sink, options.signal)
      const links = await checkLinks(file, masked, root, realRoot, absolute, sink, options.signal)
      linksTruncated = links.truncated
      if (links.aborted || options.signal?.aborted) {
        return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }
      }
      await checkPlaceholders(file, lines, masked, sink, options.signal)
      checkFirstLines(file, lines, sink)
      checkMaskedRegions(file, fullMask, sink)
      await checkSections(file, lines, fenceMasked, sectionMasked, masked, sink, options.signal)
      await checkAcRows(file, fenceMasked, sink, options.signal)
      await checkAndChains(file, masked, sink, options.signal)
    } catch (error) {
      // A section check yields every `SECTION_ABORT_LINES` lines; an abort that
      // fired during that yield must win over a full verdict.
      if (error instanceof ScanAborted)
        return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }
      throw error
    }
    if (options.signal?.aborted)
      return { ok: false, schema: "context-lint-failure/v1", code: "E_ABORTED", message: "context lint aborted" }
    // Markers are appended directly after the checks: they never displace a kept
    // finding. The MAJOR marker is itself MAJOR, so it is closed with the rest.
    if (linksTruncated) {
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
      truncated: sink.truncated || linksTruncated,
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

  // A directory below the depth limit, or an entry whose junction/symlink
  // resolves outside the root, is not scanned; both are reported as INFO findings
  // (bounded), because files dropped by the walk must not read as "checked".
  const first = files[0]
  if (first !== undefined && (targets.skippedDepth > 0 || targets.skippedLinks.length > 0)) {
    const extra: ContextFinding[] = []
    const nextId = (): string => {
      counter += 1
      return `CTX-${String(counter).padStart(3, "0")}`
    }
    if (targets.skippedDepth > 0) {
      extra.push({
        id: nextId(),
        severity: "INFO",
        kind: "other",
        evidence: `${first.path}:1`,
        detail:
          targets.skippedDepth === 1
            ? "depth limit 3: 1 directory below the limit was not scanned"
            : `depth limit 3: ${targets.skippedDepth} directories below the limit were not scanned`,
        fix: "Pass an explicit path inside the deep directory to check it.",
      })
    }
    const reported = targets.skippedLinks.slice(0, MAX_SKIPPED_LINK_FINDINGS)
    for (const link of reported) {
      extra.push({
        id: nextId(),
        severity: "INFO",
        kind: "other",
        evidence: `${first.path}:1`,
        detail: clip(`link resolves outside the workspace root and was skipped: "${relative(root, link)}"`),
        fix: "Keep the link inside the workspace or remove it.",
      })
    }
    if (targets.skippedLinks.length > reported.length) {
      extra.push({
        id: nextId(),
        severity: "INFO",
        kind: "other",
        evidence: `${first.path}:1`,
        detail: `${targets.skippedLinks.length - reported.length} more links resolve outside the workspace root and were skipped`,
        fix: "Keep the links inside the workspace or remove them.",
      })
    }
    files[0] = { ...first, findings: [...first.findings, ...extra] }
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
