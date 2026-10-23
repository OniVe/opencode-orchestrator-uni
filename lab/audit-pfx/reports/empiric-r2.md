# Эмпирический аудит pfx — re-audit (круг 2)

Ревизия: `c7f4231` (aggregate `07552a62edd1e3f622c7d0ac5a3a89cb2d31e19e560505723114e5ab7b166a7f`, 95 файлов; диапазон `291a357..c7f4231`, 13 файлов, +69/−46).
Роль: empiric (read-only). Эксперименты — в temp-каталогах; репозиторий не изменялся (`git status` пуст).

## Резюме

Вердикт: **ready**. Все MAJOR и MINOR круга 1 закрыты, регрессий нет:

- **M1** — закрыта: `git worktree add -b fix/r2-1 <вне дерева> <base>` даёт ветку (rc=0), `detached + git switch -c` даёт ветку (rc=0); preflight в fix-runner:12, сведение по SHA, запрет удалять worktree до переноса.
- **M2** — закрыта на уровне правил: session_move / cd+абсолютные пути, иначе параллельный запуск запрещён — во всех 4 носителях обеих локалей.
- **M3** — закрыта: остатков «в одном пространстве» — 0 (`git grep` rc=1); норма о непересечении **наборов файлов** безусловна в 10 носителях + §7.
- **M4** — закрыта в части параллельного класса (одни файлы двумя писателями больше не разрешены); смысловой guard норм остаётся принятым MINOR-бэклогом.
- **m1–m7, M11** — закрыты; проверка шла по тексту и прогонами (worktree/merge/stash, схема+валидатор, мутации).

Регрессии: guard'ы зелёные (12/12, 91/91, biome 0), заголовки/фенсы совпали с 291a357 по всем 12 md, EN без кириллицы, aggregate совпал.

Новое (MINOR, не блокирует): N1 — schema↔template не покрыт тестами (удаление `workspace` из схемы оставляет всё зелёным); N2 — «workspace обязателен» не выражено в `required` (отчёт без workspace валиден); N3 — сведение по SHA сохраняет класс «молчаливого no-op» (повторный merge → `Already up to date` rc=0, пустая дельта) без критерия «не сведено»; N4 — запрет ref-мутаций только у fix-runner, тогда как `agents/*/empiric.md:19` всё ещё предписывает `git stash` (замер: stash виден в чужом worktree, `stash pop` применяет чужие изменения туда).

## Замеры круга 2

| Что | Команда | Результат |
|---|---|---|
| Ревизия | `orch_uni_snapshot` | aggregate `07552a62…a7f`, 95 файлов |
| Guard'ы | `locale-check` / `bun test` / `biome` | rc=0 12/12 · rc=0 91 pass · rc=0 33 файла |
| Структура/локаль | h/fence по 12 md; grep кириллицы | совпало с 291a357; `EN_HAS_CYRILLIC=no` |
| Ветка (основной путь) | `git worktree add -b fix/r2-1 <outside> <base>` | rc=0, HEAD на `fix/r2-1` |
| Ветка (worktree_create) | detached + `git switch -c` | rc=0, HEAD на `fix/r2-2` |
| Сведение по SHA | `git merge <sha>`; повтор | rc=0 с дельтой; повтор → `Already up to date` rc=0, дельта пуста |
| Схема↔шаблон | `checkReport` из кода репозитория | полный workspace valid; без base_commit / строкой — invalid |
| Мутация схемы | удалён `properties.workspace` | test rc=0, locales rc=0, biome rc=0 (не поймано) |
| Мутация шаблона | удалена строка в RU | locales rc=1 (11/12), test rc=1 (1 fail) |
| refs/stash | stash в main → list/pop в worktree фиксера | тот же `stash@{0}`; `pop` применил чужое изменение (rc=0) |

## Находки круга 2

