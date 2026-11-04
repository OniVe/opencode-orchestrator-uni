/**
 * write-guard — path-root enforcement for the root orchestrator's edits.
 *
 * Flat `permissions` are a last-match-wins list, so they cannot express two
 * properties at once: `reports/` is an artifact subtree (even `reports/src/x`
 * must stay writable) while `src/`, `docs/` and the other source roots are
 * denied at their first segment (even under an artifact-looking name such as
 * `src/reports/x`). The rules also cannot tell a root artifact file
 * (`state.md`) from a source file of the same name (`app/state.md`).
 *
 * This module implements the intended contract as a permission hook:
 *
 * - normalize separators and collapse `.`/`..`; resolve a relative resource
 *   against the location directory and strip the location prefix when the
 *   result stays inside it;
 * - walk the segments left to right and let the first root decide:
 *   `reports` → allow (the whole subtree is an artifact), `docs` + `planning` +
 *   a `.md` file → allow, any source root (`src`, `lib`, `test`, `tests`,
 *   `agents`, `tools`, `schemas`, `eval`, `.github`, `docs`) → deny;
 * - with no root in the path, an artifact file (`case-*`, `risks-*`,
 *   `handoff-*`, `decisions-*`, `state.md`) is allowed only in the location
 *   root, under `reports/`, under `docs/planning/`, or inside an `audit-*`
 *   directory;
 * - everything else is denied.
 *
 * The hook only tightens an `edit` evaluation for the `orchestrator` agent: it
 * runs after the flat rules, so a local `edit: allow *` on the agent (a config
 * or a Markdown override) cannot bypass the guard. A failure anywhere in the
 * guard is fail-open — a broken guard must never break the session.
 */
import type { Plugin } from "@opencode/plugin"

/** Source roots that hold project code, docs or kit content. */
const SOURCE_ROOTS: ReadonlySet<string> = new Set([
  "src",
  "lib",
  "test",
  "tests",
  "agents",
  "tools",
  "schemas",
  "eval",
  ".github",
  "docs",
])

/** Reserved artifact subtree: everything below it is an audit/state artifact. */
const ARTIFACT_DIR = "reports"

/** Artifact files allowed only in an artifact location (see `artifactLocation`). */
const ARTIFACT_FILE = /^(?:case-.*|risks-.*|handoff-.*|decisions-.*|state)\.md$/

/** Ad-hoc audit workspace directory; any depth below it is an artifact location. */
const AUDIT_DIR = /^audit-/

const MARKDOWN_FILE = /\.md$/

/** Message attached to a denied evaluation; also shown to the model. */
export const WRITE_GUARD_MESSAGE = "root orchestrator may edit only audit/session-state artifacts"

export type EditDecision = "allow" | "deny"

/** Case-fold one segment the way the host resolves paths on this platform. */
function fold(segment: string): string {
  return process.platform === "win32" ? segment.toLowerCase() : segment
}

/** Split a path into segments, collapsing `.`/`..` and unifying separators. */
function normalizeSegments(input: string): string[] {
  const segments: string[] = []
  for (const part of input.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments
}

/** Whether a resource names an absolute path (POSIX root or a Windows drive). */
function isAbsolute(resource: string): boolean {
  const normalized = resource.replaceAll("\\", "/")
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
}

/** Drop the location prefix when `absolute` is inside it; `undefined` otherwise. */
function stripLocation(absolute: readonly string[], location: readonly string[]): string[] | undefined {
  if (location.length === 0 || location.length > absolute.length) return undefined
  for (let index = 0; index < location.length; index += 1) {
    if (fold(absolute[index]!) !== fold(location[index]!)) return undefined
  }
  return absolute.slice(location.length)
}

/** `reports/` and `docs/planning/` already allow earlier; roots and files are checked here. */
function artifactLocation(segments: readonly string[], insideLocation: boolean): boolean {
  if (insideLocation && segments.length === 1) return true
  return segments.slice(0, -1).some((segment) => AUDIT_DIR.test(fold(segment)))
}

function decideSegments(segments: readonly string[], insideLocation: boolean): EditDecision {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    const key = fold(segment)
    if (key === ARTIFACT_DIR) return "allow"
    if (key === "docs") {
      const next = segments[index + 1]
      const file = segments[index + 2]
      if (
        next !== undefined &&
        fold(next) === "planning" &&
        file !== undefined &&
        index + 2 === segments.length - 1 &&
        MARKDOWN_FILE.test(fold(file))
      ) {
        return "allow"
      }
      return "deny"
    }
    if (SOURCE_ROOTS.has(key)) return "deny"
  }
  const last = segments.at(-1)
  if (last !== undefined && ARTIFACT_FILE.test(fold(last)) && artifactLocation(segments, insideLocation)) {
    return "allow"
  }
  return "deny"
}

/**
 * Decide whether the root orchestrator may write `resource` in `locationDirectory`.
 *
 * A relative resource is resolved against the location directory; an absolute one
 * is used as is. A path inside the location is reduced to its relative form first,
 * so the first segment is the actual root the resource belongs to.
 */
export function decideEdit(resource: string, locationDirectory: string): EditDecision {
  const location = normalizeSegments(locationDirectory)
  const raw = resource.replaceAll("\\", "/")
  const absolute = isAbsolute(raw)
  const resolved = absolute ? normalizeSegments(raw) : normalizeSegments(`${location.join("/")}/${raw}`)
  const relative = stripLocation(resolved, location)
  if (relative !== undefined) return decideSegments(relative, true)
  return decideSegments(resolved, false)
}

export interface WriteGuardOptions {
  /** Directory the session belongs to; relative resources resolve against it. */
  readonly locationDirectory: string
  /** Reports a missing host API or a registration failure (the guard stays no-op). */
  readonly warn: (message: string) => void
}

export interface WriteGuard {
  /** `true` when the permission hook is registered. */
  readonly available: boolean
  /** Disposes the hook registration; safe to call when the guard is unavailable. */
  readonly cleanup: () => Promise<void>
}

/** The evaluate event fields the guard reads and writes (the host type is structural). */
interface EvaluateEvent {
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  effect: "allow" | "deny" | "ask"
  message?: string
}

/**
 * Register the path-root write guard on the host's permission hook.
 * Never throws: an unavailable or failing host API leaves the guard as a no-op.
 */
export async function createWriteGuard(ctx: Plugin.Context, options: WriteGuardOptions): Promise<WriteGuard> {
  const noop = async () => {}
  const permission = (ctx as { readonly permission?: Plugin.Context["permission"] }).permission
  if (permission === undefined || typeof permission.hook !== "function") {
    options.warn("write guard: ctx.permission.hook is unavailable; the path-root guard is not registered")
    return { available: false, cleanup: noop }
  }
  try {
    const registration = await permission.hook("evaluate", (event: EvaluateEvent) => {
      try {
        if (event.agent !== "orchestrator" || event.action !== "edit" || event.effect === "deny") return
        const denied = event.resources.some((resource) => decideEdit(resource, options.locationDirectory) === "deny")
        if (!denied) return
        event.effect = "deny"
        event.message = WRITE_GUARD_MESSAGE
      } catch (error) {
        // Fail-open: a broken guard must never break the session it protects.
        options.warn(`write guard: evaluation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return {
      available: true,
      cleanup: async () => {
        await registration.dispose()
      },
    }
  } catch (error) {
    options.warn(
      `write guard: cannot register the permission hook: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { available: false, cleanup: noop }
  }
}
