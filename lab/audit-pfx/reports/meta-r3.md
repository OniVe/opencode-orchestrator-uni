# Мета-аудит pfx (r3, Фаза 6) — релизные ворота 0.3.0

**Вердикт: pass (gate=pass).** 30 артефактов (9 прежних ролевых SGR + 13 новых + 2 арбитра + 3 верификации + live-experiment + свод + реестр) проходят; открытых MAJOR нет, `closing_list` ред-тима r3 пуст. Ship — после записи владельца о принятии `coverage_gaps`.

Кандидат: `ae6b9e4` (HEAD, дерево: изменения только в `lab/` — `summary-pfx.md`, `risks-pfx.md`, исключены из ревизии); aggregate `53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed` (96 файлов); база `dfa4ee7`; раунды `291a357` → `c7f4231` → `7ab0d82` → `476e9bd` → `816cffa` → `2f5c581` → `ae6b9e4`.

## 1. Перепроверка заявленных пунктов

1. **Evidence.** Новые SGR (fix-runner r3/r4/r5, empiric r3–r6, invariant r3–r6, arbiter-r3, redteam-r3) — 13/13 `valid=true`; у fix-runner proof/stand у каждого result, у empiric `rc` заполнен, у invariant `lines_checked`/closure, у арбитра `prism` в каждом disputes (F1 contract+falsification, F2 contract+falsification, F3 reproducibility+contract). Закрытия R18–R31 подтверждены прогонами (E_SCHEMA_IO, tsc/tools, EN-сироты, детерминизм, README, kit-verify 4/4 и --proj 12/12, свежесть схем живым инструментом). Live-experiment: 4 sessionID, preflight, коммиты/merge; session-транскрипты проверены.
2. **Полнота.** R18/R20/R21/R27 — closed; R19, R22–R26, R28–R31 — accepted-risk с причиной; R1–R17 — ранее closed/accepted. Открытых `open` нет. `closing_list` redteam-r3 = [] (0 MAJOR). T1–T3 redteam-r3 = R29–R31 accepted-risk; G1/G4 — root-доказательства, session-часть — residual gap.
3. **Без ложной уверенности.** Guard'ы (93/93, 12/12, biome 0, tsc 0, kit-verify 4/4) — форма/паритет; несущие свойства держат отдельные load-bearing проверки: freshness-тест краснеет при откате кэша, E_SCHEMA_IO-тест краснеет без try/catch, kit-verify ловит EN-сироту/битую пару. G1/G4: root-эксперимент + `session_v2`/`session_message` (4 сессии fix-runner, каталоги wt1–wt4, preflight-команды/выводы, отчёты с `workspace`/40-hex/stand) — достаточно для закрытия gap 1/4 на уровне root-доказательств; независимая воспроизводимость session-части ред-тимом/парой отсутствует (depth limit) → residual gap для владельца. Непроверенное (npm install, other versions, N4-инцидент, частота F) вынесено в gaps.
4. **Согласованность.** Свод и реестр на ae6b9e4/`53dd7b96…`; статусы R18–R31 совпадают с отчётами; числа r1/r2/r3 сходятся. Поправки: (а) redteam-r3 coverage_gaps #4 «`worktree_create` не вызывался» устарел — `verify-D` (r2) вызвал инструмент и воспроизвёл detached HEAD; в итоговый список не входит, строку в своде/ред-тиме поправить; (б) live-experiment выполнен на базе `7b980c9`, а не `476e9bd`/`ae6b9e4` — preflight/session_move в дельте не менялись (дифф agents/docs — только стенд-строка), G1/G4 валидны, но ревизию эксперимента указывать точнее; (в) risks coverage-раздел помечен meta-r2 и говорит «остаток 5–7» — при записи приёмки добавить npm-потребитель и session-часть (ниже).

## 2. Что перепроверено своими прогонами (r3)

- `git rev-parse HEAD` → `ae6b9e47f737742f7ecb16ded5c206636e4a5deb`; `git status --porcelain` — только `lab/summary` и `lab/risks`; `git diff --stat 7ab0d82..ae6b9e4` — код+lab (lab исключён из снапшота).
- `orch_uni_snapshot` (исключены `lab`, `eval/results`) → `53dd7b96…a8ed`, 96 файлов; `tools/kit-verify.ts` в выборке.
- Guard'ы/стенд: `bun tools/locale-check.ts` 12/12 rc=0; `bun test ./test/` 93 pass/0 fail/770 expect; `npx biome check .` 34 файла rc=0; `bun run typecheck` rc=0; `bun tools/kit-verify.ts` 4/4 rc=0; `--proj .` 12/12 rc=0; `--bogus`/`--proj` без аргумента rc=2 usage.
- Свежесть схем: живой `orch_uni_validate_report` с `workspace` без `base_commit` → `E_INVALID` «$.workspace.base_commit required field is missing»; `workspace` строкой → `invalid`; полный → `valid`.
- Пакет: `package.json.files` без `tools/`; README (обе локали) называет `check:locales`/`verify:kit` и оговорку `stand: unavailable`; `grep kit-sync` — 0.
- Сессии: `session_v2` — 4 id из live-experiment, agent **fix-runner**, parent root, directory wt1–wt4; `session_message` — preflight (`rev-parse --show-toplevel`/branch), отчёты с `workspace`/`base_commit`/40-hex/stand у всех 4; git-часть (4 SHA, parents, 3 merge + 1 ff) сверена redteam-r3.
- SGR: 13 новых `valid=true`; arbiter-r3 valid; прежние 9 + arbiter-fg/n4 + verify-* — valid/parse ok.

