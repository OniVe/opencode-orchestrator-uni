/**
 * Protocol guard: the loop metric (`none|audit|audit+fix`), source-write
 * attribution through the write guard's observer, the root artifact gate, the
 * one-shot context warning, journal/metadata facts and the fail-open paths.
 *
 * The harness mimics the V2 host surface the guard uses: a push-driven
 * `ctx.event.subscribe`, `session.hook("context")`, `session.get`/`update` and
 * the setup location. Files for the artifact gate live in a real temp directory
 * (shallow `readdir`, so a real filesystem is the point).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { EventJournal } from "../lib/event-journal"
import {
  createProtocolGuard,
  DEFAULT_PROTOCOL_GUARD,
  loopWarningText,
  normalizeAgent,
  type ProtocolGuard,
  type ProtocolGuardConfig,
  readProtocolGuardOptions,
} from "../lib/protocol-guard"
import { createHarness, memoryStorage, runTool } from "./support/harness"

const directories: string[] = []
const guards: ProtocolGuard[] = []

afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.cleanup()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** Push-driven async iterable: `consumed` moves after the handler finished the event. */
class EventStream {
  private readonly queue: unknown[] = []
  private waiting: ((value: IteratorResult<unknown>) => void) | null = null
  private closed = false
  pushed = 0
  consumed = 0

