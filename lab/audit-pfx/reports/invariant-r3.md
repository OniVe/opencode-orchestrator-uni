# Аудит pfx — инвариантщик, круг 3 (re-audit)

Состояние: 476e9bd, aggregate 2290e3a9…13e3 (96 файлов = 95 + tools/kit-verify.ts), совпал с заявленным. В рабочем дереве изменены только два lab-файла root'а (вне ревизии). Мои прогоны: kit-verify 4/4 rc=0, npm test 92/92, check:locales 12/12, biome 0.

**Вердикт: not_ready.** 0 MAJOR; 3 MINOR (F1, F2, F3) и 4 NIT. Закрывающий минимум — F2 и F3 (по строке-двум каждый), F1 — рекомендуется; F4–F7 — принять/бэклог.

Закрыто этим изменением: M14 (свежесть схем подтверждена живым валидатором: отчёт с workspace без base_commit → E_INVALID; тест load-bearing — снятие перечитывания даёт 1 fail, проверено мутацией на копии), M15 (запрет refs сужен до чужих + коммит/switch -c разрешены), M12 (hex-гейт 40 симв., ancestor, непустая дельта, sha≠base, пустая дельта ⇒ not_consolidated, нет commit/workspace ⇒ not_closed). M17 остаётся NIT.