- **N1 (MINOR)** — schema↔template не защищён тестами: удаление `workspace` из схемы проходит зелёным.
- **N2 (MINOR)** — «workspace обязателен» не выражено в `required`; отчёт без workspace валиден.
- **N3 (MINOR)** — SHA-сведение сохраняет молчаливый no-op при уже влитом коммите; нет критерия «пустая дельта ⇒ не сведено».
- **N4 (MINOR)** — запрет ref-мутаций только у fix-runner; `empiric.md:19` рекомендует `git stash` (кросс-worktree перенос чужих изменений измерен).

## Открытые вопросы

Валидатор MCP-инстанса принимает `workspace: "fix/r2-1"` (valid=true) — он держит схему, загруженную до c7f4231; код репозитория на этой ревизии корректно отклоняет. Требуется перезагрузка плагина после изменения схем (механизм кеша не проверен).

```json
{
  "schema": "empiric/v1",
  "verdict": "ready",
  "claims_checked": [
    {
      "claim": "Состояние: HEAD=c7f4231, дерево чистое, ровно 13 заявленных файлов",
      "method": "run",
      "command": "git status --porcelain; git log --oneline -1; git diff --name-status 291a357..c7f4231; git diff --stat 291a357..c7f4231",
      "rc": "0",
      "result": "status пуст; HEAD=c7f4231; 13 файлов ровно по списку (agents 4, docs 8, schemas/fix-runner.v1.json); 69 вставок / 46 удалений",
      "verdict": "confirmed"
    },
    {
      "claim": "Ревизия состояния = 07552a62…a7f, 95 файлов",
      "method": "measure",
      "command": "orch_uni_snapshot(exclude lab, eval/results)",
      "rc": "0",
      "result": "aggregate=07552a62edd1e3f622c7d0ac5a3a89cb2d31e19e560505723114e5ab7b166a7f, files=95 (совпало с заявленной ревизией)",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессий нет: guard'ы зелёные, структура md и EN-локаль целы",
      "method": "run",
      "command": "bun tools/locale-check.ts; bun test ./test/; npx biome check .; сравнение заголовков/фенсов 291a357 vs c7f4231 по 12 md; grep кириллицы в agents/en docs/en",
      "rc": "0",
      "result": "12/12 ok; 91 pass/0 fail/759 expect; biome 0 (33 файла); h/fence совпали по всем 12 md (call-mechanics 22/20, root-runbook 7/2, process-ready-loop 6/2, instruction 5/0, агенты 0/0); EN_HAS_CYRILLIC=no",
      "verdict": "confirmed"
    },
    {
      "claim": "M1 закрыта: основной путь даёт ветку, worktree вне дерева, коммит переносится по SHA, worktree не удаляется до переноса",
      "method": "run",
      "command": "git worktree add -b fix/r2-1 <outside> <base>; git worktree add <outside> <base> + git switch -c fix/r2-2; git -C <wt> rev-parse --abbrev-ref HEAD",
      "rc": "0",
      "result": "add -b → 'Preparing worktree (new branch fix/r2-1)', HEAD на ветке fix/r2-1 (rc=0); detached + switch -c → 'Switched to a new branch fix/r2-2' (rc=0); preflight-правило зафиксировано в agents/*/fix-runner.md:12 и root-runbook:29/call-mechanics:114 (сведение по SHA, запрет удаления до переноса)",
      "verdict": "confirmed"
    },
    {
      "claim": "M2 закрыта: посадка сессии задана (session_move, иначе cd+абсолютные пути), иначе параллельный запуск запрещён",
      "method": "source",
      "command": "git grep -n 'session_move' -- agents docs",
      "rc": "0",
      "result": "4 носителя × 2 локали: agents/*/orchestrator.md:49, docs/*/call-mechanics.md:114, docs/*/root-runbook.md:29, docs/*/instruction-other-session.md:30; формулировка 'ни то ни другое — параллельный запуск запрещён'",
      "verdict": "confirmed"
    },
    {
      "claim": "M3 закрыта: единая безусловная норма про пересечение наборов файлов, остатков «в одном пространстве» нет",
      "method": "run",
      "command": "git grep -n 'в одном пространстве|in the same workspace' -- agents docs; sed -n '18p;48p' agents/ru/orchestrator.md",
      "rc": "1",
      "result": "0 совпадений (rc=1 — не найдено); строка 18: 'писатель один на рабочее пространство; несколько fix-runner — только в изолированных рабочих пространствах и без пересечения наборов файлов'; строка 48: 'Не запускай двух писателей, чьи наборы файлов могут пересечься, — безусловно, даже в разных пространствах'; та же норма в §7 call-mechanics (ru/en), root-runbook:29, fix-runner:11",
      "verdict": "confirmed"
    },
    {
      "claim": "M4 закрыта в части параллельного класса: правка одних файлов двумя писателями запрещена, сведение — по SHA с проверками на сведённом состоянии",
      "method": "source",
      "command": "git grep -n 'пересечься|may overlap' -- agents docs",
      "rc": "0",
      "result": "запрет безусловен во всех 10 носителях; fix-runner rule 11: 'общий файл/класс с другим писателем — needs_decision, не правь'; остаток (смысловой guard норм) — принятый MINOR-бэклог (решение арбитра R1), не регрессия",
      "verdict": "confirmed"
    },
    {
      "claim": "m1 закрыта: плоское «писатели — последовательно» удалено",
      "method": "run",
      "command": "git grep -n 'писатели — последовательно|writers — sequentially' -- agents docs",
      "rc": "1",
      "result": "0 совпадений (rc=1); строка 18 переформулирована на 'писатель один на рабочее пространство'",
      "verdict": "confirmed"
    },
    {
      "claim": "m2 закрыта: дельта раунда считается через git diff <round-base>..HEAD --stat",
      "method": "run",
      "command": "git grep -n 'round-base' -- docs",
      "rc": "0",
      "result": "root-runbook:29 (ru/en), call-mechanics 'Root проверяет дельту', instruction:5 — во всех трёх документах обеих локалей; формулировка 'не только git show --stat'",
      "verdict": "confirmed"
    },
    {
      "claim": "m3 закрыта: объект workspace {branch, worktree, base_commit} есть в схеме и в SGR-шаблоне обеих локалей",
      "method": "run",
      "command": "bun -e проверка схемы репозитория + checkReport из lib/report-schema.ts; grep workspace в agents/*/fix-runner.md",
      "rc": "0",
      "result": "schemas/fix-runner.v1.json: properties.workspace с required [branch, worktree, base_commit]; шаблоны ru/en содержат строку workspace; checkReport: workspace={branch,worktree} → invalid '$.workspace.base_commit required field is missing'; workspace='fix/r2-1' → invalid 'expected type object, got string'; workspace.branch=42 → invalid; полный workspace → valid",
      "verdict": "confirmed"
    },
    {
      "claim": "m4 закрыта: установка зависимостей в свежем worktree до прогонов",
      "method": "source",
      "command": "git grep -n 'npm ci' -- agents docs",
      "rc": "0",
      "result": "agents/*/fix-runner.md:12 ('В свежем worktree поставь зависимости (npm ci / bun install) до прогонов, иначе stand: unavailable') и root-runbook:29; согласуется с замером r1 (без установки guard rc=1, установка 18.2 s)",
      "verdict": "confirmed"
    },
    {
      "claim": "m5 закрыта: сведение отражено в process-ready-loop",
      "method": "run",
      "command": "grep -n '2a|СВЕДЕНИЕ|CONSOLIDATION' docs/*/process-ready-loop.md",
      "rc": "0",
      "result": "оба файла: узел '[2a] СВЕДЕНИЕ (если фиксеров было несколько: сведение веток по commit SHA → проверки на сведённом состоянии)' + критерий 4 'X1 достигается сведением... closed ставится после сведения'",
      "verdict": "confirmed"
    },
    {
      "claim": "m6 закрыта: no_report, budget_exceeded, worktree remove --force, запрет слияния без отчёта",
      "method": "run",
      "command": "for t in no_report 'worktree remove --force'; do grep -c $t docs/{ru,en}/{root-runbook,call-mechanics}.md; done",
      "rc": "0",
      "result": "no_report: root-runbook 2/2, call-mechanics 1/1; worktree remove --force: 1/1 в обоих; текст: 'ветку/коммиты НЕ сливать', 'приоритет — resume в том же worktree', 'частичный коммит без отчёта в основную ветку не вливается'",
      "verdict": "confirmed"
    },
    {
      "claim": "m7 закрыта: instruction-other-session содержит полный состав механики",
      "method": "source",
      "command": "git grep -n 'session_move|cat-file -t|round-base|file set|наборов файлов' docs/*/instruction-other-session.md",
      "rc": "0",
      "result": "в обеих локалях: worktree вне дерева + ветка fix/<round>-<n> + непересечение наборов файлов + session_move/cd + сведение по commit SHA + git diff <round-base>..HEAD --stat",
      "verdict": "confirmed"
    },
    {
      "claim": "M11 закрыта: «инструменты стенда (если поставляются)»",
      "method": "source",
      "command": "grep -n 'если поставляются|if shipped' agents/*/fix-runner.md",
      "rc": "0",
      "result": "ru: 'инструменты стенда (если поставляются) — в каталоге комплекта'; en: 'the stand's tools (if shipped)'",
      "verdict": "confirmed"
    },
    {
      "claim": "Схема↔шаблон покрыты поставляемыми тестами (несущая способность)",
      "method": "measure",
      "command": "temp-копия: удаление блока workspace из schemas/fix-runner.v1.json → bun test / locale-check / biome; отдельно удаление строки workspace только из agents/ru/fix-runner.md",
      "rc": "0",
      "result": "удаление workspace из схемы: test rc=0 (91 pass), locales rc=0 (12/12), biome rc=0 — НЕ поймано; удаление workspace из RU-шаблона: locales rc=1 (11/12), test rc=1 (1 fail) — поймано (паритет локалей)",
      "verdict": "refuted"
    },
    {
      "claim": "Сведение по SHA защищает от молчаливого no-op",
      "method": "measure",
      "command": "git merge --no-edit <sha> (полный SHA фиксера); повторный git merge того же SHA; git diff --stat HEAD",
      "rc": "0",
      "result": "первый merge rc=0 с дельтой ('f.txt | 1 +'); повторный merge того же SHA → 'Already up to date.' rc=0, git diff --stat HEAD пусто (rc=0); git cat-file -t <sha> → 'commit' (rc=0) — тип проверен, но «уже влит» этим не отличить",
      "verdict": "refuted"
    },
    {
      "claim": "Запрет git stash у fix-runner достаточен (refs/stash общий для worktree)",
      "method": "measure",
      "command": "в main: git stash push -m empiric-before-baseline; в worktree фиксера: git stash list; git stash pop",
      "rc": "0",
      "result": "stash в main rc=0; в worktree фиксера git stash list видит тот же stash@{0} (rc=0); git stash pop в worktree применил чужое изменение (M f.txt), 'Dropped refs/stash@{0}' — rc=0. Значит рекомендация agents/*/empiric.md:19 ('git stash') под параллельными worktree переносит чужие незакоммиченные изменения в пространство фиксера",
      "verdict": "refuted"
    }
  ],
  "modes_measured": [
    {
      "operation": "сведение результатов фиксеров по commit SHA",
      "regimes": [
        "свежий SHA (есть дельта)",
        "повторный/уже влитый SHA",
        "несуществующий объект"
      ],
      "best": "свежий SHA: merge rc=0, дельта 'f.txt | 1 +'; cat-file -t → commit (rc=0)",
      "worst": "уже влитый SHA: 'Already up to date.' rc=0 при пустой дельте (git diff --stat HEAD пусто) — молчаливый no-op сохраняется, отличать только по дельте",
      "budget_claim": null,
      "measured": "замер на temp-репо, 2 ветки: SHA 139ecc8 → merge rc=0; повтор → rc=0 без дельты; второй SHA b620806 → rc=0 с дельтой"
    },
    {
      "operation": "несущая способность guard'ов на новом контракте",
      "regimes": [
        "схема без workspace (контракт)",
        "RU-шаблон без workspace (паритет локалей)"
      ],
      "best": "удаление строки из RU-шаблона: locale-check rc=1 (11/12), test rc=1 (1 fail) — паритет локалей реагирует",
      "worst": "удаление поля из схемы: test rc=0 (91 pass), locale-check rc=0 (12/12), biome rc=0 — контракт не защищён",
      "budget_claim": null,
      "measured": "2 мутации: 1 обнаружена, 1 пропущена (та же асимметрия, что в r1: тесты держат форму, не контракт)"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение",
      "status": "applied",
      "note": "В temp-репо воспроизведены: git worktree add -b (ветка), detached + switch -c, merge по SHA и повторный merge (no-op), git stash через два worktree; мутации схемы/шаблона — во временной копии репозитория"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "13 файлов/69+46; 95 файлов; 12/12; 91/759; biome 33 файла; 0 совпадений остаточных формулировок; 2 мутации (1 поймана, 1 нет)"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора",
      "status": "applied",
      "note": "Guard'ы и snapshot пересчитаны на c7f4231; заявленных бюджетов времени в диффе нет"
    },
    {
      "item": 4,
      "title": "Сравнение с базой",
      "status": "applied",
      "note": "Заголовки/фенсы 291a357 vs c7f4231 по всем 12 md; полный дифф 291a357..c7f4231"
    },
    {
      "item": 5,
      "title": "Факты окружения из команд",
      "status": "applied",
      "note": "git worktree list, rev-parse, cat-file, bun 1.4.2 — из прогонов; конфиг плагина (file://repo) прочитан из ~/.config/opencode/opencode.json"
    },
    {
      "item": 6,
      "title": "Первоисточники",
      "status": "applied",
      "note": "Читал lib/report-schema.ts (поддержка type/const/enum/required/properties/items), schemas/fix-runner.v1.json, test/*; валидация проверена кодом репозитория, а не только MCP-инструментом"
    },
    {
      "item": 7,
      "title": "Прототип в нескольких режимах",
      "status": "applied",
      "note": "Сведение по SHA в трёх режимах; мутации контракта в двух; назван худший режим"
    },
    {
      "item": 8,
      "title": "Крайние значения",
      "status": "applied",
      "note": "workspace: отсутствует → valid; неполный → invalid; строка вместо объекта → invalid; branch=42 → invalid; status=no_report → invalid (enum)"
    },
    {
      "item": 9,
      "title": "Оценки без замера",
      "status": "applied",
      "note": "Числовых бюджетов в диффе нет; непроверяемое — в not_verified"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто во всех местах",
      "status": "applied",
      "note": "Проверены все 10 носителей + process-ready-loop + schema + шаблоны: норма о наборах файлов, session_move, round-base, cat-file -t, no_report присутствуют во всех парах ru/en (счётчики совпадают)"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном",
      "status": "applied",
      "note": "Эталон — git: worktree add -b даёт ветку (rc=0), switch -c в detached даёт ветку (rc=0); merge по SHA ведёт себя как merge по имени (no-op при влитом коммите) — это учтено в N3"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы",
      "status": "applied",
      "note": "snapshot совпал с заявленным aggregate; guard'ы прогонялись дважды (репо и temp-копия) с одинаковыми счётчиками; крайние формы workspace проверены"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "Валидация через MCP-инструмент и через код репозитория разошлась (см. not_verified/наблюдение): MCP-инстанс держит старую схему в памяти; счётные крайности workspace проверены"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей",
      "status": "applied",
      "note": "workspace теперь доезжает: схема → шаблон → отчёт → сведение по base_commit/SHA; остаток — «обязательность» не выражена в required (N2)"
    },
    {
      "item": 15,
      "title": "Непроверенное не как факт",
      "status": "applied",
      "note": "Перемещение живой дочерней сессии и точная причина устаревшей схемы в MCP-инстансе — в not_verified"
    },
    {
      "item": 16,
      "title": "Дисциплина rc",
      "status": "applied",
      "note": "rc зафиксированы по каждому прогону (0/1/128 где применимо); grep без совпадений помечен rc=1"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "Спецификация — контракт+паритет локалей: 2 мутации (схема/шаблон) + 5 граничных отчётов; статистика 1/2 обнаружено"
    },
    {
      "item": 18,
      "title": "Тесты — объект аудита",
      "status": "applied",
      "note": "Найдена асимметрия: паритет локалей ловит удаление поля из шаблона (красный), но удаление поля из схемы проходит зелёным — schema↔template не покрыт (N1)"
    },
    {
      "item": 19,
      "title": "База без git",
      "status": "not_applicable",
      "note": "История полная, база 291a357 доступна"
    }
  ],
  "findings": [
    {
      "id": "N1",
      "severity": "MINOR",
      "location": "schemas/fix-runner.v1.json + test/ (пробел сетки)",
      "mechanism": "Новое поле контракта не защищено тестами: удаление блока workspace из схемы не красит ни один guard (91 pass, 12/12, biome 0), тогда как удаление строки из RU-шаблона красит (11/12). Значит schema↔template-консистентность держится только руками; при следующем рефакторинге схемы поле может исчезнуть незаметно.",
      "evidence": "temp-копия c7f4231: bun -e удалил properties.workspace (9 строк) → bun test rc=0 (91 pass), locale-check rc=0 (12/12), biome rc=0; откат, затем удаление 'workspace' только из agents/ru/fix-runner.md → locale-check rc=1 (11/12), test rc=1 (1 fail)",
      "fix": "Добавить в test/consistency.test.ts проверку: каждое свойство схемы агента присутствует в его SGR-шаблоне (обе локали) и наоборот — либо генерировать шаблон из схемы."
    },
    {
      "id": "N2",
      "severity": "MINOR",
      "location": "schemas/fix-runner.v1.json (required) + agents/*/fix-runner.md (проза «обязателен»)",
      "mechanism": "Проза говорит «при запуске в отдельном рабочем пространстве объект workspace обязателен», но в required схемы его нет (условие «параллельный запуск» в данных отчёта не выражено). Валидатор репозитория принимает отчёт без workspace (valid=true), т.е. сведение по branch/base_commit может остаться без входных данных — требование держится только на дисциплине.",
      "evidence": "checkReport из lib/report-schema.ts на c7f4231: noWorkspace → valid:true; fullWorkspace → valid:true; missingBase → valid:false ('$.workspace.base_commit required field is missing'); workspace='fix/r2-1' → valid:false ('expected type object, got string')",
      "fix": "Либо ввести в отчёт явный маркер режима (например, results[].status или поле mode) и if/then-требование workspace, либо переформулировать прозу: «workspace обязателен, если фиксер запущен в отдельном пространстве; валидатор проверяет только его внутреннюю полноту»."
    },
    {
      "id": "N3",
      "severity": "MINOR",
      "location": "docs/*/root-runbook.md:29, docs/*/call-mechanics.md §5 (сведение по SHA)",
      "mechanism": "Сведение по SHA снимает путаницу имён, но не класс «молчаливого no-op»: merge уже влитого SHA даёт rc=0 'Already up to date' с пустой дельтой. В документах нет критерия «пустая дельта ⇒ сведение не состоялось, closed не ставить»; защита — только шаг проверки дельты root'ом, который можно пропустить, не заметив этого.",
      "evidence": "temp-репо: git merge --no-edit 139ecc8 → rc=0, 'f.txt | 1 +'; повторный git merge того же SHA → rc=0, 'Already up to date.', git diff --stat HEAD → пусто (rc=0); git cat-file -t 139ecc8 → 'commit' (rc=0)",
      "fix": "В шаг сведения добавить жёсткий критерий: после каждого merge/cherry-pick дельта `git diff --stat <pre>..HEAD` непуста, иначе статус `not_consolidated` + разбор; в отчёт root'а — список SHA→дельта."
    },
    {
      "id": "N4",
      "severity": "MINOR",
      "location": "agents/ru/empiric.md:19 (=agents/en/empiric.md:19) vs agents/*/fix-runner.md:11",
      "mechanism": "Запрет ref-мутаций введён только для fix-runner с верным обоснованием «refs/stash общий для всех worktree», но промпт empiric по-прежнему предписывает `git stash` для сравнения с базой. Замер показывает: stash, созданный в основном пространстве, виден в worktree фиксера, и `git stash pop` там применяет чужие незакоммиченные изменения в чужое пространство и удаляет stash. Окно узкое (пара работает на re-audit после сведения), но правило асимметрично и опирается на роль, а не на свойство git.",
      "evidence": "temp-репо: в main `git stash push -m empiric-before-baseline` → rc=0; в worktree фиксера `git stash list` → тот же stash@{0} (rc=0); `git stash pop` → rc=0, 'M f.txt', 'Dropped refs/stash@{0}', в файле появилось 'main-side-uncommitted'",
      "fix": "Заменить в empiric.md:19 `git stash` на `git stash create`/`git show`/`git worktree`/отдельную копию (тот же приём, что уже предписан fix-runner), либо поднять запрет ref-мутаций до общего инварианта процесса для всех ролей на время параллельного раунда."
    }
  ],
  "contract_gaps": [
    {
      "item": "Условная обязательность workspace",
      "where": "schemas/fix-runner.v1.json required; agents/*/fix-runner.md (проза)",
      "why": "JSON-схема не выражает «обязателен при параллельном запуске» без маркера режима в данных — правило остаётся процедурным и непроверяемым"
    },
    {
      "item": "Критерий состоявшегося сведения",
      "where": "root-runbook:29; call-mechanics §5",
      "why": "Не задано, что считать доказательством переноса: наличие SHA/тип commit проверяется, а пустая дельта (уже влит) — нет; нет статуса «не сведено»"
    },
    {
      "item": "Область действия запрета ref-мутаций",
      "where": "agents/*/fix-runner.md:11; agents/*/empiric.md:19",
      "why": "Запрет привязан к роли фиксера, хотя причина (общий refs/stash) относится к любому писателю/проверяющему в многопространственном режиме"
    }
  ],
  "not_verified": [
    {
      "item": "Перемещение живой дочерней сессии фиксера через session_move",
      "why": "Вложенность субагентов ограничена (depth limit 1) — проверить на дочерней сессии нельзя; правило в документах есть, API проверен ранее на собственной сессии"
    },
    {
      "item": "Точная причина расхождения MCP-инстанса orch_uni_validate_report и схемы репозитория",
      "why": "Инструмент принял workspace строкой (valid=true), код репозитория — invalid; конфиг грузит плагин из file:///repo, значит инстанс держит схему, загруженную до c7f4231 (перезагрузка плагина вне моего контроля). Эффект зафиксирован, механизм кеша не проверен"
    },
    {
      "item": "Поведение при N>3 фиксерах и в других версиях git/OpenCode",
      "why": "Замеры на 2 ветках и этой версии git"
    }
  ]
}
```
