# Эмпирический аудит pfx — re-audit (круг 5, кандидат 2f5c581)

Ревизия: `2f5c581` (aggregate `872a2fb473fcfe50ec74a7af3f4b246f117064566af76d830868cd74bf2b630c`, 96 файлов; диапазон `816cffa..2f5c581` = 6 файлов, +10/−4).
Роль: empiric (read-only). Прогоны — в temp-каталогах; аудируемый репозиторий не менялся (в `git status` только `lab/`-правки root'а).

## Резюме

Вердикт: **ready** — R1 и R2/G2, G3 закрыты и воспроизведены, регрессий в guard'ах нет.

- **R1**: repro-`grep` разорванной фразы = 0; во всех 4 носителях оговорка вынесена отдельным предложением после `)`, условие «только если стенд включён в границы» осталось внутри скобки, скобки сбалансированы (3/3, 22/22, 24/24), структура md не изменилась.
- **R2/G2**: `E_SCHEMA_IO` — по одному разу в обеих README, таблица сохранила формат (9 строк × 3 разделителя), описание полей совпадает с реализацией (`directory` всегда, `file` — для файла; `lib/` в диапазоне не менялся).
- **G3**: оговорка про git-чекаут есть в обеих README; факт подтверждён сборкой tarball — `tools/` в пакете нет, объявленный скрипт даёт `Module not found` (rc=1).
- **Регрессии**: 93/93 (770 expect), 12/12, biome 0, tsc 0, kit-verify 4/4; заголовки/фенсы совпали с базой, EN без кириллицы.

Новое: **S1 MINOR** — «две последние команды» указывает не туда (последние две в блоке — `lint`/`lint:fix`, а чекаут нужен `check:locales`/`verify:kit`); NIT: 7 из 9 объявленных скриптов ссылаются на непоставленные пути (S2, принять), сокращённое перечисление кодов (S3, принять).

## Ключевые прогоны

| Что | Команда | Результат |
|---|---|---|
| Repro R1 | `git grep -E '; Стенд поставляется|; The stand is shipped'` | 0 совпадений, rc=1 |
| Скобки/структура | подсчёт `(`/`)` на строках kit-verify; заголовки/фенсы | 3/3, 22/22, 24/24; README 16/16 и 30/30; docs 22/20, 7/2 |
| E_SCHEMA_IO (README) | `grep -c`; `awk` по таблице | 1 и 1; по 3 разделителя в каждой строке |
| Поля кода | harness: битый JSON / нет каталога | первый: directory+file; второй: только directory |
| npm-пакет | `npm pack` + `tar -xzf` + запуск в пакете | `tools/` нет (ls rc=2); `Module not found "tools/kit-verify.ts"` rc=1 |
| Guard'ы | test / locale / biome / tsc / kit-verify | 93 pass · 12/12 · 0 · 0 · 4/4 |

## Out-of-scope (оценка и решение)

- **S2 (NIT)** — package.json объявляет `verify:kit`/`check:locales` (и ещё 5 dev-скриптов), чьи цели не поставляются: у потребителя `Module not found`. Решение: **принять** (README покрывает случай стенда; остальное — обычная практика dev-скриптов) либо исключать dev-скрипты при публикации.
- **S3 (NIT)** — сокращённое перечисление кодов `(E_INPUT, E_NO_JSON, …)`. Решение: **принять** — полная таблица ниже, противоречия нет.

```json
{
  "schema": "empiric/v1",
  "verdict": "ready",
  "claims_checked": [
    {
      "claim": "Кандидат: HEAD=2f5c581, 6 файлов в 816cffa..2f5c581, aggregate 872a2fb4…, 96 файлов",
      "method": "run",
      "command": "git log --oneline -1; git diff --name-status 816cffa..2f5c581; git diff --stat; orch_uni_snapshot(exclude lab, eval/results)",
      "rc": "0",
      "result": "HEAD=2f5c581; ровно 6 файлов (README×2, docs/{ru,en}/{call-mechanics,root-runbook}); +10/−4; aggregate=872a2fb473fcfe50ec74a7af3f4b246f117064566af76d830868cd74bf2b630c, files=96",
      "verdict": "confirmed"
    },
    {
      "claim": "R1: repro-критерий по разрыву фразы = 0 совпадений",
      "method": "run",
      "command": "git grep -nE '; Стенд поставляется|; The stand is shipped' -- agents docs",
      "rc": "1",
      "result": "0 совпадений (rc=1)",
      "verdict": "confirmed"
    },
    {
      "claim": "R1: оговорка вынесена отдельным предложением после ')' в 4 носителях",
      "method": "source",
      "command": "git diff 816cffa..2f5c581 -- docs; grep -o 'Стенд поставляется в git-чекауте[^.]*\\.' и EN-аналог",
      "result": "docs/{ru,en}/{call-mechanics,root-runbook}: '… только если стенд явно включён в границы вызова): baseline → … (поле `stand`). Стенд поставляется в git-чекауте комплекта: в npm-пакете каталог `tools/` не поставляется → `stand: unavailable` и собственные воспроизводимые проверки.' — оговорка после закрывающей скобки, условие осталось внутри скобки",
      "verdict": "confirmed"
    },
    {
      "claim": "R1: скобки и структура строк не разъехались",
      "method": "run",
      "command": "подсчёт '(' и ')' на строке с kit-verify в 4 файлах; сравнение заголовков/фенсов с 816cffa",
      "rc": "0",
      "result": "call-mechanics 3/3, root-runbook 22/22 и 24/24 — баланс; заголовки/фенсы: README 16/16 и 30/30, docs 22/20 и 7/2 — совпало с базой",
      "verdict": "confirmed"
    },
    {
      "claim": "R1: смысл не потерян (условие 'если стенд включён в границы' сохранено)",
      "method": "source",
      "command": "чтение строк docs/ru/call-mechanics.md:126 и docs/ru/root-runbook.md:29 (и EN-аналоги)",
      "result": "в скобке остались 'если в комплекте поставляется проверочный стенд …; в раундах по другим проектам — только если стенд явно включён в границы вызова'; оговорка про npm — отдельным предложением после ')'",
      "verdict": "confirmed"
    },
    {
      "claim": "R2: E_SCHEMA_IO присутствует в обеих README по одному разу, таблица цела",
      "method": "run",
      "command": "grep -c 'E_SCHEMA_IO' README.md README.ru.md; awk подсчёт '|' по строкам таблицы",
      "rc": "0",
      "result": "README.md:1, README.ru.md:1; все строки таблицы имеют по 3 разделителя (9 строк в EN, 9 в RU) — формат сохранён",
      "verdict": "confirmed"
    },
    {
      "claim": "R2: описание полей соответствует реализации (directory всегда, file — для файла)",
      "method": "run",
      "command": "harness: битый JSON схемы и отсутствующий каталог → validate_report",
      "rc": "0",
      "result": "битый JSON: {code:E_SCHEMA_IO, directory:…, file:…\\broken.v1.json}; отсутствующий каталог: {code:E_SCHEMA_IO, directory:…} без file; lib/ в диапазоне не менялся (git diff --name-only -- lib schemas tools → пусто)",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: оговорка про git-чекаут есть в обеих README",
      "method": "run",
      "command": "sed -n '298,318p' README.md; sed -n '305,325p' README.ru.md",
      "rc": "0",
      "result": "EN: 'The last two commands need a git checkout of the kit — the npm package ships no `tools/` directory …'; RU: 'Две последние команды требуют git-чекаута комплекта — в npm-пакете каталог `tools/` не поставляется …'",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: факт «npm-пакет без tools/» воспроизводится",
      "method": "run",
      "command": "npm pack --pack-destination <temp>; tar -xzf; ls package; bun tools/kit-verify.ts в распакованном пакете",
      "rc": "1",
      "result": "в пакете только LICENSE, README.md, README.ru.md, agents, docs, index.ts, lib, package.json, schemas — каталога tools/ нет (ls → No such file or directory, rc=2); запуск объявленного скрипта: 'error: Module not found \"tools/kit-verify.ts\"', rc=1",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессия r5: ссылка «две последние команды» в README указывает на верные команды",
      "method": "run",
      "command": "sed -n '298,318p' README.md (порядок команд в блоке)",
      "rc": "0",
      "result": "в блоке 6 команд: typecheck, test, check:locales, verify:kit, lint, lint:fix; последние две — lint и lint:fix, а git-чекаут нужен check:locales и verify:kit (3-я и 4-я) → формулировка 'The last two commands' / 'Две последние команды' указывает не туда",
      "verdict": "refuted"
    },
    {
      "claim": "Регрессии: 93/93, locale 12/12, biome 0, tsc 0, kit-verify 4/4",
      "method": "run",
      "command": "bun test ./test/; bun tools/locale-check.ts; npx biome check .; npx tsc --noEmit; bun tools/kit-verify.ts",
      "rc": "0",
      "result": "93 pass/0 fail/770 expect; 12/12 ok; 'Checked 34 files, No fixes applied'; tsc rc=0; kit-verify '4/4 ok'",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессии: EN-локаль без кириллицы",
      "method": "run",
      "command": "LC_ALL=C.UTF-8 grep -rqP '[\\xD0-\\xD1][\\x80-\\xBF]' agents/en docs/en",
      "rc": "0",
      "result": "EN_HAS_CYRILLIC=no",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: package.json объявляет скрипты, чьи цели не поставляются",
      "method": "run",
      "command": "bun -e список scripts; ls распакованного пакета; npx --no-install tsc --noEmit в пакете",
      "rc": "1",
      "result": "9 скриптов; в пакете нет tools/, test/, eval/ и tsconfig.json → 7 из 9 ссылаются на непоставленные пути; typecheck в пакете rc=1, 'Module not found tools/kit-verify.ts' rc=1 для verify:kit",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: generic-перечисление кодов в README",
      "method": "run",
      "command": "grep -n 'E_INPUT`, `E_NO_JSON`' README.md README.ru.md; sed -n '82,93p' README.md",
      "rc": "0",
      "result": "в тексте '(E_INPUT, E_NO_JSON, …)' — сводное перечисление, ниже полная таблица из 8 кодов, включая E_SCHEMA_IO — противоречия нет",
      "verdict": "confirmed"
    }
  ],
  "modes_measured": [
    {
      "operation": "публикация пакета и запуск объявленных скриптов у потребителя",
      "regimes": [
        "git-чекаут (tools/ есть)",
        "npm-пакет (tools/ нет)"
      ],
      "best": "чекаут: bun tools/kit-verify.ts → 4/4 rc=0; kit-verify --proj 12/12 (проверено ранее)",
      "worst": "npm-пакет: tools/ отсутствует, 'error: Module not found \"tools/kit-verify.ts\"' rc=1, то же для locale-check",
      "budget_claim": null,
      "measured": "tarball содержит 9 записей верхнего уровня без tools/; 7 из 9 скриптов ссылаются на непоставленные пути"
    },
    {
      "operation": "нормативные носители: структура фразы после правки",
      "regimes": [
        "до (816cffa)",
        "после (2f5c581)"
      ],
      "best": "после: repro-grep 0, скобки сбалансированы (3/3, 22/22, 24/24), условие внутри скобки, оговорка отдельным предложением",
      "worst": "до: 4 носителя с разорванной фразой ('…; Стенд поставляется … проверки. в раундах …')",
      "budget_claim": null,
      "measured": "4 файла → 0; структура md (заголовки/фенсы) не изменилась"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение",
      "status": "applied",
      "note": "npm pack + распаковка в temp и запуск объявленных скриптов; harness-пробы E_SCHEMA_IO (битый JSON и нет каталога); grep-критерии по носителям"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "6 файлов/+10−4; 96; 93/770; 12/12; 4/4; grep=0; скобки 3/3, 22/22, 24/24; 9 скриптов, 7 без целей в пакете"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора",
      "status": "applied",
      "note": "Совпали 93/93, 12/12, 4/4, 0 совпадений; уточнение: E_SCHEMA_IO-поля совпадают с реализацией; найдено расхождение 'две последние команды'"
    },
    {
      "item": 4,
      "title": "Сравнение с базой",
      "status": "applied",
      "note": "Структура md 816cffa vs 2f5c581; поведение кодов не менялось (lib не тронут)"
    },
    {
      "item": 5,
      "title": "Факты окружения из команд",
      "status": "applied",
      "note": "bun 1.4.2, npm pack, tar, ls пакета, npx tsc — из прогонов"
    },
    {
      "item": 6,
      "title": "Первоисточники",
      "status": "applied",
      "note": "Читал README-блок Development и таблицу кодов, 4 носителя целиком по строкам, package.json (files/scripts), lib/tools.ts (не изменён)"
    },
    {
      "item": 7,
      "title": "Прототип в нескольких режимах",
      "status": "applied",
      "note": "Публикация: чекаут vs npm-пакет; носители: до/после правки; назван худший режим"
    },
    {
      "item": 8,
      "title": "Крайние значения",
      "status": "applied",
      "note": "Битый JSON схем, отсутствующий каталог, пустой пакет без tools/, запуск скрипта в пакете"
    },
    {
      "item": 9,
      "title": "Оценки без замера",
      "status": "applied",
      "note": "Заявка «npm-пакет без tools/» замерена сборкой tarball и запуском в нём; чисел бюджета в диффе нет"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто везде",
      "status": "applied",
      "note": "Оговорка npm — во всех 4 нормативных носителях (после ')') и в обеих README; E_SCHEMA_IO — в таблице обеих README и в описании инструмента"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном",
      "status": "applied",
      "note": "Эталон формата — прежние строки таблицы кодов и прежняя скобочная конструкция: новая строка вписана в тот же формат (3 разделителя), оговорка вынесена без потери условия"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы",
      "status": "applied",
      "note": "Повторные прогоны guard'ов дают те же счётчики; границы (пакет без tools/, битые схемы) — запуском"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "RU/EN паритет таблицы (по 9 строк, 3 разделителя) и оговорки (формулировки параллельны); одиночный прогон на каждую форму"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей",
      "status": "applied",
      "note": "E_SCHEMA_IO доезжает до README-таблицы; directory/file описаны как в реализации; оговорка о стенде доезжает до README и нормативных доков, но референт 'две последние' указывает не на те команды (S1)"
    },
    {
      "item": 15,
      "title": "Непроверенное не как факт",
      "status": "applied",
      "note": "Поведение у потребителя при установке из npm ограничено запуском скриптов в распакованном tarball (без npm install) — отмечено в not_verified"
    },
    {
      "item": 16,
      "title": "Дисциплина rc",
      "status": "applied",
      "note": "rc зафиксированы: grep 1, тесты 0, стенд 0, pack 0, ls отсутствующего 2, запуск скрипта в пакете 1, typecheck в пакете 1"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "2 режима публикации, 2 состояния носителей, 2 аварийных схемы — исходы соответствуют контракту"
    },
    {
      "item": 18,
      "title": "Тесты — объект аудита",
      "status": "applied",
      "note": "Паритет локалей снова слеп к смысловой ошибке: 'две последние команды' прошло зелёным (93/93, 12/12) — дефект текстовый, машинного стража нет"
    },
    {
      "item": 19,
      "title": "База без git",
      "status": "not_applicable",
      "note": "История и база 816cffa доступны"
    }
  ],
  "findings": [
    {
      "id": "S1",
      "severity": "MINOR",
      "location": "README.md:311, README.ru.md:318 (абзац после блока Development)",
      "mechanism": "Новая оговорка ссылается позиционно: 'The last two commands need a git checkout of the kit' / 'Две последние команды требуют git-чекаута'. В блоке шесть команд; последние две — `npm run lint` и `npm run lint:fix`, а каталог tools/ нужен `check:locales` и `verify:kit` (3-я и 4-я). Читатель либо отнесёт оговорку к lint (неверно), либо не поймёт, какие команды требуют чекаут; сам факт про npm-пакет верен.",
      "evidence": "sed -n '298,318p' README.md → порядок: typecheck, test, check:locales, verify:kit, lint, lint:fix; затем 'The last two commands need a git checkout of the kit…'; в распакованном npm-пакете tools/ отсутствует (ls rc=2), запуск verify:kit/check:locales → 'Module not found', rc=1",
      "fix": "Назвать команды явно: '`npm run check:locales` и `npm run verify:kit` need a git checkout of the kit …' (и так же в RU)."
    },
    {
      "id": "S2",
      "severity": "NIT",
      "location": "package.json scripts (verify:kit, check:locales, test, typecheck, eval*)",
      "mechanism": "Пакет объявляет 9 скриптов, 7 из которых ссылаются на пути, отсутствующие в tarball (tools/, test/, eval/, tsconfig.json). Это сложившаяся практика (dev-скрипты в публикуемом пакете), и README теперь покрывает случай стенда, но машинно скрипты у потребителя падают ENOENT/Module not found.",
      "evidence": "npm pack --pack-destination <temp> + tar -xzf: в пакете только LICENSE, README*, agents, docs, index.ts, lib, package.json, schemas; bun tools/kit-verify.ts → 'Module not found', rc=1; npx tsc --noEmit → rc=1; 9 скриптов в package.json",
      "fix": "Принять как есть (задокументировано для стенда) либо исключать dev-скрипты при публикации / добавлять tools+test+eval+tsconfig в files при желании поставлять стенд."
    },
    {
      "id": "S3",
      "severity": "NIT",
      "location": "README.md:60, README.ru.md:62",
      "mechanism": "Сводное перечисление '(E_INPUT, E_NO_JSON, …)' остаётся сокращённым, но ниже есть полная таблица из 8 кодов (с E_SCHEMA_IO), поэтому противоречия нет — только стилистическая незавершённость.",
      "evidence": "grep -n 'E_INPUT`, `E_NO_JSON`' → README.md:60, README.ru.md:62; sed -n '84,92p' README.md → 8 строк таблицы, включая E_SCHEMA_IO",
      "fix": "Не требуется (принять); при желании заменить '…' на 'among others' / 'и др.'."
    }
  ],
  "contract_gaps": [
    {
      "item": "Позиционные ссылки в документации",
      "where": "README.md:311 / README.ru.md:318",
      "why": "Ссылка 'две последние команды' ломается при любом добавлении команды в блок; контракт не требует явного перечисления, а машинного стража на такие ссылки нет"
    },
    {
      "item": "Статус dev-скриптов в публикуемом пакете",
      "where": "package.json scripts + files",
      "why": "Не задано, должны ли скрипты, чьи цели не поставляются, присутствовать в tarball; сейчас 7 из 9 падают у потребителя"
    }
  ],
  "not_verified": [
    {
      "item": "Поведение установленного пакета после npm install у потребителя",
      "why": "Проверял распакованный tarball без установки зависимостей потребителя — сценарий 'npm run lint' с devDependencies не воспроизводился"
    },
    {
      "item": "Linux/macOS-ветка стенда и симлинк-сканирование",
      "why": "Только win32; создание симлинков запрещено политикой ОС"
    }
  ]
}
```
