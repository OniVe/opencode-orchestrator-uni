# Мета-аудит pfx (r4, Фаза 6) — релизные ворота 0.3.0

**Вердикт: fail (gate=fail).** Новые доказательства npm-потребителя, WSL-git, независимой session-части и P1/R32 подтверждены; останавливает **evidence Gap 6** (0 упоминаний git stash — неверно: запрос по `part` для v2-сессий вакуумный) и **счёт Gap 7** (9 vs 10). После коррекции этих формулировок остаётся только один gap — другие версии OpenCode.

Кандидат: код `ae6b9e4`; HEAD `9f10fab` — lab-only коммит аудит-трейла (код не менялся); aggregate `53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed` (96 файлов); в рабочем дереве только `lab/summary` и `lab/risks`.

## 1. Что подтверждено

- **npm-потребитель** — сам перепроверил: `npm pack` → 39 записей, `tools/` 0; `npm i` в чистый проект → 11 пакетов; `npm run verify:kit` и `check:locales` в пакете → `Module not found` rc=1; оговорки `stand: unavailable` в 6 носителях и README. R19 accepted-risk корректен.
- **WSL git 2.43.0** — `wsl git --version` 2.43.0; `git check-ref-format --branch 'fix/x;id'` → `fix/x;id` rc=0; отчёт r7 даёт 5 проверок с кодами 0/0/0/1/0, совпадающими с 2.56.0. Gap 5 (git-версия) закрыт.
- **Session-часть** — `session_v2`: root `ses_e985fb77…` имеет `parent_id=null`, дочерняя `ses_e985edd5…` — agent fix-runner, `directory=…/pfx-indep/wt1`, `idle_outcome=succeeded`; артефакт `pfx-indep` (repo base `9b269be`, wt1 branch `fix/indep`, commit `8e07610`, `probe.txt +1`, `result.json ok:true`) проверен. Независимая root-сессия действительно пересадила фиксера; P1 (прямой `session_move` недоступен, работает Code Mode) принят **R32**.
- **Gap 7** — в `session_v2` 10 pfx fixer-сессий (5 раундов + 4 live + 1 indep), все `succeeded`, `time_suspended=null`; в отчётах `fix-runner-r1..r5` все статусы closed, `no_report` 0. 0 прерываний подтверждено; вопрос только в числе 9/10.
- **Gap 6 (в корректной области)** — в 10 fixer-сессиях нет `git stash push/pop`; у r1 — только `git stash list` (read-only); live/indep — без stash-команд. Это достаточное основание закрыть Gap 6 **для production fixer-сессий**, но не в формулировке «0 упоминаний во всех 29 pfx-сессиях».

## 2. Несоответствия (адресно)

1. **`empiric-r7` claim 4 / `summary-pfx` стр. 209 / `risks-pfx` п. 7 — ложное «0 упоминаний».**
   Запрос r7 идёт по `part`; у v2-сессий `part` пуст (0 — вакуумный), а 18 совпадений `part` — старые сессии других проектов. В `session_message`: 29 pfx-сессий, **24** содержат строку `git stash` (233 строковых поля, 20 command/code-полей); реальные `git stash`-команды есть в аудит-сессиях воспроизведения (empiric r1 `ses_e991c9e83…`, invariant r1 `ses_e991c9e82…`, arbiter N4 `ses_e98d8fec…`); у fix-runner r1 — `git stash list` (не mutation). Корректно: «0 фактических stash push/pop в 10 fixer-сессиях», а не «0 упоминаний во всех pfx-сессиях». В текущем виде Gap 6 закрыт на неверном evidence.
2. **Счёт Gap 7 — 9 vs 10.** `empiric-r7` claim 5 заголовок «9 (4 live + 5 раундов)», result — 10 (плюс indep probe); `summary-pfx` стр. 210 — 9, Re-audit r7 — 10; `risks-pfx` п. 8 — 9; заявка — 10. Нужно унифицировать: 10 с indep probe либо 9 production + 1 probe; 0 прерываний от этого не меняется.
3. **`summary-pfx` / `risks-pfx` «Gap 6 closed / остаток только OpenCode»** — преждевременно до исправления п. 1; после корректной формулировки (fixer-scoped 0 stash push/pop) остаток действительно только «другие версии OpenCode».

