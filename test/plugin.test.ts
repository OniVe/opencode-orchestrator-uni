/**
 * Regression net for the plugin's registration logic.
 *
 * The harness mimics the engine editors as observed in OpenCode 2.0.x:
 * `agent.update(id, fn)` upserts — when the id is absent it starts from the
 * default agent shape — and the transform callback runs synchronously.
 * Real end-to-end loading is verified separately against a live server.
 */
import { afterEach, describe, expect, test } from "bun:test"
import plugin, { DOCS_DIRECTORY, type Locale, localeDirectory, PLUGIN_ID, REFERENCE_NAME } from "../index"
import { WRITE_GUARD_MESSAGE } from "../lib/write-guard"
import { agentFiles, docFiles } from "./support/locales"

/**
 * Every successful `setup` creates a per-process private tool-output root; the
 * harness disposes each one after the test so the suite leaves no temp
 * directories behind. Disposal is idempotent for the session guard, and a test
 * that injects a failing dispose is already covered by the catch below.
 */
const pendingCleanups: (() => Promise<void> | void)[] = []

function trackSetup(ctx: Parameters<typeof plugin.setup>[0]) {
  const pending = plugin.setup(ctx)
  pending.then(
    (cleanup) => {
      if (typeof cleanup === "function") pendingCleanups.push(cleanup)
    },
    () => {
      // the test asserts the rejection; there is nothing to clean up
    },
  )
  return pending
}

afterEach(async () => {
  for (const cleanup of pendingCleanups.splice(0)) {
    try {
      await cleanup()
    } catch {
      // the test may already have disposed the plugin or injected a dispose fault
    }
  }
})

interface RuleDraft {
  action: string
  resource: string
  effect: string
}

interface AgentDraft {
  id: string
  name: string
  request: Record<string, Record<string, unknown>>
  mode: string
  hidden: boolean
  permissions: RuleDraft[]
  description?: string
  system?: string
  model?: unknown
}

interface CommandDraft {
  name: string
  description?: string
  execute: (input: {
    sessionID: string
    prompt: { text: string; files?: unknown; agents?: unknown; skills?: unknown }
    delivery: string
  }) => Promise<void>
}

