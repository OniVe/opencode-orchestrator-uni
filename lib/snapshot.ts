/**
 * snapshot — deterministic, read-only state revision for the audit loop.
 *
 * The orchestrator records "the state the verdict was fixed on" as a set of
 * file hashes plus one aggregate hash. `audit_snapshot` returns exactly that:
 * a sorted file list with sha256 per file and a single `aggregate` that changes
 * whenever any file (or its path) changes.
 *
 * Determinism rules:
 * - the file list is sorted by relative path (codepoint order);
 * - `aggregate = sha256` of the concatenation of `"<relpath>\0<sha256>\n"` lines
 *   over that sorted list;
 * - relative paths always use `/` as the separator, whatever the platform;
 * - excluded entries are removed before hashing, never re-ordered.
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"

export interface SnapshotFile {
  /** Path relative to the snapshot root, `/`-separated. */
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

export interface SnapshotLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
}

export interface SnapshotSuccess {
  readonly root: string
  readonly files: readonly SnapshotFile[]
  readonly aggregate: string
}

export type SnapshotErrorCode =
  | "E_INPUT"
  | "E_NOT_FOUND"
  | "E_LIMIT_FILES"
  | "E_LIMIT_BYTES"
  | "E_ABORTED"
  | "E_INTERNAL"

export interface SnapshotFailure {
  readonly code: SnapshotErrorCode
  readonly message: string
}

export type SnapshotOutcome = SnapshotSuccess | SnapshotFailure

/** Directory names excluded unless the caller passes its own list. */
export const DEFAULT_EXCLUDE: readonly string[] = ["node_modules", ".git", ".ae"]

export const DEFAULT_LIMITS: SnapshotLimits = { maxFiles: 5000, maxFileBytes: 50 * 1024 * 1024 }

function abortError(): Error {
  const error = new Error("snapshot aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/** Internal control-flow error carrying the typed failure code. */
class LimitError extends Error {
  readonly code: SnapshotErrorCode

  constructor(code: SnapshotErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function isSnapshotFailure(value: SnapshotOutcome): value is SnapshotFailure {
  return (value as SnapshotFailure).code !== undefined
}

/**
 * True when a `/`-separated relative path is excluded. A pattern matches a path
 * segment anywhere (`node_modules`), the whole relative path, or a relative
 * prefix (`lab/tmp`).
 */
export function isExcluded(relativePath: string, exclude: readonly string[]): boolean {
  const segments = relativePath.split("/")
  return exclude.some((pattern) => {
    const clean = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
    if (clean === "") return false
    if (segments.includes(clean)) return true
    if (relativePath === clean) return true
    return relativePath.startsWith(`${clean}/`)
  })
}

/** Sorted `"<relpath>\0<sha256>\n"` lines over the file list. */
export function aggregateLines(files: readonly SnapshotFile[]): string {
  return [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join("")
}

/** `aggregate` of a file list: sha256 of `aggregateLines(files)`. Pure. */
export function aggregateOf(files: readonly SnapshotFile[]): string {
  return createHash("sha256").update(aggregateLines(files), "utf8").digest("hex")
}

async function hashFile(file: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256")
  let bytes = 0
  const stream = createReadStream(file, signal ? { signal } : {})
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      const buffer = chunk as Buffer
      hash.update(buffer)
      bytes += buffer.length
    }
  } catch (error) {
    if (signal?.aborted) throw abortError()
    throw error
  }
  return { sha256: hash.digest("hex"), bytes }
}

export interface SnapshotOptions {
  /** Absolute snapshot root. */
  readonly root: string
  /** Entry names / relative prefixes to skip; defaults to `DEFAULT_EXCLUDE`. */
  readonly exclude?: readonly string[]
  readonly limits?: SnapshotLimits
  readonly signal?: AbortSignal
}

/**
 * Walk `root` and hash every regular file. Symlinks (to files or directories)
 * are skipped: they would make the aggregate depend on the environment. The
 * walk aborts as soon as any limit is exceeded — a truncated snapshot would
 * silently produce a wrong aggregate.
 */
export async function snapshotTree(options: SnapshotOptions): Promise<SnapshotOutcome> {
  const root = options.root
  const exclude = options.exclude ?? DEFAULT_EXCLUDE
  const limits = options.limits ?? DEFAULT_LIMITS
  const signal = options.signal
  try {
    throwIfAborted(signal)
    const rootStat = await stat(root).catch(() => undefined)
    if (rootStat === undefined) return { code: "E_NOT_FOUND", message: `path does not exist: ${root}` }
    if (!rootStat.isDirectory()) return { code: "E_NOT_FOUND", message: `path is not a directory: ${root}` }

    const files: SnapshotFile[] = []
    const visit = async (directory: string, prefix: string): Promise<void> => {
      throwIfAborted(signal)
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const entry of entries) {
        throwIfAborted(signal)
        const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
        if (isExcluded(relativePath, exclude)) continue
        const absolutePath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath)
          continue
        }
        if (!entry.isFile()) continue
        const size = (await stat(absolutePath)).size
        if (size > limits.maxFileBytes) {
          throw new LimitError("E_LIMIT_BYTES", `${relativePath} is ${size} bytes, limit is ${limits.maxFileBytes}`)
        }
        if (files.length >= limits.maxFiles) {
          throw new LimitError("E_LIMIT_FILES", `more than ${limits.maxFiles} files under ${root}`)
        }
        const { sha256, bytes } = await hashFile(absolutePath, signal)
        files.push({ path: relativePath, sha256, bytes })
      }
    }
    await visit(root, "")

    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return { root, files, aggregate: aggregateOf(files) }
  } catch (error) {
    if (error instanceof LimitError) return { code: error.code, message: error.message }
    if (error instanceof Error && error.name === "AbortError") return { code: "E_ABORTED", message: "snapshot aborted" }
    return { code: "E_INTERNAL", message: error instanceof Error ? error.message : String(error) }
  }
}
