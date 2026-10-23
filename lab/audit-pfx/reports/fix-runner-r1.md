# Fix-runner, круг 1 (pfx): закрытие A–F + m* — отчёт

Ревизия до правок: `291a357` (main, дерево чистое). Правки: коммит `c7f4231` (13 файлов, только `agents/`, `docs/`, `schemas/`; `lab/` не в коммите). Не запушено.
Обе локали правились парно; после каждого файла — `bun tools/locale-check.ts` (PASS), итог 12/12.

## Резюме

- **A** — одна безусловная норма «писатель один на рабочее пространство; не запускай двух писателей, чьи НАБОРЫ ФАЙЛОВ могут пересечься» в `agents/{ru,en}/orchestrator.md` (:18, :48) и `docs/{ru,en}/call-mechanics.md` (§5 :113, §7 :225); плоское «писатели — последовательно» удалено; «непересекающиеся» отнесено и к спискам, и к явным наборам файлов.
- **B** — непересечение по файлам: в границы вызова фиксера добавлен «набор файлов» (§5 call-mechanics, шаг 5 instruction, передача root-runbook, §4-таблица); root обязан посчитать пересечение наборов до запуска (пересечение ⇒ сериализация/разнесение путей); в `fix-runner.md` — правило 11 (не выходить за набор файлов, общий файл/класс ⇒ `needs_decision`).
- **C** — размещение исполнено: worktree → `session_move({sessionID, directory})`, иначе `cd <абс. путь>` + абсолютные пути, иначе параллельный запуск запрещён; у фиксера — preflight (`rev-parse --show-toplevel` = пространство из границ, `rev-parse --abbrev-ref HEAD` ≠ основная ветка), запрет `git stash`/`git checkout -b`/мутаций refs, установка зависимостей до прогонов.
- **D** — сведение по SHA: основной путь `git worktree add -b fix/<round>-<n> <path> <base>` (`worktree_create` только с немедленным `git switch -c`), worktree вне дерева проекта, `git cat-file -t <sha>` = `commit`, merge/cherry-pick по SHA, имена веток — только после `git check-ref-format --branch`, удаление worktree после подтверждённого переноса, дельта раунда `git diff <round-base>..HEAD --stat`, `closed` и proof — на сведённом SHA; в схеме и шаблоне — `workspace {branch, worktree, base_commit}`.
- **F** — терминальный жизненный цикл: статус `no_report` (root фиксирует worktree/ветку/base SHA, ветку НЕ сливает, приоритет resume в том же worktree), обработка `budget_exceeded` в root-runbook, сведение ветки без отчёта `closed` запрещено.
- **m2/m3/m5/m7/M11** — дельта раунда; поле контракта; шаг `[2a] СВЕДЕНИЕ` в цикле; полный состав правила в instruction:30; стенд «если поставляется».

Проверки на сведённом (закоммиченном) состоянии: `npm test` 91 pass / 0 fail; `npx biome check .` rc=0; `bun tools/locale-check.ts` 12/12; собственная проверка правил 75/75 (на `291a357` — 75 fail), проверка схемы 5/5.

## Отклонения и оговорки

- `отклонение (A)`: §5 `call-mechanics` реализован тремя буллетами вместо одного (норма + механика размещения + механика сведения) — уровни заголовков/фенсы не менялись, смысл нормы дословно один.
- `отклонение (m3)`: «способ переноса» не стал полем отчёта — перенос фиксирован процедурой (merge/cherry-pick по `commit`/`workspace.base_commit`); валидируемыми сделаны `branch`, `worktree`, `base_commit` (как в списке).
- `отклонение (F)`: `no_report` введён как статус **на стороне root** (root-runbook + §5), в enum `fix-runner/v1` не добавлен — по списку (F: «на стороне root»); `results[].status` не расширялся.
- Самоправка `agents/{ru,en}/fix-runner.md`: абсолютное ограничение «не менять собственное определение `fix-runner.md`» конфликтует с заданием; выполнено по явному решению владельца (аудит релиза кита, `case-pfx.md`), frontmatter/permissions не тронуты, изменения только ужесточают правила. Строка ограничения в промпте оставлена без изменений.
- Запуск был одиночным в основном чекауте (границы вызова), поэтому объект `workspace` в этом отчёте опущен; новые правила 11–12 применены в части, применимой к одиночному запуску (набор файлов = целевые пути).