## 3. Оценка G1/G4 (пункт 3 задания)

- **G1 (session_move)**: закрыт. Root-эксперимент + `session_v2.directory` = wt1–wt4 + preflight-выводы в `session_message`; 4/4.
- **G4 (реальные LLM-сессии)**: закрыт на уровне root-доказательств: 4 сессии fix-runner, каждая отчиталась `workspace{branch, worktree, base_commit}`, полным SHA, stand; границы файлов соблюдены (по одному probe-N.txt, чужие файлы не тронуты). Независимое воспроизведение session-части ред-тимом/парой невозможно (depth limit) — это **residual gap**, не ложная уверенность.
- **worktree_create**: gap из redteam-r3 **снят** `verify-D` (инструмент вызван, detached HEAD/потеря коммита воспроизведены); в итоговый список не включается.

## 4. Замечания (не блокируют gate)

- `redteam-r3` coverage_gaps #4 (worktree_create) — факт неверен; `verify-D` его закрыл. Свод повторяет строку — поправить при публикации.
- `fix-runner-r4` F1: fail-early на регистрации не восстановлен (нет типизированного канала) — отклонение зафиксировано в R18; это residual к F1, не отдельный открытый пункт.
- `summary-pfx` §«Закрытие coverage_gaps (кандидат 476e9bd)»: live-experiment base `7b980c9`; preflight/session_move в дельте не менялись — G1/G4 валидны, но ревизию эксперимента указывать точнее.
- `risks-pfx` coverage-раздел — снимок meta-r2 («остаток 5–7»); при записи приёмки добавить npm-потребитель и session-часть.
- T1–T3 redteam-r3 — accepted-risk R29–R31 (не gaps); R19 — npm-потребитель accepted-risk; R22–R28 — принятые NIT/MINOR.

## 5. Ship-условие (явно)

**SHIP ⟺ `meta.gate`=pass ∧ `closing_list` пуст/закрыт ∧ `coverage_gaps` приняты владельцем (запись в `risks-pfx.md`; принятие фиксируется root'ом после вердикта).**

Сейчас `gate=pass`, `closing_list=[]`; до записи владельца о принятии 5 gaps ниже ship 0.3.0 не открыт.

## 6. Coverage gaps для принятия владельцем

1. **Gap 5** — N>3 и другие версии git/OpenCode (N=4 проверено).
2. **Gap 6** — N4-stash: механизм подтверждён, инцидент в истории pfx не наблюдался (R16).
3. **Gap 7** — частота прерываний фиксеров (F закрыт правкой, статистики нет).
4. **npm-потребитель** — в установленном пакете нет `tools/`; `verify:kit`/`check:locales` → Module not found, `stand: unavailable`; реальный `npm install` не исполнялся (R19 accepted).
5. **Session-часть live-experiment** — 4 сессии/preflight/workspace подтверждены root-доказательствами и session-транскриптами (мета проверила), но не воспроизведены ред-тимом/парой; residual independent-verification gap.

```json
{
  "schema": "meta/v1",
  "verdict": "pass",
  "gate": "pass",
  "closing_list": [],
  "coverage_gaps": [
    "Gap 5: поведение при N>3 параллельных фиксерах и в других версиях git/OpenCode — N=4 проверено, остальное нет.",
    "Gap 6: N4 (git stash/refs) — механизм подтверждён, фактическое срабатывание в истории прогона pfx не наблюдалось; R16 accepted-risk.",
    "Gap 7: частота прерываний фиксеров не измерена; жизненный цикл F закрыт правкой, вероятность остаётся неизвестной.",
    "npm-потребитель: установленный npm-пакет не содержит tools/; verify:kit/check:locales дают Module not found, stand: unavailable; npm install и поведение реального потребителя не исполнялись (tarball/текст); R19 accepted-risk.",
    "Session-часть live-experiment: 4 сессии/session_move/preflight подтверждены root-артефактами и session-транскриптами (проверены метой), но не воспроизведены ред-тимом/парой (depth limit) — независимая воспроизводимость отсутствует; принять как residual."
  ],
  "reports": [
    {
      "report": "lab/audit-pfx/reports/factcheck-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r3.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r4.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r5.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r6.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r3.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r4.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r5.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r6.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r3.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r4.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r5.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/redteam-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/redteam-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/redteam-r3.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/arbiter-fg.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/arbiter-n4.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/arbiter-r3.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/verify-D.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/verify-E.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/verify-R1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/live-experiment.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/summary-pfx.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/risks-pfx.md",
      "result": "pass",
      "violations": []
    }
  ]
}
```