  push(event: unknown): void {
    this.pushed += 1
    const waiting = this.waiting
    if (waiting !== null) {
      this.waiting = null
      waiting({ value: event, done: false })
      return
    }
    this.queue.push(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiting !== null) {
      const waiting = this.waiting
      this.waiting = null
      waiting({ value: undefined, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.closed || this.queue.length > 0) {
      const next: IteratorResult<unknown> =
        this.queue.length > 0
          ? { value: this.queue.shift(), done: false }
          : await new Promise<IteratorResult<unknown>>((resolve) => {
              this.waiting = resolve
            })
      if (next.done === true) return
      yield next.value
      // The consumer has finished handling the yielded event by the time it asks
      // for the next one; that makes `drain` a real barrier.
      this.consumed += 1
    }
  }
}

interface HarnessOptions {
  readonly config?: Partial<ProtocolGuardConfig>
  readonly locale?: "en" | "ru"
  readonly events?: boolean
  readonly contextHook?: boolean
  readonly omitGet?: boolean
  readonly omitUpdate?: boolean
  readonly getThrows?: boolean
  readonly updateThrows?: boolean
  readonly updateHangs?: boolean
  readonly journal?: boolean
  readonly existingMetadata?: Record<string, unknown>
  /** Override the setup location and the location returned by `session.get`. */
  readonly locationDirectory?: string
  /** Extra `session.get` fields by session id (parentID/agent). */
  readonly sessionInfo?: Record<string, { readonly parentID?: string; readonly agent?: string }>
}

interface SessionHarness {
  readonly directory: string
  readonly sessionID: string
  readonly guard: ProtocolGuard
  readonly journal: EventJournal | undefined
  readonly warnings: string[]
  readonly updates: { readonly sessionID: string; readonly metadata: Record<string, unknown> }[]
  readonly contextInputs: string[]
  readonly signals: AbortSignal[]
  readonly disposed: () => number
  push(event: unknown): Promise<void>
  context(sessionID: string): Promise<string[]>
  dispose(): Promise<void>
}

function created(
  sessionID: string,
  options: {
    readonly parentID?: string
    readonly agent?: string
    readonly created?: number
    readonly directory?: string
  } = {},
): unknown {
  return {
    id: `ev-created-${sessionID}-${options.created ?? 0}`,
    type: "session.created",
    created: options.created ?? 100,
    data: {
      sessionID,
      ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
      // A parentless test session defaults to the orchestrator: P1 classifies
      // only the orchestrator root.
      ...(options.agent === undefined && options.parentID !== undefined
        ? {}
        : { agent: options.agent ?? "orchestrator" }),
      location: { directory: options.directory ?? "" },
    },
  }
}

let terminalCounter = 0
function terminal(sessionID: string, type = "session.idle"): unknown {
  terminalCounter += 1
  return { id: `ev-terminal-${terminalCounter}`, type, created: Date.now(), data: { sessionID } }
}

async function setup(options: HarnessOptions = {}): Promise<SessionHarness> {
  const directory = await mkdtemp(path.join(tmpdir(), "protocol-guard-"))
  directories.push(directory)
  const locationDirectory = options.locationDirectory ?? directory
  const stream = new EventStream()
  const warnings: string[] = []
  const updates: { sessionID: string; metadata: Record<string, unknown> }[] = []
  const contextHooks: ((input: unknown) => Promise<void> | void)[] = []
  const contextInputs: string[] = []
  const signals: AbortSignal[] = []
  let updateDisposals = 0
  const store = new Map<string, { metadata?: Record<string, unknown> }>()
  if (options.existingMetadata !== undefined) {
    store.set("ses_root", { metadata: options.existingMetadata })
  }
  const journal = options.journal === true ? new EventJournal(memoryStorage(new Map())) : undefined

  const session: Record<string, unknown> = {}
  if (options.contextHook !== false) {
    session.hook = async (_name: string, callback: (input: unknown) => Promise<void> | void) => {
      contextHooks.push(callback)
      return {
        dispose: async () => {
          updateDisposals += 1
        },
      }
    }
  }
  if (options.omitGet !== true) {
    session.get = async (input: { sessionID: string }) => {
      if (options.getThrows === true) throw new Error("session store offline")
      const record = store.get(input.sessionID)
      const info = options.sessionInfo?.[input.sessionID]
      return {
        id: input.sessionID,
        location: { directory: locationDirectory },
        ...(info?.parentID === undefined ? {} : { parentID: info.parentID }),
        ...(info?.agent === undefined ? {} : { agent: info.agent }),
        ...(record?.metadata === undefined ? {} : { metadata: record.metadata }),
      }
    }
  }
  if (options.omitUpdate !== true) {
    session.update = async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
      if (options.updateThrows === true) throw new Error("metadata store offline")
      if (options.updateHangs === true) return new Promise<void>(() => {})
      updates.push({ sessionID: input.sessionID, metadata: input.metadata })
      store.set(input.sessionID, { metadata: input.metadata })
    }
  }

  const ctx: Record<string, unknown> = {
    location: { directory: locationDirectory },
    session,
    storage: memoryStorage(new Map()),
  }
  if (options.events !== false) {
    ctx.event = {
      subscribe: (requestOptions?: { signal?: AbortSignal }) => {
        const signal = requestOptions?.signal
        if (signal !== undefined) {
          signals.push(signal)
          signal.addEventListener("abort", () => stream.close(), { once: true })
        }
        return stream
      },
    }
  }

  const guard = await createProtocolGuard(
    ctx as unknown as Plugin.Context,
    { ...DEFAULT_PROTOCOL_GUARD, ...options.config },
    options.locale ?? "en",
    (message) => warnings.push(message),
    journal === undefined ? {} : { journal },
  )
  guards.push(guard)

  const drain = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (stream.consumed === stream.pushed) {
        for (let tick = 0; tick < 6; tick += 1) await Promise.resolve()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error("event drain timed out")
  }

  return {
    directory,
    sessionID: "ses_root",
    guard,
    journal,
    warnings,
    updates,
    contextInputs,
    signals,
    disposed: () => updateDisposals,
    push: async (event) => {
      stream.push(event)
      await drain()
    },
    context: async (sessionID) => {
      contextInputs.push(sessionID)
      const system: { type: "text"; text: string }[] = []
      for (const hook of contextHooks) await hook({ sessionID, system, messages: [] })
      return system.map((part) => part.text)
    },
    dispose: async () => {
      await guard.cleanup()
    },
  }
}

/** A full audit pair and a fix-runner created after the first auditor. */
async function createAuditLoop(harness: SessionHarness, root = harness.sessionID): Promise<void> {
  await harness.push(created(root, { created: 100 }))
  await harness.push(created(`${root}_empiric`, { parentID: root, agent: "empiric", created: 200 }))
  await harness.push(created(`${root}_invariant`, { parentID: root, agent: "invariant", created: 210 }))
  await harness.push(created(`${root}_fix`, { parentID: root, agent: "fix-runner", created: 300 }))
}

describe("protocol guard: loop metric", () => {
  test("classifies a root with no children as none and writes nothing", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID))
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.loop).toBe("none")
    expect((await harness.guard.snapshot(harness.sessionID))?.writes).toBe(0)
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("a source write without the pair warns exactly once on the next context", async () => {
    const harness = await setup({ config: { artifactWarnings: false }, journal: true })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      agent: "fix-runner",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    const snapshot = await harness.guard.snapshot(harness.sessionID)
    expect(snapshot).toMatchObject({ loop: "none", writes: 1, warnedLoop: false })

    const first = await harness.context(harness.sessionID)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain("Protocol:")
    expect((await harness.guard.snapshot(harness.sessionID))?.warnedLoop).toBe(true)
    const events = (await harness.journal?.read(harness.sessionID))?.events ?? []
    const lastLoop = events.filter((event) => event.kind === "loop").at(-1)
    expect(lastLoop).toMatchObject({ loop: "none", writes: 1, warning: true })
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("pair + fix-runner produced after the first audit is audit+fix (no warning)", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await createAuditLoop(harness)
    harness.guard.recordWrite({
      sessionID: `${harness.sessionID}_fix`,
      agent: "fix-runner",
      action: "edit",
      resources: ["lib/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    const snapshot = await harness.guard.snapshot(harness.sessionID)
    expect(snapshot).toMatchObject({
      loop: "audit+fix",
      writes: 1,
      audits: 2,
      pair: true,
      fix: true,
    })
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("a pair without fix-runner stays audit and warns", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID, { created: 100 }))
    await harness.push(created("ses_empiric", { parentID: harness.sessionID, agent: "empiric", created: 200 }))
    await harness.push(created("ses_invariant", { parentID: harness.sessionID, agent: "invariant", created: 200 }))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      agent: "fix-runner",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.loop).toBe("audit")
    const system = await harness.context(harness.sessionID)
    expect(system).toHaveLength(1)
    expect(system[0]).toContain("full loop")
  })

  test("a fix-runner created before the first audit does not count as fix", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID, { created: 100 }))
    await harness.push(created("ses_fix", { parentID: harness.sessionID, agent: "fix-runner", created: 150 }))
    await harness.push(created("ses_empiric", { parentID: harness.sessionID, agent: "empiric", created: 200 }))
    await harness.push(created("ses_invariant", { parentID: harness.sessionID, agent: "invariant", created: 200 }))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.fix).toBe(false)
    expect((await harness.guard.snapshot(harness.sessionID))?.loop).toBe("audit")
  })

  test("legacy audit-* agent ids and the -d suffix normalize", async () => {
    expect(normalizeAgent("audit-empiric")).toBe("empiric")
    expect(normalizeAgent("audit-invariant-d")).toBe("invariant")
    expect(normalizeAgent("fix-runner")).toBe("fix-runner")
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID, { created: 100 }))
    await harness.push(created("ses_e", { parentID: harness.sessionID, agent: "audit-empiric", created: 200 }))
    await harness.push(created("ses_i", { parentID: harness.sessionID, agent: "audit-invariant-d", created: 200 }))
    await harness.push(created("ses_f", { parentID: harness.sessionID, agent: "audit-fix-runner", created: 300 }))
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.loop).toBe("audit+fix")
  })

  test("denied, artifact and already-denied orchestrator edits are not writes", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "deny",
    })
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["reports/x.md", "state.md"],
      effect: "allow",
    })
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      agent: "orchestrator",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "deny",
    })
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "shell",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.writes).toBe(0)
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("writes of every descendant are summed by the parent chain", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID, { created: 100 }))
    await harness.push(created("ses_child", { parentID: harness.sessionID, agent: "general", created: 200 }))
    await harness.push(created("ses_grandchild", { parentID: "ses_child", agent: "general", created: 300 }))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/a.ts"],
      effect: "allow",
    })
    harness.guard.recordWrite({ sessionID: "ses_child", action: "edit", resources: ["src/b.ts"], effect: "allow" })
    harness.guard.recordWrite({
      sessionID: "ses_grandchild",
      action: "edit",
      resources: ["src/c.ts", "lib/d.ts"],
      effect: "allow",
    })
    harness.guard.recordWrite({ sessionID: "ses_child", action: "edit", resources: ["src/e.ts"], effect: "deny" })
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.writes).toBe(4)
  })

  test("repeated idle and a durable terminal event do not duplicate the warning", async () => {
    const harness = await setup({ config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    await harness.push(terminal(harness.sessionID, "session.execution.succeeded"))
    expect(await harness.context(harness.sessionID)).toHaveLength(1)
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("a child terminal event does not classify the root or check artifacts", async () => {
    const harness = await setup({ config: { requirePair: false } })
    await createAuditLoop(harness)
    harness.guard.recordWrite({
      sessionID: `${harness.sessionID}_fix`,
      agent: "fix-runner",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(`${harness.sessionID}_fix`))
    // No root idle yet: nothing classified, and in particular no artifact warning.
    expect(await harness.guard.snapshot(harness.sessionID)).toBeUndefined()
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("only orchestrator roots classify: a build root is ignored", async () => {
    const build = await setup({ config: { artifactWarnings: false }, journal: true })
    await build.push(created("ses_build", { agent: "build" }))
    build.guard.recordWrite({
      sessionID: "ses_build",
      agent: "build",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await build.push(terminal("ses_build"))
    expect(await build.guard.snapshot("ses_build")).toBeUndefined()
    expect(await build.context("ses_build")).toEqual([])
    expect(build.updates).toEqual([])
    expect((await build.journal?.read("ses_build"))?.available).toBe(false)

    const orchestrator = await setup({ config: { artifactWarnings: false } })
    await orchestrator.push(created(orchestrator.sessionID))
    orchestrator.guard.recordWrite({
      sessionID: orchestrator.sessionID,
      agent: "fix-runner",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await orchestrator.push(terminal(orchestrator.sessionID))
    expect((await orchestrator.guard.snapshot(orchestrator.sessionID))?.writes).toBe(1)
    expect(await orchestrator.context(orchestrator.sessionID)).toHaveLength(1)
  })

  test("an unknown root agent is resolved through session.get", async () => {
    const harness = await setup({
      config: { artifactWarnings: false },
      sessionInfo: { ses_root: { agent: "orchestrator" } },
    })
    await harness.push(created(harness.sessionID, { agent: "" }))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.loop).toBe("none")
    expect(await harness.context(harness.sessionID)).toHaveLength(1)
  })

  test("a terminal for an unknown child resolves parentID and does not classify", async () => {
    const harness = await setup({
      config: { artifactWarnings: false },
      journal: true,
      sessionInfo: { ses_lost_child: { parentID: "ses_root", agent: "general" } },
    })
    harness.guard.recordWrite({
      sessionID: "ses_lost_child",
      agent: "general",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal("ses_lost_child"))
    expect(await harness.guard.snapshot("ses_root")).toBeUndefined()
    expect(await harness.context("ses_root")).toEqual([])
    expect(harness.updates).toEqual([])
    expect((await harness.journal?.read("ses_root"))?.available).toBe(false)
  })

  test("an empty setup location does not count reports/ as a source write", async () => {
    const harness = await setup({ config: { artifactWarnings: false }, locationDirectory: "" })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["reports/x.md"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.writes).toBe(0)
  })

  test("requirePair:false accepts the pair without fix-runner", async () => {
    const harness = await setup({ config: { requirePair: false, artifactWarnings: false } })
    await harness.push(created(harness.sessionID, { created: 100 }))
    await harness.push(created("ses_empiric", { parentID: harness.sessionID, agent: "empiric", created: 200 }))
    await harness.push(created("ses_invariant", { parentID: harness.sessionID, agent: "invariant", created: 200 }))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect(await harness.context(harness.sessionID)).toEqual([])
  })
})

describe("protocol guard: artifact gate", () => {
  /** Pair+fix so the loop warning never mixes into an artifact assertion. */
  async function artifactHarness(options: HarnessOptions = {}): Promise<SessionHarness> {
    const harness = await setup({ config: { requirePair: false }, ...options })
    await createAuditLoop(harness)
    harness.guard.recordWrite({
      sessionID: `${harness.sessionID}_fix`,
      agent: "fix-runner",
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    return harness
  }

  test("root idle with writes and no artifacts warns once", async () => {
    const harness = await artifactHarness()
    await harness.push(terminal(harness.sessionID))
    const system = await harness.context(harness.sessionID)
    expect(system).toHaveLength(1)
    expect(system[0]).toContain("no handoff/state artifact")
    expect(await harness.context(harness.sessionID)).toEqual([])
    expect((await harness.guard.snapshot(harness.sessionID))?.warnedArtifacts).toBe(true)
  })

  test("a handoff in the location root satisfies the gate", async () => {
    const harness = await artifactHarness()
    await writeFile(path.join(harness.directory, "handoff-2026-11-23.md"), "# handoff\n")
    await harness.push(terminal(harness.sessionID))
    expect(await harness.context(harness.sessionID)).toEqual([])
    expect((await harness.guard.snapshot(harness.sessionID))?.handoff).toBe(true)
  })

  test("a state file in docs/planning satisfies the gate", async () => {
    const harness = await artifactHarness()
    await mkdir(path.join(harness.directory, "docs", "planning"), { recursive: true })
    await writeFile(path.join(harness.directory, "docs", "planning", "state.md"), "# state\n")
    await harness.push(terminal(harness.sessionID))
    expect(await harness.context(harness.sessionID)).toEqual([])
    expect((await harness.guard.snapshot(harness.sessionID))?.state).toBe(true)
  })

  test("a top-level report satisfies the gate", async () => {
    const harness = await artifactHarness()
    await mkdir(path.join(harness.directory, "reports"), { recursive: true })
    await writeFile(path.join(harness.directory, "reports", "meta.md"), "# report\n")
    await harness.push(terminal(harness.sessionID))
    expect(await harness.context(harness.sessionID)).toEqual([])
    expect((await harness.guard.snapshot(harness.sessionID))?.reports).toBe(1)
  })

  test("a non-Markdown or nested report does not count", async () => {
    const harness = await artifactHarness()
    await mkdir(path.join(harness.directory, "reports", "nested"), { recursive: true })
    await writeFile(path.join(harness.directory, "reports", "data.json"), "{}")
    await writeFile(path.join(harness.directory, "reports", "nested", "deep.md"), "# deep\n")
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.reports).toBe(0)
    expect(await harness.context(harness.sessionID)).toHaveLength(1)
  })

  test("a symlink named like a report is not a file and is skipped", async () => {
    const harness = await artifactHarness()
    const target = path.join(harness.directory, "real-target.md")
    await writeFile(target, "# target\n")
    await mkdir(path.join(harness.directory, "reports"), { recursive: true })
    try {
      await symlink(target, path.join(harness.directory, "reports", "link.md"), "file")
    } catch {
      // Windows without symlink privilege: the ENOENT case below covers the same path.
      return
    }
    await harness.push(terminal(harness.sessionID))
    expect((await harness.guard.snapshot(harness.sessionID))?.reports).toBe(0)
    expect(await harness.context(harness.sessionID)).toHaveLength(1)
  })

  test("ENOENT directories are empty, not an error", async () => {
    const harness = await artifactHarness()
    await harness.push(terminal(harness.sessionID))
    expect(harness.warnings).toEqual([])
    expect(await harness.context(harness.sessionID)).toHaveLength(1)
  })

  test("a truncated listing never fabricates a warning", async () => {
    const harness = await artifactHarness({ config: { requirePair: false, maxArtifactEntries: 1 } })
    // Sorted: "a.md" is kept, the handoff is beyond the cap.
    await writeFile(path.join(harness.directory, "a.md"), "# a\n")
    await writeFile(path.join(harness.directory, "handoff-late.md"), "# handoff\n")
    await harness.push(terminal(harness.sessionID))
    const snapshot = await harness.guard.snapshot(harness.sessionID)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.handoff).toBe(false)
    expect(await harness.context(harness.sessionID)).toEqual([])
  })

  test("an artifact that appears before delivery cancels the pending warning", async () => {
    const harness = await artifactHarness()
    await harness.push(terminal(harness.sessionID))
    await writeFile(path.join(harness.directory, "state.md"), "# state\n")
    expect(await harness.context(harness.sessionID)).toEqual([])
    expect(
      (await harness.guard.snapshot(harness.sessionID))?.handoff ||
        (await harness.guard.snapshot(harness.sessionID))?.state,
    ).toBe(true)
  })

  test("writes below an artifact/audit-only session skip the gate", async () => {
    const harness = await setup()
    await harness.push(created(harness.sessionID))
    await harness.push(terminal(harness.sessionID))
    expect(await harness.context(harness.sessionID)).toEqual([])
  })
})

describe("protocol guard: journal, metadata and options", () => {
  test("journal gets loop and artifact events without file names or paths", async () => {
    const harness = await setup({ journal: true, config: { requirePair: false } })
    await createAuditLoop(harness)
    harness.guard.recordWrite({
      sessionID: `${harness.sessionID}_fix`,
      agent: "fix-runner",
      action: "edit",
      resources: ["src/secret-name.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    await harness.context(harness.sessionID)
    const snapshot = await harness.journal?.read(harness.sessionID)
    expect(snapshot?.available).toBe(true)
    const kinds = snapshot?.events.map((event) => event.kind) ?? []
    expect(kinds).toContain("loop")
    expect(kinds).toContain("artifact")
    const loops = snapshot?.events.filter((event) => event.kind === "loop") ?? []
    // requirePair:false accepts audit+fix, so the loop condition is satisfied and
    // only the artifact warning is delivered.
    expect(loops.at(-1)).toMatchObject({
      loop: "audit+fix",
      writes: 1,
      audits: 2,
      pair: true,
      fix: true,
      warning: false,
    })
    const artifacts = snapshot?.events.filter((event) => event.kind === "artifact") ?? []
    expect(artifacts.at(-1)).toMatchObject({ handoff: false, state: false, reports: 0, warning: true })
    const stored = JSON.stringify([...snapshot!.events])
    expect(stored).not.toContain("secret-name")
    expect(stored).not.toContain(harness.directory)
  })

  test("metadata merges the snapshot under orchestrator.uni and keeps existing keys", async () => {
    const harness = await setup({ existingMetadata: { owner: "kit" } })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    const update = harness.updates.at(-1)
    expect(update?.sessionID).toBe(harness.sessionID)
    expect(update?.metadata.owner).toBe("kit")
    expect(update?.metadata["orchestrator.uni"]).toMatchObject({
      loop: "none",
      writes: 1,
      audits: 0,
      pair: false,
      fix: false,
      handoff: false,
      state: false,
      reports: 0,
      warnedLoop: false,
      warnedArtifacts: false,
    })
    expect(JSON.stringify(update?.metadata)).not.toContain(harness.directory)
  })

  test("a hanging session.update is bounded: cleanup returns and the journal stays", async () => {
    const harness = await setup({ updateHangs: true, journal: true })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    const classifyStarted = Date.now()
    await harness.push(terminal(harness.sessionID))
    expect(Date.now() - classifyStarted).toBeLessThan(2000)
    expect(await harness.guard.snapshot(harness.sessionID)).toBeDefined()
    const started = Date.now()
    await harness.dispose()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(harness.warnings.filter((line) => line.includes("metadata")).length).toBe(1)
    const events = (await harness.journal?.read(harness.sessionID))?.events ?? []
    expect(events.some((event) => event.kind === "loop")).toBe(true)
  })

  test("session.update throwing is fail-open and warned once", async () => {
    const harness = await setup({ updateThrows: true, config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID))
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    await harness.push(terminal(harness.sessionID))
    expect(harness.warnings.filter((line) => line.includes("metadata")).length).toBe(1)
    expect((await harness.guard.snapshot(harness.sessionID))?.loop).toBe("none")
  })

  test("a host without session.update keeps the journal snapshot", async () => {
    const harness = await setup({ omitUpdate: true, config: { artifactWarnings: false } })
    await harness.push(created(harness.sessionID))
    await harness.push(terminal(harness.sessionID))
    expect(harness.warnings.filter((line) => line.includes("session.update")).length).toBe(1)
    expect(await harness.guard.snapshot(harness.sessionID)).toBeDefined()
  })

  test("disabled config registers nothing and records nothing", async () => {
    const harness = await setup({ config: { enabled: false } })
    expect(harness.guard.available).toBe(false)
    expect(harness.contextInputs).toEqual([])
    expect(harness.signals).toEqual([])
    harness.guard.recordWrite({
      sessionID: harness.sessionID,
      action: "edit",
      resources: ["src/x.ts"],
      effect: "allow",
    })
    expect(await harness.guard.snapshot(harness.sessionID)).toBeUndefined()
  })

  test("a host without an event stream is a warned no-op", async () => {
    const harness = await setup({ events: false })
    expect(harness.guard.available).toBe(false)
    expect(harness.warnings.some((line) => line.includes("event stream"))).toBe(true)
    expect(await harness.guard.snapshot(harness.sessionID)).toBeUndefined()
  })

  test("a host without the context hook is a warned no-op", async () => {
    const harness = await setup({ contextHook: false })
    expect(harness.guard.available).toBe(false)
    expect(harness.warnings.some((line) => line.includes("context hook"))).toBe(true)
  })

  test("cleanup aborts the subscription, disposes the hook and forgets the snapshot", async () => {
    const harness = await setup()
    expect(harness.signals).toHaveLength(1)
    expect(harness.signals[0]?.aborted).toBe(false)
    await harness.dispose()
    expect(harness.signals[0]?.aborted).toBe(true)
    expect(harness.disposed()).toBe(1)
    expect(await harness.guard.snapshot(harness.sessionID)).toBeUndefined()
    await harness.dispose()
    expect(harness.disposed()).toBe(1)
  })

  test("readProtocolGuardOptions parses defaults and warns on bad values", () => {
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    expect(readProtocolGuardOptions(undefined, warn)).toEqual(DEFAULT_PROTOCOL_GUARD)
    expect(
      readProtocolGuardOptions(
        { protocolGuard: { enabled: false, requirePair: false, artifactWarnings: false, maxArtifactEntries: 7 } },
        warn,
      ),
    ).toEqual({ enabled: false, requirePair: false, artifactWarnings: false, maxArtifactEntries: 7 })
    expect(readProtocolGuardOptions({ protocolGuard: "on" }, warn).enabled).toBe(true)
    expect(readProtocolGuardOptions({ protocolGuard: { enabled: "yes" } }, warn).enabled).toBe(true)
    expect(readProtocolGuardOptions({ protocolGuard: { maxArtifactEntries: -1 } }, warn).maxArtifactEntries).toBe(500)
    expect(warnings.length).toBe(3)
  })

  test("warning texts are short, localized and path-free", () => {
    for (const text of [loopWarningText("en", 3), loopWarningText("ru", 3)]) {
      expect(text.length).toBeLessThanOrEqual(300)
    }
    expect(loopWarningText("ru", 2)).toContain("Протокол")
    expect(loopWarningText("en", 2)).toContain("Protocol")
    expect(loopWarningText("en", 2)).not.toContain("\\")
  })
})

describe("protocol guard: session_stats protocol field", () => {
  test("session_stats carries the protocol snapshot and null without the guard", async () => {
    const counters = {
      sessionID: "ses_test",
      requests: 1,
      promptTokensLast: 10,
      promptTokensMax: 10,
      promptTokensMedian: 10,
      band: 0,
      compactions: 0,
      compactionAttempts: 0,
      compactionFailures: 0,
      compactionSource: "hook" as const,
      reminders: 0,
      toolCalls: 0,
      outputsCapped: 0,
      outputCharsSaved: 0,
      errors: 0,
      toolCallsByTool: {},
      toolOutputsCappedByTool: {},
    }
    const budget = {
      available: true,
      config: {
        session: { enabled: true, promptTokensSoft: 150_000, maxCompactions: 1 },
        toolOutput: { enabled: false, maxChars: 20_000, headChars: 4_000, tools: [] as readonly string[] },
        auditBudget: { enabled: false, softToolCalls: 150, agents: [] as readonly string[] },
      },
      stats: (sessionID: string) => ({ ...counters, sessionID }),
      tracked: () => true,
      guard: () => ({
        available: true,
        hooksRegistered: true,
        sessionEnabled: true,
        toolOutputEnabled: false,
        toolOutputTools: [] as readonly string[],
        compactionSource: "hook" as const,
        eventLive: false,
        streamFailures: 0,
        unkeyedCalls: 0,
      }),
    }
    const protocol = {
      available: true,
      config: DEFAULT_PROTOCOL_GUARD,
      snapshot: async () => ({
        loop: "audit" as const,
        writes: 2,
        audits: 1,
        pair: false,
        fix: false,
        handoff: true,
        state: false,
        reports: 1,
        truncated: false,
        warnedLoop: true,
        warnedArtifacts: false,
        at: 1,
      }),
    }
    const withGuard = await createHarness({ sessionBudget: budget, protocolGuard: protocol })
    const body = await runTool(withGuard, "orch_uni_session_stats", { sessionID: "ses_test" })
    expect(body.protocol).toMatchObject({ loop: "audit", writes: 2, audits: 1, warnedLoop: true })
    withGuard.dispose()

    const without = await createHarness({ sessionBudget: budget })
    const plain = await runTool(without, "orch_uni_session_stats", { sessionID: "ses_test" })
    expect(plain).toHaveProperty("protocol", null)
    without.dispose()
  })
})