Скрипты проверок (вне коммита, временный каталог): `%TEMP%\opencode\pfx-fix-runner\rules-check.ts` (75 правил: норма/носители/механика/контракт, читает рабочее дерево или ревизию через `git show`) и `%TEMP%\opencode\pfx-fix-runner\schema-check.ts` (5 случаев контракта). Оба запускаются `bun <путь>`; на ревизии `291a357` — rc=1, на текущем состоянии — rc=0.

```json
{
  "schema": "fix-runner/v1",
  "round": "pfx-r1",
  "commit": "c7f42315ea063b4fe3f2711d4241738d56133076",
  "results": [
    {
      "id": "A",
      "status": "closed",
      "change": "agents/ru/orchestrator.md:18,:48 + agents/en/orchestrator.md:18,:48; docs/ru/call-mechanics.md:113,:225 + docs/en/call-mechanics.md — единая безусловная норма «писатель один на рабочее пространство; не запускай двух писателей, чьи НАБОРЫ ФАЙЛОВ могут пересечься»; плоское «писатели — последовательно» удалено; §7 получил строку «непересекающиеся списки не заменяют проверку наборов файлов»",
      "before": "grep -n \"писатели — последовательно|writers — sequentially\" agents/*/orchestrator.md → agents/ru:18, agents/en:18 (совпадения есть); grep -n \"в одном пространстве|in the same workspace\" → :48 обоих (запрет ограничен пространством); git grep -c \"могут пересечься|may overlap\" → 0",
      "after": "grep -n \"писатели — последовательно|writers — sequentially\" agents/*/orchestrator.md → пусто; норма «наборы файлов могут пересечься» — orchestrator 1×2 локали, call-mechanics 2×2 (5 :113 и §7 :225); grep \"в одном пространстве\" → пусто",
      "proof": "bun <tmp>/rules-check.ts 291a357 → rc=1, failures=75 (A/orch-norm 0 совпадений, A/orch-flat-rule-gone сработал); bun <tmp>/rules-check.ts work → rc=0, failures=0 (75/75) — проверка независима от правки и падает на ревизии до неё",
      "stand": "unavailable: tools/kit-verify и tools/kit-sync не поставляются (в tools/ только locale-check.ts); компенсировано собственными воспроизводимыми проверками",
      "tests": "bun tools/locale-check.ts → 12/12 ok rc=0; npm test → 91 pass/0 fail rc=0; npx biome check . → rc=0",
      "note": "отклонение: §5 реализован тремя буллетами (норма/размещение/сведение) при сохранении структуры и дословной нормы; en-локаль без кириллицы, паритет заголовков/фенсов сохранён"
    },
    {
      "id": "B",
      "status": "closed",
      "change": "docs/ru/call-mechanics.md:113 (пересечение по файлам, не по id),:114,:173 (таблица передачи — набор файлов/пространство/ветка/base), шаблон вызова фиксера (:117-121); docs/ru/instruction-other-session.md:30,:52; docs/ru/root-runbook.md:29,:44; agents/ru/fix-runner.md:17,:30 (правило 11 — не выходить за набор файлов, общий файл/класс ⇒ needs_decision); en — зеркально",
      "before": "git grep -c \"Набор файлов|File set\" -- agents docs → 0 по всем файлам; шаблон вызова: \"Границы: <пути/ветка>\" без набора файлов; в root-runbook требование только «непересекающийся список»",
      "after": "grep \"набор файлов\" → call-mechanics:113,:117,:173; root-runbook:29,:44; instruction:30,:52; fix-runner:17,:30; en — \"file set(s)\" в тех же местах; правила B/* (5 шт.) в rules-check проходят",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL B/cm-fileset, B/runbook-fileset, B/instr-fileset (0 совпадений); bun <tmp>/rules-check.ts work → PASS (0 failures)",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "bun tools/locale-check.ts (13 файлов пар) → 12/12; npm test → 91/91",
      "note": "root обязан считать пересечение наборов ДО запуска — зафиксировано в orchestrator:49, call-mechanics:113, root-runbook:29, instruction:30"
    },
    {
      "id": "C",
      "status": "closed",
      "change": "docs/ru/call-mechanics.md:114 (session_move / cd + абсолютные пути / запрет параллельного запуска),:113; docs/ru/root-runbook.md:29; docs/ru/instruction-other-session.md:30; agents/ru/fix-runner.md:31 (preflight: show-toplevel = пространство из границ, abbrev-ref HEAD ≠ основная ветка, иначе needs_decision),:30 (запрет git stash/checkout -b/мутаций refs; для «до» — git stash create/git show/git diff),:31 (зависимости npm ci/bun install до прогонов, иначе stand: unavailable); en — зеркально",
      "before": "git grep -c session_move -- agents docs → 0; git grep -c \"rev-parse --show-toplevel\" -- agents docs → 0; упоминания посадки сессии/каталога отсутствуют",
      "after": "session_move: call-mechanics:114, root-runbook:29, instruction:30 (×2 локали); preflight: fix-runner:31; git stash create: fix-runner:30; npm ci/bun install: fix-runner:31",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL C/cm-session_move, C/runbook-session_move, C/instr-session_move, C/fr-preflight, C/fr-branch-check, C/fr-no-stash, C/fr-deps, C/cm-cd-fallback; work → 0 failures",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "npm test → 91 pass/0 fail; locale-check 12/12",
      "note": "preflight ограничен запуском в отдельном рабочем пространстве, чтобы не запрещать штатный одиночный запуск в основном чекауте"
    },
    {
      "id": "D",
      "status": "closed",
      "change": "docs/ru/call-mechanics.md:114 (worktree add -b fix/<round>-<n>, worktree_create только с git switch -c, worktree вне дерева проекта),:115 (сведение по commit SHA, git cat-file -t, check-ref-format --branch, worktree remove --force после переноса, closed/proof на сведённом SHA); agents/ru/orchestrator.md:49; docs/ru/root-runbook.md:29,:30; docs/ru/instruction-other-session.md:30,:52; agents/ru/fix-runner.md:40 (workspace в шаблоне),:63; schemas/fix-runner.v1.json:10-18 (workspace {branch, worktree, base_commit}); en — зеркально",
      "before": "git grep -c \"worktree add -b\" -- agents docs → 0; git grep -c \"cat-file -t\" → 0; grep -c workspace schemas/fix-runner.v1.json → 0; сведение описано как merge «веток», созданных worktree_create (detached HEAD)",
      "after": "worktree add -b: call-mechanics:114, orchestrator:49 (×2 локали); cat-file -t: call-mechanics:115, orchestrator:49, root-runbook:29,:30, instruction:52; check-ref-format --branch: call-mechanics:115; worktree remove --force: call-mechanics:115, root-runbook:29; schema workspace:10 с required [branch, worktree, base_commit]",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL D/* (7 правил) + m3/schema-workspace; work → PASS; bun <tmp>/schema-check.ts → 5/5 OK (solo valid, workspace valid, missing base_commit/тип/строка — invalid)",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "test/schemas.test.ts (в составе npm test) сверяет шаблон обеих локалей со схемой → 91 pass/0 fail; biome rc=0",
      "note": "отклонение (m3): «способ переноса» фиксирован процедурой (merge/cherry-pick по SHA из отчёта), валидируемы branch/worktree/base_commit; worktree вне дерева проекта закрывает и M9 (снапшот/gitlink), перепривязка proof к сведённому SHA закрывает M6"
    },
    {
      "id": "F",
      "status": "closed",
      "change": "docs/ru/root-runbook.md:29 (no_report: фиксация worktree/ветки/base SHA, ветку НЕ сливать, resume в том же worktree, иначе worktree remove --force + решение по ветке; budget_exceeded; частичный коммит без отчёта не вливается),:30 (closed на сведённом SHA; closed без отчёта запрещён); docs/ru/call-mechanics.md:115 (то же в §5); en — зеркально",
      "before": "git grep -c no_report -- agents docs schemas → 0; в root-runbook нет обработки budget_exceeded; уборка worktree/ветки не описана (grep \"worktree remove\" → 0)",
      "after": "no_report: call-mechanics:115, root-runbook:29,:30; budget_exceeded: root-runbook:29; worktree remove --force: call-mechanics:115, root-runbook:29; «НЕ сливать»: root-runbook:29",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL F/cm-no_report, F/runbook-no_report, F/runbook-budget_exceeded, F/runbook-no-merge-unreported, F/runbook-worktree-remove; work → 0 failures",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "locale-check 12/12; npm test 91/91",
      "note": "отклонение: no_report введён как статус root'а (в enum fix-runner/v1 не добавлен) — по списку F; это закрывает и invariant M5 (терминальный переход + уборка)"
    },
    {
      "id": "m2",
      "status": "closed",
      "change": "docs/ru/call-mechanics.md:125 и docs/ru/root-runbook.md:29, docs/ru/instruction-other-session.md:52 — дельта раунда через `git diff <round-base>..HEAD --stat` (не только `git show --stat`)",
      "before": "git grep -n \"git show --stat\" -- docs agents → call-mechanics:121, root-runbook:29, instruction:52 (в обеих локалях)",
      "after": "git grep -n \"git show --stat\" → только пояснение «не только git show --stat»; `git diff <round-base>..HEAD --stat` → call-mechanics:125, root-runbook:29, instruction:52 (обе локали)",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL m2/cm-delta, m2/runbook-delta; work → PASS",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "npm test 91/91; locale-check 12/12",
      "note": "формулировка «не только» сохраняет старую команду как дополнительную"
    },
    {
      "id": "m3",
      "status": "closed",
      "change": "schemas/fix-runner.v1.json:10-18 — опциональный объект workspace {branch, worktree, base_commit} (все строки, required внутри объекта); agents/ru/fix-runner.md:40 (шаблон),:63 (обязанность назвать ветку/worktree/base_commit),:39 (workspace обязателен при запуске в отдельном пространстве, опускается при одиночном); en — зеркально",
      "before": "grep -c workspace schemas/fix-runner.v1.json → 0; validate_report с лишним полем branch проходил как valid (требование «назови ветку/worktree» не имело поля в контракте)",
      "after": "schema workspace required=[branch, worktree, base_commit], типы string; шаблон обеих локалей содержит workspace и валидируется; лишний/неверный тип отвергается ($.workspace.base_commit missing, $.workspace.branch expected string)",
      "proof": "bun <tmp>/schema-check.ts → 5/5 OK (rc=0): solo=valid, workspace=valid, missing base_commit=invalid, branch:number=invalid, workspace:string=invalid; на 291a357 тот же скрипт: workspace отсутствует → invalid",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "test/schemas.test.ts: «SGR template of every agent validates against its schema» + enum-альтернативы → npm test 91 pass/0 fail; npx biome check . rc=0 (схема форматирована biome)",
      "note": "объект оставлен опциональным (одиночный запуск) — валидатор не может выразить условие «обязателен только при параллельном запуске» без неподдерживаемых конструкций; обязанность закреплена в промпте фиксера"
    },
    {
      "id": "m5",
      "status": "closed",
      "change": "docs/ru/process-ready-loop.md:25 — шаг [2a] СВЕДЕНИЕ (сведение веток по commit SHA → проверки на сведённом состоянии) перед [3]; :44 (критерий 4) — closed после сведения; docs/en/process-ready-loop.md — зеркально",
      "before": "grep -ci \"сведён|consolidat\" docs/ru/process-ready-loop.md docs/en/process-ready-loop.md → 0 / 0",
      "after": "docs/ru/process-ready-loop.md:25 `[2a] СВЕДЕНИЕ`, :44 «commit SHA»; docs/en — `[2a] CONSOLIDATION`, тот же критерий; оба вхождения ≥1",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL m5/loop-2a, m5/loop-sha; work → PASS",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "locale-check 12/12 (фенсы 2/2); npm test 91/91",
      "note": "шаг вставлен внутрь существующего фенса дерева — структура не менялась"
    },
    {
      "id": "m7",
      "status": "closed",
      "change": "docs/ru/instruction-other-session.md:30 — полный состав правила (наборы файлов, ветка fix/<round>-<n>, worktree вне дерева проекта, session_move/cd, сведение по SHA, проверки на сведённом состоянии); :52 — шаблон вызова с набором файлов/worktree/веткой/base и дельтой; en — зеркально",
      "before": "строка 30 содержала только «непересекающиеся списки + сведение»; grep -c session_move/cat-file -t в instruction → 0",
      "after": "instruction:30 (session_move, наборы файлов, сведение по SHA), :52 (file set/workspace/branch/base, git diff … --stat, cat-file -t)",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL m7/instr-branch, m7/instr-sha, B/instr-fileset, C/instr-session_move; work → PASS",
      "stand": "unavailable: стенд не поставляется (см. A)",
      "tests": "locale-check 12/12; npm test 91/91",
      "note": ""
    },
    {
      "id": "M11",
      "status": "closed",
      "change": "agents/ru/fix-runner.md:28 и agents/en/fix-runner.md — «инструменты стенда (если поставляются)» вместо утверждения наличия tools/kit-verify|kit-sync",
      "before": "agents/*/fix-runner.md: «инструменты стенда — в каталоге комплекта (tools/)», при фактическом наличии только tools/locale-check.ts",
      "after": "fix-runner:28 — «инструменты стенда (если поставляются) — в каталоге комплекта»; формулировка согласована с call-mechanics §5 и root-runbook",
      "proof": "bun <tmp>/rules-check.ts 291a357 → FAIL M11/fr-if-shipped; work → PASS; ls tools/ → locale-check.ts (kit-verify/kit-sync отсутствуют, stand: unavailable корректен)",
      "stand": "unavailable: подтверждено отсутствие tools/kit-verify и tools/kit-sync",
      "tests": "npm test 91/91; locale-check 12/12",
      "note": ""
    }
  ],
  "out_of_scope": [
    {
      "note": "test/support/locales.ts + test/translation.test.ts + tools/locale-check.ts проверяют только форму (файлы, заголовки, фенсы, frontmatter, enum-токены, кириллица); смысловая норма «наборы файлов / безусловный запрет» guard'ом не покрыта",
      "why_suspicious": "удаление новых нормативных предложений оставляет 12/12 и 91/91 зелёными (empiric MUT-A, invariant M10); это бэклог R1 (risks-pfx.md), вне closing_list — правку не делал; класс-проверка выполнена внешним скриптом, в репозиторий не добавлена"
    },
    {
      "note": "test/support/locales.ts:toolIdSet собирает только orch_uni_*; упоминания kit-verify/kit-sync/config-guard в доках не проверяются на существование",
      "why_suspicious": "несуществующий инструмент в прозе проходит зелёным (invariant M10, часть); правка теста — вне списка"
    },
    {
      "note": "agents/{ru,en}/empiric.md:19 рекомендует git stash для «замера до», а refs/stash общий для всех worktree",
      "why_suspicious": "аудитор, работающий параллельно с фиксером, может снять чужую stash-запись (invariant M7); запрет введён только для fix-runner — распространение на аудиторов вне списка"
    }
  ]
}
```