F1 (MINOR): битый/отсутствующий schemas/*.json теперь даёт сырое исключение (SyntaxError/ENOENT) вместо структурного кода; fail-early на старте плагина потерян; TOCTOU на полузаписанной схеме. Коды отчётного уровня не изменились (E_NO_JSON/E_PARSE/E_UNKNOWN_SCHEMA/E_INVALID — проверено живьём).
F2 (MINOR, ship-decision): стенд не попадает в публикуемый пакет — npm pack --dry-run: 39 файлов, kit-verify 0 совпадений (files без tools/), при этом kit-verify импортирует test/support/locales (test/ тоже исключён); доки этого же диффа объявляют стенд в каталоге комплекта, а verify:kit в установленном пакете ведёт в никуда.
F3 (MINOR): tools/kit-verify.ts не проходит tsc — при включении tools/** в include: error TS2353 'shell' does not exist in type SpawnOptions; в поставке tsc зелёный только из-за исключения tools/**, т.е. шаг tsc стенда даёт ложное покрытие (и починка include немедленно красит CI).
F4–F7 (NIT): --proj не ловит EN-only сироту (12/12 rc=0 с лишним docs/en/zz-extra.md); вывод не байт-детерминирован (секунды в шагах); устаревший комментарий test/support/locales.ts:3 (lab/locale-check.ts); README без точки входа verify:kit.

Живой эксперимент (G1/G4): git-часть воспроизведена в temp (ветки fix/live-N, toplevel вне проекта, cat-file=commit, ancestor=yes, дельта непуста, 3 merge по SHA rc=0, дерево чистое); session_move 4/4 и «4 реальные LLM-сессии» своим прогоном подтвердить не могу — depth limit субагентов (1) → not_verified; механизм документирован, preflight в любом случае fail-closed.

Регрессий C4 не нашёл: диффом не тронуты «до вердикта не править», запрет push, публикация после ship+владельца, MAJOR-верификация, re-audit=resume; нормы no_report/not_consolidated/hex-гейт на месте (root-runbook:29-30, оба языка). kit-sync не осталось нигде (agents/docs/README/package/tools/lib/test) — 0 совпадений.

```json
{
  "schema": "invariant/v1",
  "verdict": "not_ready",
  "closure": {
    "closed_by_this_change": [
      "M12 (hex-гейт и семантические проверки SHA)",
      "M14 (свежесть схем — живой валидатор)",
      "M15 (refs: чужие вместо любых; коммит/switch -c разрешены)"
    ],
    "closed_in_earlier_rounds": [
      "M1-M3, M5-M9, M11 (r2)",
      "M4 (r2, частично) — остаток закрыт hex-гейтом r3"
    ],
    "still_open_accepted": [
      "M10 (MINOR, бэклог по арбитру)",
      "M13 (MINOR, принят в r2)",
      "M17 (NIT, принят в r2)"
    ],
    "new_in_r3": [
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7"
    ]
  },
  "invariants": [
    {
      "id": "I1",
      "statement": "Один писатель на checkout; фиксер проверяет изоляцию до первой правки (preflight: toplevel, ветка не main/detached, путь не подкаталог проекта).",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I2",
      "statement": "Нет двух фиксеров на пересекающихся файлах; непересечение считается по путям и классу до запуска.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I3",
      "statement": "Безусловная норма «писатель один на пространство; не двух по пересекающимся наборам файлов» едина во всех носителях, включая §7.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I4",
      "statement": "Параллельный фиксер не мутирует чужие refs/stash; свой коммит и switch -c разрешены.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I5",
      "statement": "Прерванный фиксер переводит состояние в терминальное (no_report, ветка не сливается, worktree убирается осознанно).",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I6",
      "statement": "closed и доказательство приёмки — на сведённом состоянии; пустая дельта ⇒ not_consolidated.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I7",
      "statement": "Вердикт привязан к воспроизводимой ревизии; worktree вне дерева проекта не влияет на снапшот.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I8",
      "statement": "Данные из отчёта (SHA, ветка, путь) не становятся git-командой без валидации: 40-hex до git, cat-file/ancestor/delta, чужие пути не используются.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I9",
      "statement": "Механизм изоляции исполним: ветка гарантирована, посадка задана, зависимости ставятся, при недоступности — параллель запрещена.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I10",
      "statement": "C4 не ослаблены: до вердикта не править, запрет push, публикация после ship+владельца, MAJOR-верификация, re-audit=resume.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I11",
      "statement": "Структурно-языковая целостность: заголовки/фенсы, EN без кириллицы, enum-токены, пары локалей, ключевые термины совпадают.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I12",
      "statement": "Живой валидатор применяет текущие схемы (свежесть) и при этом не даёт ложного valid=true.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I13",
      "statement": "Инфраструктурные отказы (битые/недоступные схемы, отсутствие зависимостей у стенда) возвращаются структурно и не выглядят как штатный отказ отчёта; коды отчётного уровня не меняются.",
      "verdict": "violated",
      "counterexample": "F1: T1 в temp-каталоге схем вместо JSON пишется '{ not json'; T2 validate_report → THREW SyntaxError (сырое исключение, не E_*); T3 каталог схем удалён → THREW Error: ENOENT scandir; T4 свежий worktree без node_modules → bun tools/kit-verify.ts падает на импорте 'Cannot find package gray-matter', rc=1, без строк PASS/FAIL и без итога. При этом отчётный уровень цел: E_NO_JSON/E_PARSE/E_UNKNOWN_SCHEMA/E_INVALID (живая проверка)."
    },
    {
      "id": "I14",
      "statement": "Стенд исполним, rc-семантика определена, в объект аудита не пишет, структура вывода детерминирована.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I15",
      "statement": "Стенд проверяет то, что заявлено: типы собственного кода и полноту пар локалей.",
      "verdict": "violated",
      "counterexample": "F3: T1 копия ревизии в temp, include += tools/**/*.ts, tsc -p → 'tools/kit-verify.ts(56,5): error TS2353: Object literal may only specify known properties, and shell does not exist in type SpawnOptions<...>' rc=2; T2 в поставке tsc зелёный и стенд печатает PASS tsc. F4: T3 копия проекта + лишний docs/en/zz-extra.md → 12/12 pairs ok, rc=0 (сирота не видна; при удалённом EN-файле — FAIL 11/12, rc=1)."
    },
    {
      "id": "I16",
      "statement": "Документы ссылаются только на реально поставляемые артефакты (то, что обещано «в каталоге комплекта», попадает в пакет).",
      "verdict": "violated",
      "counterexample": "F2: T1 npm pack --dry-run → 'total files: 39', совпадений kit-verify — 0 (files: index.ts, lib, schemas, agents, docs, READMEs, LICENSE); T2 в установленном пакете docs/fix-runner:9 обещает 'tools/kit-verify каталога комплекта', а 'npm run verify:kit' ведёт на отсутствующий файл; T3 даже при копировании tools/ файл не заработает: он импортирует ../test/support/locales (test/ тоже не поставляется)."
    }
  ],
  "lines_checked": [
    {
      "line": "ОТМЕНА/ТАЙМАУТЫ",
      "status": "checked",
      "note": "Новых точек ожидания нет: reload схем — последовательный await в executor'е, без таймеров; abort проверяется до IO и после чтения (signal.aborted → E_ABORTED). kit-verify ждёт child.exited по каждому шагу без таймаута: зависший бинарь повесит стенд навсегда (fail-closed по смыслу, но без диагностики) — в находки не выношу: бинари локальные, штатные шаги завершаются."
    },
    {
      "line": "СОГЛАСОВАННОСТЬ ПРОИЗВОДНЫХ ДАННЫХ",
      "status": "checked",
      "note": "Схемы читаются на каждый вызов → «снимок схем» больше не расходится с поставкой (закрыт M14). Цена измерена: 0.53 мс на валидацию (100 вызовов). Остаток: каждый вызов — отдельное чтение 8 JSON, полузаписанный файл даёт исключение (F1)."
    },
    {
      "line": "МОНОТОННОСТЬ МЕТОК",
      "status": "checked",
      "note": "Механизм свежести не двигает ревизию состояния: агрегат после прогонов kit-verify и reload-тестов не изменился (2290e3a9…). Отчётность стенда не байт-детерминирована (секунды) — F5; структура (порядок шагов/пар, сортировка, PASS/FAIL, итог) детерминирована: два прогона после снятия таймингов идентичны."
    },
    {
      "line": "ВРАЖДЕБНЫЙ ВВОД",
      "status": "checked",
      "note": "kit-verify: вход — только --proj <dir>; обход ограничен <dir>/agents/ru|en, <dir>/docs/ru|en (не рекурсивно) → обхода каталогов и циклов нет; проверено: родительский каталог → 'no pairs' rc=2, файл вместо каталога → rc=2, путь с пробелами → 12/12 rc=0, отсутствующий EN → FAIL rc=1. spawn: аргументы — литералы (кроме process.execPath), пользовательский путь в spawn не попадает; shell:true только для .cmd (F3 — типы). Симлинки: markdownFiles фильтрует Dirent.isFile() → симлинк-файлы молча выпадают из пар (создать симлинк здесь нельзя — EPERM, not_verified)."
    },
    {
      "line": "ПОЛНОТА КЛАССА",
      "status": "checked",
      "note": "Перебраны все 11 не-lab файлов диффа. kit-sync: 0 совпадений по agents/docs/README/README.ru/package.json/tools/lib/test (было 6). Стенд упомянут в 3 носителях × 2 локали с одинаковыми ключевыми терминами (tools/kit-verify 3/3, --proj 1/1, stand: unavailable 2/2, 'синк'/'sync of copies' 0/0). Все шаги spawn проверены в kit-режиме и в --proj; все ветки меню (--help/нет аргументов/неизвестный флаг/--proj без аргумента) — rc 0/2."
    },
    {
      "line": "КОНТРАКТЫ «НЕИЗВЕСТНО»",
      "status": "checked",
      "note": "rc стенда: 0 — успех, 1 — провал шага/пар, 2 — usage И «нет пар» (два разных смысла одним кодом — contract_gap). 'stand: unavailable' остаётся документированным fallback'ом фиксера. Для схем: отсутствие id → E_UNKNOWN_SCHEMA (структурно), битый JSON → исключение (F1)."
    },
    {
      "line": "ЖИЗНЕННЫЙ ЦИКЛ ПРОЦЕССА",
      "status": "checked",
      "note": "Стенд не оставляет следов: git status до/после идентичен (только 2 lab-файла root'а), агрегат не изменился; biome без --write, tsc --noEmit, bun test в temp-каталогах. Child-процессы дожидаются (exited) до выхода; утечек нет. При отсутствии node_modules стенд падает до первого шага (F1-класс)."
    },
    {
      "line": "ТОЧНОСТЬ ДЕТЕКТОРОВ",
      "status": "checked",
      "note": "Мутация на копии ревизии: убрал перечитывание схем (loadSchemas на регистрации) → 'schema freshness' тест FAIL (16 pass / 1 fail) — тест load-bearing, в отличие от прозаических guard'ов (M10 остаётся). Обратная сторона: путь отказа (битые/отсутствующие схемы) тестом не покрыт (F1), покрытие tools/** типами не проверяется (F3), поставляемость артефактов не проверяется тестом (F2)."
    },
    {
      "line": "ИЗВЕСТНЫЕ ФАКТЫ / УЖЕ УЧТЕНО",
      "status": "checked",
      "note": "Заявления fix-runner-r3 и live-experiment проверены, а не приняты: 92/92 тестов, 12/12 локалей, biome 0, kit-verify 4/4, --proj 12/12, битая пара → FAIL rc=1, пусто → 2 — совпало. git-часть live-эксперимента воспроизведена в temp (3 коммита/3 merge по SHA, rc=0, дельта 1 файл, дерево чистое). session_move 4/4 и «4 реальные LLM-сессии» не воспроизводимы с моего уровня (depth limit) — not_verified."
    }
  ],
  "findings": [
    {
      "id": "F1",
      "severity": "MINOR",
      "location": "lib/tools.ts:351 (loadSchemas внутри executor'а, без try/catch); lib/tools.ts:54-70 (loadSchemas бросает JSON.parse/readdir)",
      "scenario": "T1 schemas/*.json повреждён (правка в процессе, обрыв записи, ручная ошибка) → следующий orch_uni_validate_report бросает SyntaxError, executor не ловит → сырое исключение вместо E_*; T2 каталог схем переименован/недоступен → THREW ENOENT scandir; T3 в свежем worktree без node_modules стенд не стартует ('Cannot find package gray-matter', rc=1, без PASS/FAIL и итога). Воспроизведено через harness-шов schemasDirectory и прогоном kit-verify в копии без node_modules.",
      "consequence": "Ложного valid=true нет (fail-closed), но: (а) fail-early потерян — плагин грузится с битыми схемами, инструмент «есть», но каждый вызов падает; (б) диагностика теряет код/путь — агент видит стек, а не E_SCHEMA_IO, и может списать это на «валидатор недоступен» → ручная проверка вместо инструментальной; (в) окно TOCTOU на полузаписанной схеме при параллельной правке.",
      "fix": "Обернуть reload в try/catch и возвращать failure('E_SCHEMA_IO'/'E_PARSE', message с каталогом и файлом), сохранив fail-closed; добавить тест на битый и на отсутствующий каталог схем; при старте — один «прогревающий» load с тем же структурированным отказом (сохранить fail-early)."
    },
    {
      "id": "F2",
      "severity": "MINOR",
      "location": "package.json:files (нет tools/ и test/); tools/kit-verify.ts:18-19 (import ../test/support/locales); agents/*/fix-runner.md:9, docs/*/call-mechanics.md:126",
      "scenario": "T1 npm pack --dry-run на 476e9bd → 'total files: 39', ни одного совпадения 'kit-verify' (files: index.ts, lib, schemas, agents, docs, README.md, README.ru.md, LICENSE); T2 пользователь ставит 0.3.0 из npm: доки этого же диффа обещают 'инструмент стенда — tools/kit-verify каталога комплекта', script verify:kit ведёт на отсутствующий файл → ENOENT; T3 даже ручное копирование tools/ не спасает: kit-verify импортирует ../test/support/locales, а test/ тоже не поставляется.",
      "consequence": "Стенд, которым закрывали G3, не доезжает до потребителя пакета: в цикле на установленном комплекте каждый фиксер получит stand: unavailable и закроется собственными проверками — ровно тот coverage gap, ради которого стенд добавлен; ни один тест не сверяет «обещано в доках ↔ есть в пакете».",
      "fix": "Добавить 'tools' в files и вынести pairIssues в поставляемый lib/ (импорт из tools/kit-verify и tools/locale-check), либо явно объявить стенд «только для чекаута» во всех 6 носителях; добавить тест: пути, упомянутые в доках/скриптах, ⊆ (files ∪ служебные)."
    },
    {
      "id": "F3",
      "severity": "MINOR",
      "location": "tools/kit-verify.ts:56 (shell: needsShell(...)); tsconfig.json:include",
      "scenario": "T1 копия ревизии в temp, include += 'tools/**/*.ts', tsc -p → 'tools/kit-verify.ts(56,5): error TS2353: Object literal may only specify known properties, and shell does not exist in type SpawnOptions<ignore, pipe, pipe>' rc=2 (bun-types 1.4.3: shell в SpawnOptions не объявлен); T2 в поставке tsc зелёный, стенд печатает PASS tsc; T3 «очевидная починка» include немедленно красит CI и шаг tsc стенда.",
      "consequence": "Шаг tsc стенда и npm run typecheck дают ложное покрытие: новый 169-строчный инструмент — единственный непроверяемый типами файл, и он объективно не проходит tsc. Код работает (biome/tsc-шаги исполняются — .cmd на этой машине проходит), т.е. дефект типовой, а не рантаймовый; но опция shell не входит в типизированный API — держится на неявном свойстве Bun.",
      "fix": "Убрать нетипизированную опцию: на Windows спавнить явно (process.env.ComSpec ?? 'cmd.exe') + ['/c', ...command], иначе — прямой spawn; затем добавить 'tools/**/*.ts' в include и оставить шаг tsc честным."
    },
    {
      "id": "F4",
      "severity": "NIT",
      "location": "tools/kit-verify.ts:105-125 (projectPairs/pairIssueList)",
      "scenario": "T1 в копии проекта появляется docs/en/zz-extra.md без RU-пары → kit-verify --proj → 12/12 pairs ok, rc=0 (пары строятся только по ru-файлам); T2 удаление EN-файла ловится (FAIL 11/12, rc=1).",
      "consequence": "В режиме --proj сироты на стороне EN невидимы (в комплекте их ловит test/translation.test.ts сравнением наборов, но --proj тесты не запускает): устаревший/лишний перевод проходит приёмочный прогон.",
      "fix": "Сравнивать отсортированные наборы имён ru↔en в обе стороны (как translation.test.ts) и печатать 'orphan translation' как FAIL."
    },
    {
      "id": "F5",
      "severity": "NIT",
      "location": "tools/kit-verify.ts:63-66 (printStep: seconds)",
      "scenario": "T1 два прогона подряд дают разный текст ('PASS test (rc=0, 0.2s)' vs '...0.3s'); после снятия таймингов вывод идентичен; T2 поле stand хранит 'baseline … → after …', т.е. буквальное сравнение baseline/after всегда различается.",
      "consequence": "Стенд нельзя использовать как дифф-оракул (baseline→after) без нормализации; для документированного формата stand (итог/rc + краткий вывод) это допустимо, поэтому NIT.",
      "fix": "Добавить --quiet/--no-timing (или убрать секунды из строки шага, оставив их в итоговой строке только при --verbose)."
    },
    {
      "id": "F6",
      "severity": "NIT",
      "location": "test/support/locales.ts:3",
      "scenario": "T1 шапка контракта переводов ссылается на 'the dev checker (lab/locale-check.ts)'; фактический инструмент — tools/locale-check.ts, и с r3 контракт использует ещё и tools/kit-verify.ts.",
      "consequence": "Устаревшая ссылка в шапке контракта, которым пользуются три инструмента; при следующем переносе файлов уводит в несуществующий путь.",
      "fix": "Заменить на tools/locale-check.ts + tools/kit-verify.ts (одна строка)."
    },
    {
      "id": "F7",
      "severity": "NIT",
      "location": "README.md:301-304; README.ru.md (раздел скриптов)",
      "scenario": "T1 README перечисляет typecheck/lint/lint:fix, но не check:locales, не verify:kit и не tools/kit-verify; T2 пользователь пакета не имеет точки входа в стенд (fix-runner правило 9 теперь несёт команду само, но README — витрина).",
      "consequence": "Стенд существует, но не обнаруживается из документации верхнего уровня; для релиза 0.3.0 (новый инструмент) это потеря видимости, а не поломка.",
      "fix": "Добавить в раздел скриптов verify:kit и check:locales (ru/en зеркально)."
    }
  ],
  "contract_gaps": [
    {
      "item": "rc-семантика стенда: 2 используется и для usage-ошибки, и для «нет пар»",
      "where": "tools/kit-verify.ts (докстринг + main/runProjectStand)",
      "why": "Вызывающий не может отличить «нечего проверять» (пустой каталог, не тот путь) от «неверные аргументы»; для --proj это разные решения (ошибка вызова vs пустой проект)."
    },
    {
      "item": "Где «каталог комплекта» у установленного пакета",
      "where": "agents/*/fix-runner.md:9; docs/*/call-mechanics.md:126",
      "why": "Документы ссылаются на tools/kit-verify «каталога комплекта», но не определяют, что это при установке из npm (пакет без tools/); из-за этого F2 не считается нарушением контракта — контракт просто не задан."
    },
    {
      "item": "Состав поля stand",
      "where": "agents/*/fix-runner.md:47; docs/*/call-mechanics.md:126",
      "why": "«baseline <rc/итог> → after <rc/итог> | unavailable» не говорит, что именно фиксируется (полный вывод? только rc? нормализованный?), поэтому недетерминированный вывод (F5) формально не нарушает контракт, но и сверять нечем."
    },
    {
      "item": "Проверка полноты пар в --proj",
      "where": "tools/kit-verify.ts (докстринг: «same contract as tools/locale-check.ts»)",
      "why": "locale-check тоже идёт только по ru-файлам, но его дополняет test/translation.test.ts (сравнение наборов); для --proj такого дополнения нет — контракт «паритета локалей» неполон по построению."
    },
    {
      "item": "Тайминг session_move для фонового фиксера (из r2, не закрыт)",
      "where": "docs/*/call-mechanics.md:114; docs/*/root-runbook.md:29",
      "why": "Переезд применяется «в конце текущего хода», а фиксер запускается background; окно страхует preflight (needs_decision → лишний круг), но порядок «переезд до первой правки» не гарантирован спецификацией инструмента."
    }
  ],
  "not_verified": [
    {
      "item": "session_move 4/4 и «4 реальные LLM-сессии fix-runner» из live-experiment.md",
      "why": "С моего уровня субагенты недоступны: 'Subagent depth limit reached (1)'. Механизм документирован (session_move принимает sessionID), git-часть эксперимента воспроизведена; сама посадка не перепроверена."
    },
    {
      "item": "Молчаливый пропуск симлинк-файлов в markdownFiles (Dirent.isFile())",
      "why": "Создание симлинков в этой среде запрещено (EPERM, нет developer mode) — вывод сделан по коду; практически значим только для копий с симлинк-доками."
    },
    {
      "item": "Поведение .cmd-шимов на других версиях Bun/Windows-шеллов",
      "why": "Проверено только здесь: Bun 1.4.2, node_modules установлен; biome/tsc-шаги проходят, но опция shell не входит в типизированный API (F3) — на другой версии поведение может отличаться."
    },
    {
      "item": "Публикация 0.3.0 и содержимое фактического тарбола CI-релизом",
      "why": "Проверен npm pack --dry-run на ревизии; реальный пайплайн semantic-release/CI не запускал (вне бюджета и вне роли)."
    }
  ]
}
```
