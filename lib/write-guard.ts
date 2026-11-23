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
 * - resolve a relative resource against the session's location directory and
 *   strip that prefix; a resource that stays outside the location is denied —
 *   the guard is the workspace boundary, so `reports/`, `docs/planning/` and
 *   `audit-*` are writable only inside it. The location is read from the
 *   session on every event (`session.get`), so a moved session is evaluated
 *   against its new directory; the setup location is only a fallback (used when
 *   the lookup is missing, fails or exceeds its 250 ms bound, with one warning);
 * - normalize separators and collapse `.`/`..`, then walk the segments left to
 *   right and let the first root decide: `reports` → allow (the whole subtree
 *   is an artifact), `docs` + `planning` + a path whose last segment is `.md`
 *   (any depth) → allow, any source root (`src`, `lib`, `test`, `tests`,
 *   `agents`, `tools`, `schemas`, `eval`, `.github`) → deny. `docs` is not part
 *   of that set: its own branch above allows nested `docs/planning/` Markdown
 *   and denies every other `docs/` path;
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

/** Source roots that hold project code or kit content; `docs` has its own branch in `decideSegments`. */
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

/** Upper bound on the per-event session lookup; a hung store must not hold the edit open. */
const SESSION_LOOKUP_TIMEOUT_MS = 250

export type EditDecision = "allow" | "deny"

/** Case-fold one segment the way the host resolves paths on `platform`. */
function fold(segment: string, platform: string): string {
  return platform === "win32" ? segment.toLowerCase() : segment
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
function stripLocation(
  absolute: readonly string[],
  location: readonly string[],
  platform: string,
): string[] | undefined {
  if (location.length === 0 || location.length > absolute.length) return undefined
  for (let index = 0; index < location.length; index += 1) {
    if (fold(absolute[index]!, platform) !== fold(location[index]!, platform)) return undefined
  }
  return absolute.slice(location.length)
}

/** `reports/` and `docs/planning/` already allow earlier; roots and files are checked here. */
function artifactLocation(segments: readonly string[], platform: string): boolean {
  if (segments.length === 1) return true
  return segments.slice(0, -1).some((segment) => AUDIT_DIR.test(fold(segment, platform)))
}

function decideSegments(segments: readonly string[], platform: string): EditDecision {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    const key = fold(segment, platform)
    if (key === ARTIFACT_DIR) return "allow"
    // `docs` is not part of SOURCE_ROOTS: this branch allows nested planning
    // Markdown and denies every other `docs/` path.
    if (key === "docs") {
      const next = segments[index + 1]
      const last = segments.at(-1)
      if (
        next !== undefined &&
        fold(next, platform) === "planning" &&
        last !== undefined &&
        MARKDOWN_FILE.test(fold(last, platform))
      ) {
        return "allow"
      }
      return "deny"
    }
    if (SOURCE_ROOTS.has(key)) return "deny"
  }
  const last = segments.at(-1)
  if (last !== undefined && ARTIFACT_FILE.test(fold(last, platform)) && artifactLocation(segments, platform)) {
    return "allow"
  }
  return "deny"
}

/**
 * Decide whether the root orchestrator may write `resource` in `locationDirectory`.
 *
 * A relative resource is resolved against the location directory; an absolute one
 * is used as is. The path is then reduced to its relative form: anything that stays
 * outside the location is denied (the location is the workspace boundary), and an
 * inside path is decided by its first segment.
 */
export function decideEdit(
  resource: string,
  locationDirectory: string,
  platform: string = process.platform,
): EditDecision {
  const location = normalizeSegments(locationDirectory)
  const raw = resource.replaceAll("\\", "/")
  const resolved = isAbsolute(raw) ? normalizeSegments(raw) : normalizeSegments(`${location.join("/")}/${raw}`)
  const relative = stripLocation(resolved, location, platform)
  if (relative === undefined) return "deny"
  return decideSegments(relative, platform)
}

export interface WriteGuardOptions {
  /** Directory the session belongs to; relative resources resolve against it. */
  readonly locationDirectory: string
  /** Reports a missing host API or a registration failure (the guard stays no-op). */
  readonly warn: (message: string) => void
  /**
   * Observer called for every `edit` evaluation of every agent **after** the
   * guard decided, with the final effect. The protocol guard uses it to count
   * source writes; it never changes the guard's own decision, and a throwing
   * observer is reported once and ignored.
   */
  readonly onEvaluate?: (event: WriteGuardEvaluation) => void
}

