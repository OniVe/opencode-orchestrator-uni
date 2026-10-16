/**
 * opencode-orchestrator-uni — native OpenCode V2 package plugin.
 *
 * Registers the orchestrator agent kit — the `orchestrator` root agent with the
 * built-in audit loop, the read-only audit subagents (`factcheck`,
 * `empiric`, `invariant`, `arbiter`, `meta`,
 * `redteam`), and the `fix-runner` writer subagent — plus the `audit-kit`
 * document reference and the kit's deterministic `orch_uni_*` tools, straight from
 * this TypeScript entry point.
 *
 * The package is loaded natively by OpenCode's Bun runtime: `exports` points at
 * this file, so there is no build step and no `dist/`. The agent definitions and
 * process documents ship as plain files (`agents/`, `docs/`) and are read once
 * during setup — keep them as the single source of truth.
 *
 * Registration rules:
 * - Agents are registered through `ctx.agent.transform` with `editor.update`.
 *   `update` creates the agent when its id is not registered yet (the same
 *   mechanism the built-in agent and config plugins use), so no `add` call is
 *   needed.
 * - An agent whose id is already defined by an earlier registration (another
 *   plugin, an `agents` config entry, or a Markdown file under a config
 *   directory) is left untouched — local configuration wins.
 * - The `audit-kit` reference is registered only if that name is free; it points
 *   at this package's `docs/` directory so sessions can read the process
 *   documents directly.
 *
 * Models are configuration, not definition: the agent files carry no `model`,
 * and the plugin applies models from its `plugins` entry options —
 * `options.model` (default for every kit agent) and `options.agents.<id>`
 * (per-agent override), each either `"provider/model[#variant]"` or
 * `{ providerID, model, variant }`. Without options every kit agent keeps no
 * model, so subagents inherit the session's model. An `agents` config entry or
 * a Markdown agent file that sets its own model still wins, because config is
 * applied after package plugins.
 *
 * The only runtime dependency is `gray-matter` (frontmatter parsing). OpenCode
 * installs package plugin dependencies automatically.
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Agent, Model, Plugin, Reference } from "@opencode/plugin"
import matter from "gray-matter"
import { registerAuditTools } from "./lib/tools"

/** Stable plugin id: diagnostics, enable/disable selectors, storage scope. */
export const PLUGIN_ID = "orchestrator.uni"

/** Name of the reference that exposes the kit's process documents. */
export const REFERENCE_NAME = "audit-kit"

/** Absolute path to the shipped agent definitions (`agents/*.md`). */
export const AGENTS_DIRECTORY = fileURLToPath(new URL("./agents/", import.meta.url))

/** Absolute path to the shipped process documents (`docs/*.md`). */
export const DOCS_DIRECTORY = fileURLToPath(new URL("./docs/", import.meta.url))

/** Description shown next to the `audit-kit` reference in session context. */
const REFERENCE_DESCRIPTION =
  "Process documents of the orchestrator agent kit (audit loop): call-mechanics.md, " +
  "process-ready-loop.md, root-runbook.md, instruction-other-session.md."

/** Frontmatter keys this loader understands; anything else is reported and ignored. */
const SUPPORTED_KEYS: ReadonlySet<string> = new Set(["description", "mode", "model", "permissions"])

const MODES: ReadonlySet<Agent.Info["mode"]> = new Set(["primary", "subagent", "all"])

type PermissionRule = Agent.Info["permissions"][number]

const EFFECTS: ReadonlySet<PermissionRule["effect"]> = new Set(["allow", "ask", "deny"])

/** An agent definition parsed from `agents/*.md`, ready for registration. */
interface KitAgent {
  readonly id: string
  readonly mode: Agent.Info["mode"]
  readonly system: string
  readonly description?: string
  readonly permissions: readonly PermissionRule[]
}

function warn(message: string): void {
  console.warn(`[${PLUGIN_ID}] ${message}`)
}

/**
 * Parse a `provider/model` or `provider/model#variant` reference.
 * Returns `undefined` when the value is malformed.
 */
