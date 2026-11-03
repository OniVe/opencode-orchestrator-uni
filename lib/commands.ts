/**
 * Slash commands of the kit: `/agents-md`, `/spec` and `/handoff`.
 *
 * Commands are prompts, not writers: `execute` injects a short workflow prompt
 * into the current session, and the orchestrator runs it with the usual
 * evidence/approval rules. The detailed templates and checklists live in
 * `docs/<locale>/context-efficiency.md` and `docs/<locale>/session-discipline.md`.
 */
import type { Plugin } from "@opencode/plugin"

type CommandLocale = "ru" | "en"

/** Arguments typed after the slash command, without a duplicated command token. */
function commandArgs(text: string): string {
  return text.replace(/^\s*\/(?:agents-md|spec|handoff)\b/i, "").trim()
}

const DESCRIPTIONS: Record<
  CommandLocale,
  { readonly agentsMd: string; readonly spec: string; readonly handoff: string }
> = {
  ru: {
    agentsMd: "Создать или проверить AGENTS.md по шаблону context-efficiency.md.",
    spec: "Создать или проверить SPEC.md по шаблону context-efficiency.md.",
    handoff: "Сформировать handoff среза по шаблону session-discipline.md.",
  },
  en: {
    agentsMd: "Create or audit AGENTS.md using the context-efficiency.md template.",
    spec: "Create or audit SPEC.md using the context-efficiency.md template.",
    handoff: "Write the slice handoff using the session-discipline.md template.",
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

function handoffPrompt(locale: CommandLocale, goal: string): string {
  if (locale === "ru") {
    return [
      "[Команда /handoff]",
      `Срез: ${goal}.`,
      "",
      "Работай по документу session-discipline.md из reference audit-kit.",
      "1. Собери факты только из текущей сессии и рабочего дерева: что сделано, чем подтверждено (команды, тесты, коммиты), что не сделано и почему.",
      "2. Заполни шаблон handoff из session-discipline.md: цель и DoD, сделано, не сделано, решения и причины, риски/принятые ограничения, следующий шаг.",
      "3. Запиши файл `docs/planning/handoff-<YYYY-MM-DD>.md` (нет каталога — корень проекта) инструментом `write`, не shell-heredoc.",
      "4. Ничего не додумывай: неизвестное помечай «не проверено»; секреты и токены в handoff не переноси.",
      "5. Покажи путь файла, краткий diff и открытые вопросы; канонические документы не меняй без подтверждения.",
      "6. Если дерево грязное — предложи коммит по правилам проекта; не коммить без подтверждения владельца.",
    ].join("\n")
  }
  return [
    "[Command /handoff]",
    `Slice: ${goal}.`,
    "",
    "Follow session-discipline.md from the audit-kit reference.",
    "1. Collect facts from the current session and the working tree only: what is done, what proves it (commands, tests, commits), what is not done and why.",
    "2. Fill the handoff template from session-discipline.md: goal and DoD, done, not done, decisions and reasons, risks/accepted limits, next step.",
    "3. Write `docs/planning/handoff-<YYYY-MM-DD>.md` (use the project root when the directory is absent) with the `write` tool, not a shell heredoc.",
    "4. Do not invent facts: mark the unknown as `unverified`; never copy secrets or tokens into the handoff.",
    "5. Show the file path, a short diff and open questions; do not change canonical documents without approval.",
    "6. If the working tree is dirty, propose a commit per the project rules; do not commit without the owner's approval.",
  ].join("\n")
}

/** Register `/agents-md`, `/spec` and `/handoff`; the cleanup disposes the transform registration. */
export async function registerKitCommands(ctx: Plugin.Context, locale: CommandLocale): Promise<Plugin.Cleanup> {
  // The command API is optional in a host build. A missing `list` was already
  // tolerated; a missing `transform` used to throw out of `setup` and take every
  // agent and tool with it, so it degrades to a warning plus a no-op cleanup.
  const command = (ctx as Partial<Plugin.Context>).command
  if (command === undefined || typeof command.transform !== "function") {
    console.warn("orch-uni: this host has no command API; /agents-md, /spec and /handoff are not registered")
    return async () => {}
  }
  let existing = new Set<string>()
  try {
    const listed = await command.list()
    existing = new Set(listed.data.map((item) => item.name))
  } catch {
    // No listing API: register; the host resolves a collision on its side.
  }
  const registration = await command.transform((editor) => {
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
    if (!existing.has("handoff")) {
      editor.add({
        name: "handoff",
        description: DESCRIPTIONS[locale].handoff,
        execute: async (input) => {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: handoffPrompt(
              locale,
              commandArgs(input.prompt.text) ||
                (locale === "ru"
                  ? "текущая сессия — опиши срез по фактам"
                  : "the current session — describe the slice from facts"),
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
