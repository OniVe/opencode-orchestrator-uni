/**
 * Slash commands of the kit: `/agents-md` and `/spec`.
 *
 * Commands are prompts, not writers: `execute` injects a short workflow prompt
 * into the current session, and the orchestrator runs it with the usual
 * evidence/approval rules. The detailed templates and checklists live in
 * `docs/<locale>/context-efficiency.md`.
 */
import type { Plugin } from "@opencode/plugin"

type CommandLocale = "ru" | "en"

/** Arguments typed after the slash command, without a duplicated command token. */
function commandArgs(text: string): string {
  return text.replace(/^\s*\/(?:agents-md|spec)\b/i, "").trim()
}

const DESCRIPTIONS: Record<CommandLocale, { readonly agentsMd: string; readonly spec: string }> = {
  ru: {
    agentsMd: "Создать или проверить AGENTS.md по шаблону context-efficiency.md.",
    spec: "Создать или проверить SPEC.md по шаблону context-efficiency.md.",
  },
  en: {
    agentsMd: "Create or audit AGENTS.md using the context-efficiency.md template.",
    spec: "Create or audit SPEC.md using the context-efficiency.md template.",
  },
}

function agentsMdPrompt(locale: CommandLocale, goal: string): string {
  if (locale === "ru") {
    const audit = /(?<![\p{L}\p{N}_])(?:аудит|проверь|проверить)(?![\p{L}\p{N}_])/iu.test(goal)
    return [
      "[Команда /agents-md]",
      `Цель: ${goal}.`,
      "",
      "Работай по документу context-efficiency.md из reference audit-kit.",
      audit
        ? "1. Это аудит: сначала вызови orch_uni_context_lint (если доступен), затем context-lint; покажи SGR и closing_list."
        : "1. Это черновик: собери факты (стек, команды, границы, ловушки, never/ask, указатели); задай не более 8 вопросов.",
      "2. Не выдумывай команды, пути и версии; всё непроверенное помечай.",
      "3. Заполни шаблон AGENTS.md из context-efficiency.md; бюджет 150–200 строк.",
      "4. Прогони context-lint, покажи diff и открытые вопросы.",
      "5. Канонический AGENTS.md не меняй без подтверждения; правки — через fix-runner.",
    ].join("\n")
  }
  const audit = /\b(?:audit|review|check)\b/i.test(goal)
  return [
    "[Command /agents-md]",
    `Goal: ${goal}.`,
    "",
    "Follow context-efficiency.md from the audit-kit reference.",
    audit
      ? "1. This is an audit: run orch_uni_context_lint first (when available), then context-lint; show the SGR and closing_list."
      : "1. This is a draft: collect facts (stack, commands, boundaries, traps, never/ask, pointers); ask at most 8 questions.",
    "2. Do not invent commands, paths or versions; mark everything unverified.",
    "3. Fill the AGENTS.md template from context-efficiency.md; keep the budget at 150–200 lines.",
    "4. Run context-lint and show the diff plus open questions.",
    "5. Do not change the canonical AGENTS.md without approval; apply fixes through fix-runner.",
  ].join("\n")
}

function specPrompt(locale: CommandLocale, brief: string): string {
  if (locale === "ru") {
    return [
      "[Команда /spec]",
      `Фича: ${brief}.`,
      "",
      "Работай по документу context-efficiency.md из reference audit-kit.",
      "1. Задай не более 5 уточняющих вопросов; non-goals, приоритеты и метрики утверждает владелец.",
      "2. Заполни шаблон SPEC.md: контекст, цель, non-goals 3–7, сценарии, R1..Rn (EARS), AC с тестами, инварианты, контракты ссылками, NFR, SC, открытые вопросы, трассировка, DoD.",
      "3. Прогони orch_uni_context_lint (если доступен) и context-lint; покажи diff и открытые вопросы.",
      "4. Канонический SPEC.md не меняй без подтверждения; правки — через fix-runner.",
    ].join("\n")
  }
  return [
    "[Command /spec]",
    `Feature: ${brief}.`,
    "",
    "Follow context-efficiency.md from the audit-kit reference.",
    "1. Ask at most 5 clarifying questions; non-goals, priorities and success metrics are owned by the owner.",
    "2. Fill the SPEC.md template: context, goal, 3–7 non-goals, scenarios, R1..Rn (EARS), AC with tests, invariants, contract links, NFRs, success metrics, open questions, traceability, DoD.",
    "3. Run orch_uni_context_lint (when available) and context-lint; show the diff and open questions.",
    "4. Do not change the canonical SPEC.md without approval; apply fixes through fix-runner.",
  ].join("\n")
}

/** Register `/agents-md` and `/spec`; the cleanup disposes the transform registration. */
export async function registerKitCommands(ctx: Plugin.Context, locale: CommandLocale): Promise<Plugin.Cleanup> {
  let existing = new Set<string>()
  try {
    const listed = await ctx.command.list()
    existing = new Set(listed.data.map((command) => command.name))
  } catch {
    // No listing API: register; the host resolves a collision on its side.
  }
  const registration = await ctx.command.transform((editor) => {
    if (!existing.has("agents-md")) {
      editor.add({
        name: "agents-md",
        description: DESCRIPTIONS[locale].agentsMd,
        execute: async (input) => {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: agentsMdPrompt(
              locale,
              commandArgs(input.prompt.text) || (locale === "ru" ? "текущий репозиторий" : "the current repository"),
            ),
            ...(input.prompt.files === undefined ? {} : { files: input.prompt.files }),
            ...(input.prompt.agents === undefined ? {} : { agents: input.prompt.agents }),
            ...(input.prompt.skills === undefined ? {} : { skills: input.prompt.skills }),
            delivery: input.delivery,
          })
        },
      })
    }
    if (!existing.has("spec")) {
      editor.add({
        name: "spec",
        description: DESCRIPTIONS[locale].spec,
        execute: async (input) => {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: specPrompt(
              locale,
              commandArgs(input.prompt.text) ||
                (locale === "ru" ? "описание фичи не задано — спроси" : "no feature brief — ask for one"),
            ),
            ...(input.prompt.files === undefined ? {} : { files: input.prompt.files }),
            ...(input.prompt.agents === undefined ? {} : { agents: input.prompt.agents }),
            ...(input.prompt.skills === undefined ? {} : { skills: input.prompt.skills }),
            delivery: input.delivery,
          })
        },
      })
    }
  })
  return async () => {
    await registration.dispose()
  }
}
