/**
 * Regression net for the plugin's registration logic.
 *
 * The harness mimics the engine editors as observed in OpenCode 2.0.x:
 * `agent.update(id, fn)` upserts — when the id is absent it starts from the
 * default agent shape — and the transform callback runs synchronously.
 * Real end-to-end loading is verified separately against a live server.
 */
import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import plugin, { AGENTS_DIRECTORY, DOCS_DIRECTORY, PLUGIN_ID, REFERENCE_NAME } from "../index"

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

function createHarness(options?: unknown) {
  const agents = new Map<string, AgentDraft>()
  const references = new Map<string, unknown>()
  const tools = new Map<string, unknown>()
  const storage = new Map<string, unknown>()
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
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          // no events: the subscription ends immediately
        },
      }),
    },
    session: { get: async () => ({}) },
    tool: {
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
  }
}

async function runSetup(options?: unknown) {
  const harness = createHarness(options)
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "))
  }
  try {
    await plugin.setup(harness.ctx)
  } finally {
    console.warn = original
  }
  return { ...harness, warnings }
}

/** Effective permission effect: the last matching rule wins. */
function effectiveEffect(agent: AgentDraft, action: string): string | undefined {
  return agent.permissions.filter((rule) => rule.action === "*" || rule.action === action).at(-1)?.effect
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

const SYSTEM_MARKERS: Record<string, string> = {
  orchestrator: "Ты — root-оркестратор",
  "fix-runner": "Ты — fix-runner",
  factcheck: "Ты — факт-чекер",
  empiric: "Ты — эмпирический read-only аудитор",
  invariant: "Ты — read-only аудитор защитных инвариантов",
  arbiter: "Ты — арбитр",
  meta: "Ты — мета-аудитор",
  redteam: "Ты — приёмочный ред-тим",
}

describe("opencode-orchestrator-uni", () => {
  test("exports a V2 plugin definition", () => {
    expect(plugin.id).toBe(PLUGIN_ID)
    expect(typeof plugin.setup).toBe("function")
  })

  test("registers every shipped agent definition without warnings", async () => {
    const shipped = (await readdir(AGENTS_DIRECTORY)).filter((name) => name.endsWith(".md"))
    const { agents, warnings } = await runSetup()

    expect(shipped.length).toBe(Object.keys(SYSTEM_MARKERS).length)
    expect(warnings).toEqual([])
    expect(agents.size).toBe(shipped.length)
    for (const file of shipped) {
      const id = file.replace(/\.md$/, "")
      const agent = agents.get(id)
      expect(agent, `${id} is registered`).toBeDefined()
      expect(agent?.system ?? "").toContain(SYSTEM_MARKERS[id]!)
      expect(agent?.description, `${id} has a description`).toBeTruthy()
    }
  })

  test("agents carry no model without options (subagents inherit the session model)", async () => {
    const { agents } = await runSetup()
    for (const agent of agents.values()) expect(agent.model).toBeUndefined()
  })

  test("orchestrator is primary with shell and edit access", async () => {
    const { agents } = await runSetup()
    const orchestrator = agents.get("orchestrator")!
    expect(orchestrator.mode).toBe("primary")
    expect(effectiveEffect(orchestrator, "edit")).toBe("allow")
    expect(effectiveEffect(orchestrator, "shell")).toBe("allow")
  })

  test("audit subagents are read-only, fix-runner may write", async () => {
    const { agents } = await runSetup()
    const auditors = ["factcheck", "empiric", "invariant", "arbiter", "meta", "redteam"]
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
    expect(agents.size).toBe(8)
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
    await plugin.setup(plain.ctx)
    const kept = plain.agents.get("orchestrator")!
    expect(kept.description).toBe("local override")
    expect(kept.system).toBe("local system")
    expect(kept.permissions).toEqual([])
    expect(kept.model).toBeUndefined()

    // With options the model is applied, the rest stays untouched.
    const withOptions = createHarness({ model: "deepseek/deepseek-flash" })
    withOptions.agents.set("orchestrator", seedExistingAgent("orchestrator"))
    await plugin.setup(withOptions.ctx)
    const updated = withOptions.agents.get("orchestrator")!
    expect(updated.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
    expect(updated.description).toBe("local override")
    expect(updated.system).toBe("local system")
    expect(updated.permissions).toEqual([])
  })

  test("registers the audit-kit reference pointing at the shipped docs", async () => {
    const { references } = await runSetup()
    const reference = references.get(REFERENCE_NAME) as { type: string; path: string; description: string }
    expect(reference.type).toBe("local")
    expect(reference.path).toBe(DOCS_DIRECTORY)
    expect(reference.description).toContain("call-mechanics.md")
    const docs = await readdir(DOCS_DIRECTORY)
    for (const name of [
      "call-mechanics.md",
      "process-ready-loop.md",
      "root-runbook.md",
      "instruction-other-session.md",
    ]) {
      expect(docs, name).toContain(name)
    }
  })

  test("an existing reference is not overridden", async () => {
    const harness = createHarness()
    harness.references.set(REFERENCE_NAME, { type: "local", path: "C:/somewhere/else" })
    await plugin.setup(harness.ctx)
    expect(harness.references.get(REFERENCE_NAME)).toEqual({ type: "local", path: "C:/somewhere/else" })
  })

  test("setup registers the audit tools", async () => {
    const { tools, warnings } = await runSetup()
    expect(warnings).toEqual([])
    expect([...tools.keys()].sort()).toEqual(["orch_uni_sessions", "orch_uni_snapshot", "orch_uni_validate_report"])
  })
})