/** One edit evaluation as seen by the observer (final effect included). */
export interface WriteGuardEvaluation {
  readonly sessionID?: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly effect: "allow" | "deny" | "ask"
}

export interface WriteGuard {
  /** `true` when the permission hook is registered. */
  readonly available: boolean
  /** Disposes the hook registration; safe to call when the guard is unavailable. */
  readonly cleanup: () => Promise<void>
}

/** The evaluate event fields the guard reads and writes (the host type is structural). */
interface EvaluateEvent {
  readonly sessionID?: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  effect: "allow" | "deny" | "ask"
  message?: string
}

/** The session surface the guard reads the current location from (structural). */
interface SessionDirectoryApi {
  readonly get?: (input: { readonly sessionID: string }) => Promise<unknown>
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
  const session = (ctx as { readonly session?: SessionDirectoryApi }).session
  // A failing, missing or hanging `session.get` falls back to the setup location;
  // the warning is emitted once per guard so a persistent failure cannot flood
  // the log on every edit (the single flag is deliberate — no counter, no reset).
  let sessionWarned = false
  const warnSessionOnce = (message: string): void => {
    if (sessionWarned) return
    sessionWarned = true
    options.warn(message)
  }
  const locationFor = async (sessionID: string | undefined): Promise<string> => {
    if (typeof session?.get !== "function") {
      warnSessionOnce("write guard: ctx.session.get is unavailable, using the setup location")
      return options.locationDirectory
    }
    if (sessionID === undefined) return options.locationDirectory
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The lookup is bounded: a hung session store must not hold the permission
      // event open (fail-open covers a rejection, not a promise that never settles).
      const lookup = session.get({ sessionID })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${SESSION_LOOKUP_TIMEOUT_MS} ms`))
        }, SESSION_LOOKUP_TIMEOUT_MS)
      })
      const info = (await Promise.race([lookup, timeout])) as
        | { readonly location?: { readonly directory?: unknown } }
        | undefined
      const directory = info?.location?.directory
      if (typeof directory === "string" && directory !== "") return directory
      warnSessionOnce("write guard: the session reports no location directory, using the setup location")
      return options.locationDirectory
    } catch (error) {
      // Fail-open: an unreadable session must not break (or disable) the guard.
      warnSessionOnce(
        `write guard: cannot read the session directory, using the setup location: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return options.locationDirectory
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  try {
    // A throwing observer must not influence the guard: it is reported once and
    // ignored, exactly like a host API failure.
    let observerWarned = false
    const notify = (event: EvaluateEvent): void => {
      const observer = options.onEvaluate
      if (observer === undefined) return
      try {
        observer({
          ...(event.sessionID === undefined ? {} : { sessionID: event.sessionID }),
          ...(event.agent === undefined ? {} : { agent: event.agent }),
          action: event.action,
          resources: [...event.resources],
          effect: event.effect,
        })
      } catch (error) {
        if (observerWarned) return
        observerWarned = true
        options.warn(`write guard: the edit observer failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const registration = await permission.hook("evaluate", async (event: EvaluateEvent) => {
      try {
        if (event.action !== "edit") return
        if (event.agent === "orchestrator" && event.effect !== "deny") {
          // The session may have been moved since setup: the host resolves the
          // resource against the session's current directory, so the guard must too.
          const locationDirectory = await locationFor(event.sessionID)
          const denied = event.resources.some((resource) => decideEdit(resource, locationDirectory) === "deny")
          if (denied) {
            event.effect = "deny"
            event.message = WRITE_GUARD_MESSAGE
          }
        }
        // Every edit of every agent, after the decision: the protocol guard counts
        // source writes made by fix-runner/build/general too.
        notify(event)
      } catch (error) {
        // Fail-open: a broken guard must never break the session it protects.
        options.warn(`write guard: evaluation failed: ${error instanceof Error ? error.message : String(error)}`)
        // The observer still sees the final (unchanged) effect of this edit.
        if (event.action === "edit") notify(event)
      }
    })
    let disposed = false
    return {
      available: true,
      cleanup: async () => {
        // Idempotent: a repeated cleanup must not dispose the registration twice.
        if (disposed) return
        disposed = true
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