function createHarness(
  options?: unknown,
  faults: {
    readonly failingCommands?: boolean
    readonly failingDispose?: boolean
    readonly noCommandApi?: boolean
  } = {},
) {
  const agents = new Map<string, AgentDraft>()
  const references = new Map<string, unknown>()
  const tools = new Map<string, unknown>()
  const commands = new Map<string, CommandDraft>()
  const prompts: unknown[] = []
  const storage = new Map<string, unknown>()
  const sessionHooks = new Map<string, unknown>()
  const toolHooks = new Map<string, unknown>()
  const permissionHooks = new Map<string, unknown>()
  const subscriptionSignals: AbortSignal[] = []
  let subscriptionSignal: AbortSignal | undefined
  let permissionDisposals = 0
  const agentEditor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: () => {},
    update: (id: string, fn: (draft: AgentDraft) => void) => {
      const current: AgentDraft = agents.get(id) ?? {
        id,
        name: id,
        request: { settings: {}, headers: {}, body: {} },
        mode: "primary",
        hidden: false,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }
      if (!agents.has(id)) agents.set(id, current)
      fn(current)
      current.id = id
    },
    remove: (id: string) => {
      agents.delete(id)
    },
  }
  const referenceEditor = {
    add: (name: string, source: unknown) => {
      references.set(name, source)
    },
    remove: (name: string) => {
      references.delete(name)
    },
    list: () => [...references.entries()],
    get: (name: string) => references.get(name),
  }
  const commandEditor = {
    add: (definition: CommandDraft) => {
      commands.set(definition.name, definition)
    },
  }
  const ctx = {
    options,
    location: { directory: process.cwd() },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
    event: {
      subscribe: (requestOptions?: { signal?: AbortSignal }) => {
        subscriptionSignal = requestOptions?.signal
        if (requestOptions?.signal !== undefined) subscriptionSignals.push(requestOptions.signal)
        return {
          async *[Symbol.asyncIterator]() {
            // no events: the subscription ends immediately
          },
        }
      },
    },
    session: {
      get: async () => ({}),
      prompt: async (input: unknown) => {
        prompts.push(input)
        return { id: "msg_test" }
      },
      hook: async (name: string, callback: unknown) => {
        sessionHooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async (name: string, callback: unknown) => {
        permissionHooks.set(name, callback)
        return {
          dispose: async () => {
            permissionDisposals += 1
          },
        }
      },
    },
    command: {
      transform: async (callback: (editor: typeof commandEditor) => void) => {
        if (faults.failingCommands) throw new Error("command transform failed")
        callback(commandEditor)
        return {
          dispose: async () => {
            if (faults.failingDispose) throw new Error("dispose failed")
          },
        }
      },
      list: async () => ({ location: { directory: process.cwd() }, data: [...commands.values()] }),
    },
    tool: {
      hook: async (name: string, callback: unknown) => {
        toolHooks.set(name, callback)
        return { dispose: async () => {} }
      },
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: () => {},
          add: (tool: { name: string; options?: { namespace?: string } }) => {
            const namespace = tool.options?.namespace
            tools.set(
              namespace === undefined ? tool.name : `${namespace}.${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_"),
              tool,
            )
          },
          list: () => [...tools.values()],
          get: (id: string) => tools.get(id),
          update: () => {},
          remove: (id: string) => {
            tools.delete(id)
          },
        })
        return { dispose: async () => {} }
      },
    },
    agent: {
      transform: async (callback: (editor: typeof agentEditor) => void) => {
        callback(agentEditor)
        return { dispose: async () => {} }
      },
    },
    reference: {
      transform: async (callback: (editor: typeof referenceEditor) => void) => {
        callback(referenceEditor)
        return { dispose: async () => {} }
      },
    },
  }
  return {
    ctx: ctx as unknown as Parameters<typeof plugin.setup>[0],
    agents,
    references,
    tools,
    commands,
    prompts,
    sessionHooks,
    toolHooks,
    permissionHooks,
    subscriptionSignals,
    get aborted() {
      return subscriptionSignal?.aborted ?? false
    },
    get permissionDisposals() {
      return permissionDisposals
    },
  }
}

async function runSetup(
  options?: unknown,
  faults: { failingCommands?: boolean; failingDispose?: boolean; noCommandApi?: boolean } = {},
) {
  const harness = createHarness(options, faults)
  if (faults.noCommandApi === true) delete (harness.ctx as unknown as { command?: unknown }).command
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "))
  }
  try {
    await trackSetup(harness.ctx)
  } finally {
    console.warn = original
  }
  return { ...harness, warnings }
}

/** Effective permission effect: the last matching rule wins. */
function effectiveEffect(agent: AgentDraft, action: string): string | undefined {
  return agent.permissions.filter((rule) => rule.action === "*" || rule.action === action).at(-1)?.effect
}

/** Whole-value wildcard matching of the host's permission engine (`*`, `?`; case-insensitive on Windows). */
function globMatches(pattern: string, resource: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/")
  const normalizedResource = resource.replaceAll("\\", "/")
  const source = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "").test(normalizedResource)
}

/** Effective effect for an action on a concrete resource: the last matching rule wins. */
function effectiveEffectFor(agent: AgentDraft, action: string, resource: string): string | undefined {
  return agent.permissions
    .filter((rule) => (rule.action === "*" || rule.action === action) && globMatches(rule.resource, resource))
    .at(-1)?.effect
}

function seedExistingAgent(id: string): AgentDraft {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
    description: "local override",
    system: "local system",
  }
}

/** The opening role line of every shipped prompt, per locale (pinned markers). */
const SYSTEM_MARKERS: Record<Locale, Record<string, string>> = {
  ru: {
    orchestrator: "Ты — root-оркестратор",
    "fix-runner": "Ты — fix-runner",
    factcheck: "Ты — факт-чекер",
    "context-lint": "Ты — read-only аудитор файлов инструкций",
    empiric: "Ты — эмпирический read-only аудитор",
    invariant: "Ты — read-only аудитор защитных инвариантов",
    arbiter: "Ты — арбитр",
    meta: "Ты — мета-аудитор",
    redteam: "Ты — приёмочный ред-тим",
  },
  en: {
    orchestrator: "You are the root orchestrator.",
    "fix-runner": "You are the fix-runner of the audit loop.",
    factcheck: "You are the fact-checker of the audit loop.",
    "context-lint": "You are the read-only auditor of instruction files",
    empiric: "You are the empirical read-only auditor.",
    invariant: "You are the read-only auditor of protective invariants.",
    arbiter: "You are the arbiter of the audit loop.",
    meta: "You are the meta-auditor",
    redteam: "You are the acceptance red team.",
  },
}

describe("opencode-orchestrator-uni", () => {
  test("exports a V2 plugin definition", () => {
    expect(plugin.id).toBe(PLUGIN_ID)
    expect(typeof plugin.setup).toBe("function")
  })

  for (const locale of ["ru", "en"] as const) {
    test(`registers every shipped ${locale} agent definition without warnings`, async () => {
      const shipped = await agentFiles(locale)
      const { agents, warnings } = await runSetup({ locale })

      expect(shipped.length).toBe(Object.keys(SYSTEM_MARKERS[locale]).length)
      expect(shipped.length).toBe(9)
      expect(warnings).toEqual([])
      expect(agents.size).toBe(shipped.length)
      for (const file of shipped) {
        const id = file.replace(/\.md$/, "")
        const agent = agents.get(id)
        expect(agent, `${id} is registered`).toBeDefined()
        expect(agent?.system ?? "").toContain(SYSTEM_MARKERS[locale][id]!)
        expect(agent?.description, `${id} has a description`).toBeTruthy()
      }
    })
  }

  test("an unsupported options.locale warns and falls back to detection", async () => {
    const { agents, warnings } = await runSetup({ locale: "fr" })
    expect(warnings.some((line) => line.includes("options.locale"))).toBe(true)
    expect(agents.size).toBe(9)
  })

  test("hostile options.locale values do not break setup", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const hostile = {
      toJSON() {
        throw new Error("toJSON exploded")
      },
      toString() {
        throw new Error("toString exploded")
      },
    }
    for (const value of [10n, cyclic, hostile]) {
      const { agents, warnings } = await runSetup({ locale: value })
      expect(agents.size).toBe(9)
      expect(warnings.some((line) => line.includes("options.locale"))).toBe(true)
    }
  })

  test("agents carry no model without options (subagents inherit the session model)", async () => {
    const { agents } = await runSetup()
    for (const agent of agents.values()) expect(agent.model).toBeUndefined()
  })

  test("orchestrator delegates code edits: edit is denied except audit/state artifacts", async () => {
    const { agents } = await runSetup()
    const orchestrator = agents.get("orchestrator")!
    expect(orchestrator.mode).toBe("primary")
    expect(effectiveEffect(orchestrator, "shell")).toBe("allow")
    expect(
      orchestrator.permissions.some(
        (rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny",
      ),
    ).toBe(true)

    const denied = [
      "src/index.ts",
      "README.md",
      "agents/ru/orchestrator.md",
      // The flat fallback keeps artifact names out of source directories too.
      "src/state.md",
      "src/case-x.md",
      "src/reports/x.md",
      "app/state.md",
    ]
    for (const resource of denied) expect(effectiveEffectFor(orchestrator, "edit", resource), resource).toBe("deny")

    const allowed = ["reports/summary.md", "docs/planning/state.md", "audit-abc/case-x.md", "state.md"]
    for (const resource of allowed) expect(effectiveEffectFor(orchestrator, "edit", resource), resource).toBe("allow")
  })

  test("registers the write guard permission hook", async () => {
    const { permissionHooks } = await runSetup({ locale: "ru" })
    interface EvaluateEventDraft {
      sessionID?: string
      agent?: string
      action: string
      resources: readonly string[]
      effect: string
      message?: string
    }
    const evaluate = permissionHooks.get("evaluate") as ((event: EvaluateEventDraft) => Promise<void>) | undefined
    expect(evaluate).toBeDefined()
    if (evaluate === undefined) return

    const decide = async (resources: readonly string[], agent = "orchestrator", effect = "allow", action = "edit") => {
      const event: EvaluateEventDraft = { agent, action, resources, effect }
      await evaluate(event)
      return event
    }

    expect((await decide(["src/index.ts"])).effect).toBe("deny")
    expect((await decide(["src/index.ts"])).message).toBe(WRITE_GUARD_MESSAGE)
    expect((await decide(["reports/summary.md"])).effect).toBe("allow")
    expect((await decide(["src/reports/x"])).effect).toBe("deny")
    expect((await decide(["reports/src/x"])).effect).toBe("allow")
    expect((await decide(["src/docs/planning/x.md"])).effect).toBe("deny")
    expect((await decide(["docs/planning/state.md"])).effect).toBe("allow")
    expect((await decide(["app/state.md"])).effect).toBe("deny")
    expect((await decide(["audit-abc/case-x.md"])).effect).toBe("allow")
    expect((await decide(["../reports/x"])).effect).toBe("deny")
    expect((await decide(["reports/summary.md", "src/index.ts"])).effect).toBe("deny")
    expect((await decide(["src/index.ts"], "fix-runner")).effect).toBe("allow")
    const alreadyDenied = await decide(["src/index.ts"], "orchestrator", "deny")
    expect(alreadyDenied.effect).toBe("deny")
    expect(alreadyDenied.message).toBeUndefined()
    expect((await decide(["src/index.ts"], "orchestrator", "allow", "shell")).effect).toBe("allow")
  })

  test("audit subagents are read-only, fix-runner may write", async () => {
    const { agents } = await runSetup()
    const auditors = ["factcheck", "empiric", "invariant", "arbiter", "meta", "redteam", "context-lint"]
    for (const id of auditors) {
      const agent = agents.get(id)!
      expect(agent.mode, id).toBe("subagent")
      expect(effectiveEffect(agent, "edit"), id).toBe("deny")
      expect(
        agent.permissions.some((rule) => rule.action === "edit" && rule.effect === "deny"),
        `${id} has an explicit edit deny rule`,
      ).toBe(true)
    }
    const fixRunner = agents.get("fix-runner")!
    expect(fixRunner.mode).toBe("subagent")
    expect(effectiveEffect(fixRunner, "edit")).toBe("allow")
  })

  test("options.model applies to every kit agent", async () => {
    const { agents, warnings } = await runSetup({ model: "deepseek/deepseek-flash" })
    expect(warnings).toEqual([])
    expect(agents.size).toBe(9)
    for (const agent of agents.values()) {
      expect(agent.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
    }
  })

  test("options.agents overrides the default per agent (string and expanded forms)", async () => {
    const { agents, warnings } = await runSetup({
      model: "deepseek/deepseek-flash",
      agents: {
        meta: "deepseek/deepseek-reasoner",
        "fix-runner": { providerID: "anthropic", model: "claude-sonnet-4-5", variant: "high" },
      },
    })
    expect(warnings).toEqual([])
    expect(agents.get("meta")!.model).toEqual({ providerID: "deepseek", id: "deepseek-reasoner" })
    expect(agents.get("fix-runner")!.model).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "high",
    })
    expect(agents.get("orchestrator")!.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
  })

  test("invalid options warn and are ignored", async () => {
    const { agents, warnings } = await runSetup({
      model: "not-a-model",
      agents: { meta: 42, "no-such-agent": "deepseek/deepseek-flash" },
    })
    expect(warnings.some((line) => line.includes("options.model"))).toBe(true)
    expect(warnings.some((line) => line.includes(`options.agents["meta"]`))).toBe(true)
    expect(warnings.some((line) => line.includes(`options.agents["no-such-agent"]`))).toBe(true)
    for (const agent of agents.values()) expect(agent.model).toBeUndefined()
  })

  test("existing definitions are not overridden; configured models still apply", async () => {
    // Without options an existing definition stays fully untouched.
    const plain = createHarness()
    plain.agents.set("orchestrator", seedExistingAgent("orchestrator"))
    await trackSetup(plain.ctx)
    const kept = plain.agents.get("orchestrator")!
    expect(kept.description).toBe("local override")
    expect(kept.system).toBe("local system")
    expect(kept.permissions).toEqual([])
    expect(kept.model).toBeUndefined()

    // With options the model is applied, the rest stays untouched.
    const withOptions = createHarness({ model: "deepseek/deepseek-flash" })
    withOptions.agents.set("orchestrator", seedExistingAgent("orchestrator"))
    await trackSetup(withOptions.ctx)
    const updated = withOptions.agents.get("orchestrator")!
    expect(updated.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
    expect(updated.description).toBe("local override")
    expect(updated.system).toBe("local system")
    expect(updated.permissions).toEqual([])
  })

  for (const locale of ["ru", "en"] as const) {
    test(`registers the audit-kit reference pointing at the shipped ${locale} docs`, async () => {
      const { references } = await runSetup({ locale })
      const reference = references.get(REFERENCE_NAME) as { type: string; path: string; description: string }
      expect(reference.type).toBe("local")
      expect(reference.path).toBe(localeDirectory(DOCS_DIRECTORY, locale))
      expect(reference.description).toContain("call-mechanics.md")
      const docs = await docFiles(locale)
      for (const name of [
        "call-mechanics.md",
        "process-ready-loop.md",
        "root-runbook.md",
        "instruction-other-session.md",
      ]) {
        expect(docs, name).toContain(name)
      }
    })
  }

  test("an existing reference is not overridden", async () => {
    const harness = createHarness()
    harness.references.set(REFERENCE_NAME, { type: "local", path: "C:/somewhere/else" })
    await trackSetup(harness.ctx)
    expect(harness.references.get(REFERENCE_NAME)).toEqual({ type: "local", path: "C:/somewhere/else" })
  })

  test("setup registers the audit tools", async () => {
    const { tools, warnings } = await runSetup()
    expect(warnings).toEqual([])
    expect([...tools.keys()].sort()).toEqual([
      "orch_uni_context_lint",
      "orch_uni_session_stats",
      "orch_uni_sessions",
      "orch_uni_snapshot",
      "orch_uni_validate_report",
    ])
  })

  test("setup registers the guard hooks and subscribes to compaction events", async () => {
    const { sessionHooks, toolHooks, subscriptionSignals } = await runSetup({ locale: "ru" })
    // The compaction hook is registered on every host (it counts attempts and
    // provides liveness when the stream dies); the event stream is the primary
    // source for confirmed compactions.
    expect([...sessionHooks.keys()].sort()).toEqual(["compaction", "context"])
    expect([...toolHooks.keys()]).toEqual(["execute.after"])
    expect(subscriptionSignals).toHaveLength(2) // session index + compaction events
  })

  test("a host without an event stream falls back to the compaction hook", async () => {
    const harness = createHarness({ locale: "ru" })
    delete (harness.ctx as unknown as { event?: unknown }).event
    await trackSetup(harness.ctx)
    expect([...harness.sessionHooks.keys()].sort()).toEqual(["compaction", "context"])
    expect(harness.toolHooks.has("execute.after")).toBe(true)
  })

  test("cleanup aborts every guard event subscription", async () => {
    const harness = createHarness({ locale: "ru" })
    const cleanup = await trackSetup(harness.ctx)
    expect(harness.subscriptionSignals).toHaveLength(2)
    expect(harness.subscriptionSignals.every((signal) => signal.aborted)).toBe(false)
    await cleanup?.()
    expect(harness.subscriptionSignals.every((signal) => signal.aborted)).toBe(true)
  })

  test("setup registers all slash commands", async () => {
    const { commands, warnings } = await runSetup({ locale: "ru" })
    expect(warnings).toEqual([])
    expect([...commands.keys()].sort()).toEqual(["agents-md", "handoff", "spec"])
    expect(commands.get("agents-md")?.description).toContain("AGENTS.md")
  })

  test("an existing slash command is not overridden", async () => {
    const harness = createHarness()
    const local: CommandDraft = {
      name: "spec",
      description: "local spec command",
      execute: async () => {},
    }
    harness.commands.set("spec", local)
    await trackSetup(harness.ctx)
    expect(harness.commands.get("spec")?.description).toBe("local spec command")
    expect(harness.commands.has("agents-md")).toBe(true)
  })

  test("a command injects its workflow prompt into the session", async () => {
    const { commands, prompts } = await runSetup()
    await commands.get("spec")!.execute({
      sessionID: "ses_test",
      prompt: { text: "export orders" },
      delivery: "queue",
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionID: "ses_test", delivery: "queue" })
    expect(String((prompts[0] as { text?: string }).text)).toContain("context-efficiency.md")
  })

  for (const locale of ["ru", "en"] as const) {
    test(`/handoff writes the canonical path and asks before committing (${locale})`, async () => {
      const { commands, prompts } = await runSetup({ locale })
      await commands.get("handoff")!.execute({
        sessionID: "ses_test",
        prompt: { text: "/handoff audit round" },
        delivery: "queue",
      })
      const text = String((prompts.at(-1) as { text?: string } | undefined)?.text ?? "")
      expect(text).toContain("docs/planning/handoff-<YYYY-MM-DD>.md")
      expect(text).toMatch(/коммит|commit/i)
      expect(text).toContain(locale === "ru" ? "не коммить без подтверждения" : "do not commit without the owner")
    })
  }

  /** Text the `/agents-md` handler injects for one typed goal. */
  async function agentsMdGoal(locale: Locale, goal: string): Promise<string> {
    const { commands, prompts } = await runSetup({ locale })
    await commands.get("agents-md")!.execute({
      sessionID: "ses_test",
      prompt: { text: `/agents-md ${goal}` },
      delivery: "queue",
    })
    return String((prompts.at(-1) as { text?: string } | undefined)?.text ?? "")
  }

  for (const goal of ["проверь AGENTS.md", "аудит репозитория", "проверить инструкции", "АУДИТ"]) {
    test(`RU "${goal}" selects the audit branch`, async () => {
      const text = await agentsMdGoal("ru", goal)
      expect(text).toContain("Это аудит")
      expect(text).not.toContain("Это черновик")
    })
  }

  for (const goal of ["аудитория проекта", "собери черновик"]) {
    test(`RU "${goal}" selects the draft branch`, async () => {
      const text = await agentsMdGoal("ru", goal)
      expect(text).toContain("Это черновик")
      expect(text).not.toContain("Это аудит")
    })
  }

  for (const goal of ["audit the repo", "review AGENTS.md", "check these rules"]) {
    test(`EN "${goal}" still selects the audit branch`, async () => {
      const text = await agentsMdGoal("en", goal)
      expect(text).toContain("This is an audit")
      expect(text).not.toContain("This is a draft")
    })
  }

  test("a failing command registration aborts the tools subscription", async () => {
    const harness = createHarness({ locale: "ru" }, { failingCommands: true })
    await expect(trackSetup(harness.ctx)).rejects.toThrow("command transform failed")
    expect(harness.aborted).toBe(true)
  })

  test("a host without the command API still registers agents and tools", async () => {
    // PR audit A5: `ctx.command` is optional in a host build; a missing optional
    // API must not take the whole kit down.
    const { agents, tools, warnings } = await runSetup({ locale: "ru" }, { noCommandApi: true })
    expect(agents.size).toBe(9)
    expect(tools.has("orch_uni_context_lint")).toBe(true)
    expect(warnings.some((line) => line.includes("command API"))).toBe(true)
  })

  test("a failing command dispose still aborts the tools subscription", async () => {
    const harness = createHarness({ locale: "ru" }, { failingDispose: true })
    const cleanup = await trackSetup(harness.ctx)
    expect(typeof cleanup).toBe("function")
    expect(harness.aborted).toBe(false)
    if (cleanup === undefined) return
    await expect(cleanup()).rejects.toThrow("dispose failed")
    expect(harness.aborted).toBe(true)
  })

  test("a successful cleanup disposes the write guard registration exactly once", async () => {
    const harness = createHarness({ locale: "ru" })
    const cleanup = await trackSetup(harness.ctx)
    if (cleanup === undefined) throw new Error("setup returned no cleanup")
    expect(harness.permissionDisposals).toBe(0)
    await cleanup()
    expect(harness.permissionDisposals).toBe(1)
    // The guard cleanup is idempotent: a repeated call must not dispose twice.
    await cleanup()
    expect(harness.permissionDisposals).toBe(1)
  })

  test("a failing command registration disposes the write guard registration", async () => {
    const harness = createHarness({ locale: "ru" }, { failingCommands: true })
    await expect(trackSetup(harness.ctx)).rejects.toThrow("command transform failed")
    expect(harness.permissionDisposals).toBe(1)
  })

  test("a failing command dispose still disposes the write guard registration", async () => {
    const harness = createHarness({ locale: "ru" }, { failingDispose: true })
    const cleanup = await trackSetup(harness.ctx)
    if (cleanup === undefined) throw new Error("setup returned no cleanup")
    await expect(cleanup()).rejects.toThrow("dispose failed")
    expect(harness.permissionDisposals).toBe(1)
  })
})