## 3. Согласованность и ship

- Свод/реестр на `ae6b9e4`/`53dd7b96…`; R18–R32 статусы сходятся (R18/R20/R21/R27 closed; R19, R22–R26, R28–R31 accepted; R32 accepted). P1/R32, npm/R19, WSL/5, session/1-4, Gap 7 0 прерываний — подтверждены.
- **SHIP ⟺ `meta.gate`=pass ∧ `closing_list` пуст/закрыт ∧ `coverage_gaps` приняты владельцем (запись в `risks-pfx.md`).** Сейчас `gate=fail` (evidence Gap 6 + счёт Gap 7), `closing_list=[]`; после коррекции формулировок — повторная мета, затем остаётся один gap: другие версии OpenCode.

## 4. Итоговые coverage_gaps для принятия владельцем

- **Другие версии OpenCode** (плагин V2; в среде 2.0.26) — не тестировались. Прочие ранее перечисленные gaps закрыты: npm-потребитель (real pack/install), WSL git 2.43 (5 проверок), session-часть (независимая root-сессия), Gap 6 (fixer-scoped 0 stash push/pop), Gap 7 (0 прерываний), Gap 5 (git-версия).

```json
{
  "schema": "meta/v1",
  "verdict": "fail",
  "gate": "fail",
  "closing_list": [],
  "coverage_gaps": [
    "Другие версии OpenCode (плагин V2; в среде 2.0.26) — не тестировались."
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
      "report": "lab/audit-pfx/reports/empiric-r7.md",
      "result": "fail",
      "violations": [
        {
          "kind": "unverified_as_fact",
          "detail": "Gap 6 заявлен как «0 упоминаний git stash в 29 pfx-сессиях», но запрос шёл по part (у v2-сессий part пуст; 0 вакуумный). В session_message: 29 pfx-сессий, 24 содержат строку git stash (233 строковых поля, 20 command/code-полей); реальные git stash-команды есть в аудит-сессиях воспроизведения N4/M7 (empiric ses_e991c9e83…, invariant ses_e991c9e82…, arbiter ses_e98d8fec…), у fix-runner r1 — только git stash list (read-only); в 10 fixer-сессиях нет push/pop. Корректная формулировка: 0 фактических stash push/pop в fixer-сессиях, не «0 упоминаний во всех pfx-сессиях»."
        },
        {
          "kind": "incomplete_selfcheck",
          "detail": "Gap 7: в claim заголовок «9 (4 live + 5 раундов)», в result — 10 pfx fixer-сессий (5 раундов + 4 live + 1 indep probe); свод стр. 210 и risks стр. 52 пишут 9, Re-audit r7 в своде — 10; пользовательская заявка — 10. Нужно унифицировать определение (10 с indep probe либо 9 production + 1 probe); 0 прерываний/no_report 0 при этом подтверждены."
        }
      ]
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
      "result": "fail",
      "violations": [
        {
          "kind": "unverified_as_fact",
          "detail": "Стр. 209 повторяет «0 упоминаний git stash в pfx-сессиях» (неверно: 24 pfx-сессии содержат строку в session_message, реальные stash-команды — в аудит-сессиях воспроизведения; part для v2 пуст, 0 вакуумный). Стр. 210 — «9 fixer-сессий», Re-audit r7 — «10»; внутреннее расхождение."
        }
      ]
    },
    {
      "report": "lab/audit-pfx/risks-pfx.md",
      "result": "fail",
      "violations": [
        {
          "kind": "unverified_as_fact",
          "detail": "Coverage-раздел, п. 7 повторяет «0 упоминаний git stash в pfx-сессиях» (неверно; запрос по part для v2 вакуумный; в session_message 24 pfx-сессии с упоминаниями, реальные stash-команды — в аудит-сессиях). П. 8 — «9 fixer-сессий», тогда как r7/пользователь — 10; определение не унифицировано. R32 accepted-risk и остаток «другие версии OpenCode» — корректны."
        }
      ]
    }
  ]
}
```