function parseModelRef(value: string): Model.Ref | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  const providerID = value.slice(0, slash)
  const rest = value.slice(slash + 1)
  const hash = rest.indexOf("#")
  const id = hash === -1 ? rest : rest.slice(0, hash)
  const variant = hash === -1 ? undefined : rest.slice(hash + 1)
  if (!id || variant === "") return undefined
  // Model.Ref uses branded schema types; at runtime these are plain strings.
  const ref = { id, providerID, ...(variant === undefined ? {} : { variant }) }
  return ref as Model.Ref
}

/** Parse one option value: `"provider/model[#variant]"` or `{ providerID, model, variant }`. */
function parseModelSelection(value: unknown, context: string): Model.Ref | undefined {
  if (typeof value === "string") {
    const ref = parseModelRef(value)
    if (!ref) warn(`${context}: "${value}" is not provider/model[#variant], ignored`)
    return ref
  }
  if (typeof value === "object" && value !== null) {
    const { providerID, model, variant } = value as Record<string, unknown>
    if (typeof providerID !== "string" || providerID === "" || typeof model !== "string" || model === "") {
      warn(`${context}: expected {providerID, model, variant?}, ignored`)
      return undefined
    }
    if (variant !== undefined && (typeof variant !== "string" || variant === "")) {
      warn(`${context}: "variant" must be a non-empty string, ignored`)
      return undefined
    }
    // Model.Ref uses branded schema types; at runtime these are plain strings.
    const ref = { id: model, providerID, ...(variant === undefined ? {} : { variant }) }
    return ref as Model.Ref
  }
  warn(`${context}: expected "provider/model[#variant]" or {providerID, model, variant}, ignored`)
  return undefined
}

/** Models from the plugin entry options: a default for all kit agents and per-agent overrides. */
interface ModelOptions {
  readonly defaultModel?: Model.Ref
  readonly perAgent: ReadonlyMap<string, Model.Ref>
}

function readModelOptions(options: unknown): ModelOptions {
  const perAgent = new Map<string, Model.Ref>()
  if (typeof options !== "object" || options === null) return { perAgent }
  const { model, agents } = options as Record<string, unknown>
  const defaultModel = model === undefined ? undefined : parseModelSelection(model, `options.model`)
  if (agents !== undefined) {
    if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
      warn(`options.agents: expected an object of per-agent model overrides, ignored`)
    } else {
      for (const [id, value] of Object.entries(agents)) {
        const ref = parseModelSelection(value, `options.agents["${id}"]`)
        if (ref) perAgent.set(id, ref)
      }
    }
  }
  return { ...(defaultModel === undefined ? {} : { defaultModel }), perAgent }
}

/** Validate one `permissions` list entry; `undefined` when it is not a rule. */
function asPermissionRule(raw: unknown): PermissionRule | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { action, resource, effect } = raw as Record<string, unknown>
  if (typeof action !== "string" || action === "") return undefined
  if (typeof resource !== "string") return undefined
  if (typeof effect !== "string" || !EFFECTS.has(effect as PermissionRule["effect"])) return undefined
  return { action, resource, effect: effect as PermissionRule["effect"] }
}

/**
 * Parse one `agents/<id>.md` file. Returns `undefined` — after a warning — when
 * the file cannot define an agent safely (unparseable frontmatter, missing or
 * invalid `mode`, empty body, invalid permission entry). A malformed agent is
 * skipped as a whole, never registered in a half-configured state.
 */
function parseAgentFile(id: string, source: string): KitAgent | undefined {
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(source)
  } catch (error) {
    warn(`agents/${id}.md: cannot parse frontmatter: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const data = parsed.data as Record<string, unknown>
  for (const key of Object.keys(data)) {
    if (SUPPORTED_KEYS.has(key)) continue
    if (key === "model") {
      warn(
        `agents/${id}.md: "model" in frontmatter is ignored — configure models via the plugin options ` +
          `("model" / "agents") or the "agents" config`,
      )
      continue
    }
    warn(`agents/${id}.md: unsupported frontmatter key "${key}" is ignored`)
  }

  const system = parsed.content.trim()
  if (!system) {
    warn(`agents/${id}.md: empty system prompt, agent skipped`)
    return undefined
  }

  const mode = data.mode
  if (typeof mode !== "string" || !MODES.has(mode as Agent.Info["mode"])) {
    warn(`agents/${id}.md: "mode" must be one of primary|subagent|all, agent skipped`)
    return undefined
  }

  const permissions: PermissionRule[] = []
  if (data.permissions !== undefined) {
    if (!Array.isArray(data.permissions)) {
      warn(`agents/${id}.md: "permissions" must be a list, agent skipped`)
      return undefined
    }
    for (const [index, raw] of data.permissions.entries()) {
      const rule = asPermissionRule(raw)
      if (!rule) {
        warn(`agents/${id}.md: permissions[${index}] is not {action, resource, effect: allow|ask|deny}, agent skipped`)
        return undefined
      }
      permissions.push(rule)
    }
  }

  let description: string | undefined
  if (typeof data.description === "string" && data.description.trim() !== "") {
    description = data.description.trim()
  } else {
    warn(`agents/${id}.md: no description — the model sees less when picking this agent`)
  }

  return {
    id,
    mode: mode as Agent.Info["mode"],
    system,
    ...(description === undefined ? {} : { description }),
    permissions,
  }
}

/** Read and parse every shipped `agents/*.md` definition (stable file order). */
async function loadKitAgents(): Promise<KitAgent[]> {
  const entries = await readdir(AGENTS_DIRECTORY, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
  const agents: KitAgent[] = []
  for (const file of files) {
    const source = await readFile(path.join(AGENTS_DIRECTORY, file), "utf8")
    const agent = parseAgentFile(file.replace(/\.md$/, ""), source)
    if (agent) agents.push(agent)
  }
  return agents
}

async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | undefined> {
  const models = readModelOptions(ctx.options)
  const agents = await loadKitAgents()
  const defined = new Set(agents.map((agent) => agent.id))
  for (const id of models.perAgent.keys()) {
    if (!defined.has(id)) warn(`options.agents["${id}"]: unknown kit agent, override ignored`)
  }
  const overrides = new Map([...models.perAgent].filter(([id]) => defined.has(id)))
  if (agents.length === 0) {
    warn(`no agent definitions found in ${AGENTS_DIRECTORY}`)
  } else {
    await ctx.agent.transform((editor) => {
      for (const agent of agents) {
        const exists = editor.get(agent.id) !== undefined
        const model = overrides.get(agent.id) ?? models.defaultModel
        // Definitions provided by another source stay untouched; a configured
        // model still applies, so the kit follows config models even when the
        // agent is defined locally.
        if (exists && model === undefined) continue
        editor.update(agent.id, (target) => {
          if (!exists) {
            if (agent.description !== undefined) target.description = agent.description
            target.mode = agent.mode
            if (agent.system) target.system = agent.system
            for (const rule of agent.permissions) target.permissions.push(rule)
          }
          if (model !== undefined) target.model = model
        })
      }
    })
  }

  // `description` is part of the runtime schema (`Reference.LocalSource`) and is
  // rendered for models in session context. The promise editor's parameter type uses
  // the public client shape, which does not declare it, so the source is built as a
  // variable to keep the excess-property check out of the way.
  const docsReference = {
    type: "local" as const,
    // AbsolutePath is a branded schema type; the runtime value is a plain path.
    path: DOCS_DIRECTORY as Reference.LocalSource["path"],
    description: REFERENCE_DESCRIPTION,
  }
  await ctx.reference.transform((editor) => {
    if (editor.get(REFERENCE_NAME)) return
    editor.add(REFERENCE_NAME, docsReference)
  })

  // Deterministic, read-only audit tools: `orch_uni_validate_report`,
  // `orch_uni_snapshot`, `orch_uni_sessions` (see `lib/tools.ts` and README «Tools»).
  // The returned cleanup only stops the background session-index subscription.
  return await registerAuditTools(ctx)
}

export default { id: PLUGIN_ID, setup } satisfies Plugin.Plugin
