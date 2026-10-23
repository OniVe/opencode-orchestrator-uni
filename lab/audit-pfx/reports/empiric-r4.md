# Эмпирический аудит pfx — re-audit (круг 4, кандидат 816cffa)

Ревизия: `816cffa` (aggregate `87d0bdb4161410460ccce92a1ec5a438415b6cfaf3b61cbe2303c3d40eb6e33a`, 96 файлов; диапазон `476e9bd..816cffa` = 14 файлов, +188/−42).
Роль: empiric (read-only). Прогоны — в temp-клонах/копиях; аудируемый репозиторий не менялся (в `git status` только `lab/`-правки root'а, исключённые из ревизии).

## Резюме

Вердикт: **ready** — F1, F3, F4, F5, F7 закрыты и воспроизведены, регрессий в guard'ах нет.

- **F1**: битый JSON схем и отсутствующий каталог дают структурированный `E_SCHEMA_IO` (`directory`, `file` — только для файла), без throw; прежние коды (`E_INPUT`, `E_NO_JSON`, `E_PARSE`, `E_UNKNOWN_SCHEMA`, `E_SCHEMA_MISMATCH`, `E_INVALID`) не изменились; откат try/catch красит новый тест (92 pass / 1 fail).
- **F3**: `tools/**` в `include`, `tsc --listFiles` видит оба tool-файла, прямой tsc по `kit-verify.ts` → rc=0 (`shell` убран, спавн через ComSpec). Заявленный «откат include → TS2353» больше не воспроизводится — ошибка устранена в коде; load-bearing доказан мутацией (с `tools/**` tsc rc=2, без них — rc=0).
- **F4**: чистая копия 12/12; EN-сирота → rc=1 и в `kit-verify --proj` (`12/13`), и в self-check `locale-check` (`12/13`), для agents и docs; после удаления — 12/12.
- **F5**: два прогона байт-идентичны (`cmp rc=0`) и в kit-, и в `--proj`-режиме (в т.ч. на падающем состоянии); тайминги из вывода убраны.
- **F7**: README ru/en парны, «93 теста/93 tests», строки `check:locales`/`verify:kit` в обеих локалях.
- **Регрессии**: 93/93 (770 expect), 12/12, biome 0, tsc 0, kit-verify 4/4; заголовки/фенсы совпали с базой, EN без кириллицы.

Новое (не блокирует): **R1 MINOR** — вставка оговорки F2 разорвала нормативную фразу в 4 носителях (`docs/{ru,en}/{call-mechanics,root-runbook}`): «…в одном каталоге; Стенд поставляется … проверки. в раундах по другим проектам…»; **R2 MINOR** — таблица кодов в README (обе локали) не содержит `E_SCHEMA_IO`; NIT: перегруз rc=2 (R3), симлинки выпадают из сканирования (R4, по исходнику), нет таймаута шага (R5, ограничен 5000 ms bun-теста).

## Ключевые прогоны

| Что | Команда | Результат |
|---|---|---|
| E_SCHEMA_IO (JSON) | harness + битый `*.json` | `ok:false, code:E_SCHEMA_IO`, directory+file, без throw |
| E_SCHEMA_IO (нет каталога) | harness + несуществующий путь | `E_SCHEMA_IO`, directory, file отсутствует |
| Прежние коды | 6 граничных отчётов | E_INPUT / E_NO_JSON / E_PARSE / E_UNKNOWN_SCHEMA / E_SCHEMA_MISMATCH / E_INVALID |
| Откат F1 | temp-клон без try/catch | 1 fail «typed refusal, not a throw», 92 pass |
| Типы | `tsc --listFiles` / прямой tsc | 2 записи в tools/; rc=0 |
| Include load-bearing | мутация `number = "str"` | с tools/** rc=2; без — rc=0; прямой tsc rc=2 |
| Сироты | копия + `orphan.md` | kit-verify: 12/13 rc=1; locale-check: 12/13 rc=1 (agents и docs) |
| Детерминизм | 2× kit, 2× --proj | `cmp rc=0` (оба режима) |
| README | grep 93 / script-строки | 93 в обеих локалях; `check:locales`+`verify:kit` в обеих |
| Guard'ы | test/locale/biome/tsc/kit-verify | 93 pass · 12/12 · 0 · 0 · 4/4 |
| Таймаут шага | temp-клон: тест спит 30 s | `timed out after 5000ms`, прогон 5234 ms, rc=1 |

## Out-of-scope (оценка и решение)

- **R2 (MINOR)** — README-таблица кодов без `E_SCHEMA_IO`. Решение: **фикс** (одна строка в каждой локали).
- **R3 (NIT)** — rc=2 перегружен. Решение: **принять** (тексты различаются) либо развести на 3.
- **R4 (NIT)** — симлинки не считаются файлами (`isFile()`). Решение: **принять с записью** (или принимать `isSymbolicLink()` и проверять цель).
- **R5 (NIT)** — нет таймаута шага. Решение: **принять** (bun-тесты ограничены 5000 ms) либо добавить `timeout`+`killSignal`.

```json
{
  "schema": "empiric/v1",
  "verdict": "ready",
  "claims_checked": [
    {
      "claim": "Кандидат: HEAD=816cffa, 14 файлов в 476e9bd..816cffa, aggregate 87d0bdb4…, 96 файлов",
      "method": "run",
      "command": "git log --oneline -2; git diff --name-status 476e9bd..816cffa; git diff --stat; orch_uni_snapshot(exclude lab, eval/results)",
      "rc": "0",
      "result": "HEAD=816cffa; 14 файлов ровно по списку (README×2, 6 md-носителей, lib/tools.ts, test/support/locales.ts, test/tools.test.ts, tools/kit-verify.ts, tools/locale-check.ts, tsconfig.json); +188/−42; aggregate=87d0bdb4161410460ccce92a1ec5a438415b6cfaf3b61cbe2303c3d40eb6e33a, files=96",
      "verdict": "confirmed"
    },
    {
      "claim": "F1: битый JSON схем → типизированный E_SCHEMA_IO (не throw), с directory/file",
      "method": "run",
      "command": "harness + schemasDirectory=<temp с broken.v1.json = '{ not json'> → runTool(orch_uni_validate_report)",
      "rc": "0",
      "result": "{ok:false, code:'E_SCHEMA_IO', message:'schemas/broken.v1.json (…\\broken.v1.json) is not valid JSON: JSON Parse error: Expected }', directory:'…r4-broken-…', file:'…\\broken.v1.json'}",
      "verdict": "confirmed"
    },
    {
      "claim": "F1: отсутствующий каталог схем → E_SCHEMA_IO без поля file",
      "method": "run",
      "command": "harness + schemasDirectory=<несуществующий путь> → validate_report",
      "rc": "0",
      "result": "{ok:false, code:'E_SCHEMA_IO', message:'cannot read schemas directory …: ENOENT: no such file or directory, scandir …', directory:'…'} — ключ file отсутствует",
      "verdict": "confirmed"
    },
    {
      "claim": "F1: отчётные коды не изменились (E_INPUT/E_NO_JSON/E_PARSE/E_UNKNOWN_SCHEMA/E_SCHEMA_MISMATCH/E_INVALID)",
      "method": "run",
      "command": "6 прогонов validate_report с граничными входами",
      "rc": "0",
      "result": "noInput → E_INPUT; noJson → E_NO_JSON; notJsonInFence → E_PARSE; unknownSchema → E_UNKNOWN_SCHEMA; mismatch → E_SCHEMA_MISMATCH; invalidShape → E_INVALID (4 ошибки $.round/$.commit/$.results/$.out_of_scope) — совпадает с прежним контрактом",
      "verdict": "confirmed"
    },
    {
      "claim": "F1: откат try/catch красит новый тест (load-bearing)",
      "method": "measure",
      "command": "temp-клон: заменён try/catch на прямой await loadSchemas → bun test",
      "rc": "1",
      "result": "1 fail: 'schema registry failures > a broken or missing schemas directory is a typed refusal, not a throw'; 92 pass / 1 fail; после восстановления — 93 pass / 0 fail",
      "verdict": "confirmed"
    },
    {
      "claim": "F3: tsconfig.include содержит tools/**, tsc --listFiles его видит",
      "method": "run",
      "command": "npx tsc --noEmit --listFiles | grep '/tools/'",
      "rc": "0",
      "result": "2 записи: tools/kit-verify.ts, tools/locale-check.ts",
      "verdict": "confirmed"
    },
    {
      "claim": "F3: прямой tsc по tools/kit-verify.ts — rc=0 (TS2353 устранён)",
      "method": "run",
      "command": "npx tsc --noEmit --target esnext --module esnext --moduleResolution bundler --types node,bun --strict --skipLibCheck tools/kit-verify.ts",
      "rc": "0",
      "result": "пустой вывод, rc=0; 'shell' в файле отсутствует (grep -c shell → 0), вместо него spawnCommand через ComSpec /c",
      "verdict": "confirmed"
    },
    {
      "claim": "F3: include load-bearing (мутация типовой ошибки)",
      "method": "measure",
      "command": "temp-клон: добавлен const injectedTypeProbe: number = 'not a number' → tsc --noEmit; затем include без tools/** → tsc --noEmit",
      "rc": "2",
      "result": "с tools/** → 'tools/kit-verify.ts(200,7): error TS2322: Type string is not assignable to type number', rc=2; без tools/** → rc=0 (слепо), при этом прямой tsc по файлу → rc=2. Заявленный в задании откат include→TS2353 не воспроизводится: сам TS2353 устранён правкой кода",
      "verdict": "confirmed"
    },
    {
      "claim": "F4: чистая копия agents+docs → 12/12",
      "method": "run",
      "command": "bun tools/kit-verify.ts --proj <копия>",
      "rc": "0",
      "result": "'kit-verify --proj: 12/12 pairs ok'",
      "verdict": "confirmed"
    },
    {
      "claim": "F4: EN-сирота → rc=1 и в kit-verify --proj, и в self-check locale-check",
      "method": "run",
      "command": "echo > <копия>/agents/en/orphan.md; kit-verify --proj; echo > <клон>/agents/en/orphan.md; bun tools/locale-check.ts; то же для docs/en",
      "rc": "1",
      "result": "kit-verify: 'FAIL agents/en/orphan.md', 'orphan translation: no agents/ru/orphan.md', '12/13 pairs ok', rc=1; locale-check: 'FAIL agents\\en\\orphan.md', 'orphan translation: no reference file', '12/13 ok', rc=1; docs-сирота — то же (12/13, rc=1); после удаления — 12/12 rc=0",
      "verdict": "confirmed"
    },
    {
      "claim": "F5: два прогона байт-идентичны (kit и --proj)",
      "method": "measure",
      "command": "bun tools/kit-verify.ts дважды; kit-verify --proj <копия с сиротой> дважды; cmp -s",
      "rc": "0",
      "result": "kit: 'PASS … (rc=0)' ×4 + '4/4 ok'; cmp rc=0; --proj на падающем состоянии: 'FAIL agents/en/orphan.md', '12/13 pairs ok'; cmp rc=0; тайминги из вывода убраны",
      "verdict": "confirmed"
    },
    {
      "claim": "F7: README ru/en парны, 93 теста",
      "method": "run",
      "command": "grep '93 тест|93 tests' README*.md; grep 'check:locales|verify:kit'; bun test",
      "rc": "0",
      "result": "README.md:309 '93 tests in 8 files'; README.ru.md:316 '93 теста в 8 файлах'; строки скриптов есть в обеих локалях (параллельные формулировки); фактически 93 pass / 0 fail / 770 expect",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессии: npm test 93/93, locale 12/12, biome 0, tsc 0, kit-verify 4/4",
      "method": "run",
      "command": "bun test ./test/; bun tools/locale-check.ts; npx biome check .; npx tsc --noEmit; bun tools/kit-verify.ts",
      "rc": "0",
      "result": "93 pass/0 fail/770 expect; 12/12 ok; 'Checked 34 files, No fixes applied'; tsc rc=0; kit-verify '4/4 ok' rc=0",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессии: структура md и EN-локаль целы",
      "method": "compare_base",
      "command": "заголовки/фенсы 6 md 476e9bd vs 816cffa; grep кириллицы agents/en docs/en",
      "rc": "0",
      "result": "call-mechanics 22/20, root-runbook 7/2, агенты 0/0 в обеих локалях — совпало с базой; EN_HAS_CYRILLIC=no; locale-check 12/12",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессия r4: текст вставки F2 в 4 носителях корректен",
      "method": "run",
      "command": "git grep -n 'checks\\. in rounds|проверки\\. в раундах'; git grep -n '; The stand is shipped|; Стенд поставляется'",
      "rc": "0",
      "result": "4 файла с разорванной фразой: docs/{ru,en}/call-mechanics.md:126 и docs/{ru,en}/root-runbook.md:29 — '…в одном каталоге; Стенд поставляется … проверки. в раундах по другим проектам…' (заглавная после ';' внутри скобки, строчная после точки). В agents/{ru,en}/fix-runner.md:28 вставка корректна",
      "verdict": "refuted"
    },
    {
      "claim": "Out-of-scope: таблица кодов README без E_SCHEMA_IO",
      "method": "run",
      "command": "grep -n 'E_INPUT|E_SCHEMA_IO' README.md; sed -n '82,92p' README.md",
      "rc": "0",
      "result": "таблица из 7 кодов: E_INPUT, E_NO_JSON, E_PARSE, E_UNKNOWN_SCHEMA, E_SCHEMA_MISMATCH, E_INVALID, E_ABORTED; E_SCHEMA_IO отсутствует, хотя инструмент его возвращает и описание инструмента его перечисляет (lib/tools.ts)",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: rc=2 перегружен (ошибка аргументов и «нет пар»)",
      "method": "run",
      "command": "bun tools/kit-verify.ts --bogus; bun tools/kit-verify.ts --proj <пустой каталог>",
      "rc": "2",
      "result": "оба случая rc=2: usage-ошибка и 'no agents/** or docs/** locale pairs …'; различимы только по тексту",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: симлинк-файлы выпадают из сканирования",
      "method": "source",
      "command": "grep -n 'isFile()' test/support/locales.ts tools/kit-verify.ts; MSYS=winsymlinks:nativestrict ln -s ../ru/arbiter.md agents/en/linked.md",
      "result": "оба листинга фильтруют entry.isFile() (test/support/locales.ts:23, tools/kit-verify.ts:103) — симлинки не считаются файлами; создать симлинк на этой машине не удалось: 'ln: failed to create symbolic link …: Operation not permitted', rc=1 (проверка только по исходнику)",
      "verdict": "unverifiable"
    },
    {
      "claim": "Out-of-scope: нет таймаута child-процесса",
      "method": "run",
      "command": "grep -n 'Bun.spawn|timeout|killSignal' tools/kit-verify.ts; temp-клон с тестом, спящим 30 s → bun test",
      "rc": "1",
      "result": "в kit-verify.ts только Bun.spawn(...) без timeout/killSignal; практическая граница: bun test убивает тест на 5000 ms ('this test timed out after 5000ms', общий прогон 5234 ms, rc=1)",
      "verdict": "confirmed"
    }
  ],
  "modes_measured": [
    {
      "operation": "kit-verify в режимах стенда",
      "regimes": [
        "kit (2 прогона)",
        "--proj чистая копия",
        "--proj с EN-сиротой (2 прогона)",
        "--proj только сироты",
        "--proj пусто",
        "мусорный аргумент"
      ],
      "best": "kit: 4/4 ok rc=0, два прогона байт-идентичны (cmp rc=0); --proj чистая: 12/12 rc=0",
      "worst": "--proj с сиротой: 12/13 rc=1, повтор байт-идентичен; только сироты: 0/1 rc=1; пусто: rc=2; мусор: rc=2 (перегруз кода)",
      "budget_claim": null,
      "measured": "шаги без таймингов в выводе; детерминизм подтверждён cmp; граница зависания — 5000 ms на тест (bun), своего таймаута у стенда нет"
    },
    {
      "operation": "E_SCHEMA_IO и прежние коды валидатора",
      "regimes": [
        "битый JSON схемы",
        "отсутствующий каталог схем",
        "штатные схемы + 6 граничных входов"
      ],
      "best": "штатные: E_INPUT/E_NO_JSON/E_PARSE/E_UNKNOWN_SCHEMA/E_SCHEMA_MISMATCH/E_INVALID — без изменений",
      "worst": "битые схемы: E_SCHEMA_IO с directory+file (JSON) и с directory без file (ENOENT); никаких throw",
      "budget_claim": null,
      "measured": "откат try/catch → тест краснеет (1 fail), т.е. контракт держится тестом"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение",
      "status": "applied",
      "note": "Temp-клон: откат try/catch (тест краснеет), мутация типовой ошибки (include load-bearing); копии agents/docs: сироты, пустой каталог; harness-пробы E_SCHEMA_IO и прежних кодов"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "14 файлов/+188−42; 96; 93/770; 12/12; 4/4; 12/13; 0/1; 2 записи tools в --listFiles; cmp rc=0 дважды; таймаут теста 5234 ms"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора",
      "status": "applied",
      "note": "Совпали 93/93, 12/12, 4/4, README 93; уточнение: заявленный «откат include → TS2353» не воспроизводится — TS2353 устранён в коде, include проверен мутацией"
    },
    {
      "item": 4,
      "title": "Сравнение с базой",
      "status": "applied",
      "note": "Структура md 476e9bd vs 816cffa; поведение кодов и стенда до/после"
    },
    {
      "item": 5,
      "title": "Факты окружения из команд",
      "status": "applied",
      "note": "bun 1.4.2, node_modules 373, tsc --listFiles, отказ ln (Operation not permitted) — всё из прогонов"
    },
    {
      "item": 6,
      "title": "Первоисточники",
      "status": "applied",
      "note": "Читал lib/tools.ts (SchemaIoError + executor), tools/kit-verify.ts, tools/locale-check.ts, test/support/locales.ts, test/tools.test.ts, README-таблицу кодов"
    },
    {
      "item": 7,
      "title": "Прототип в нескольких режимах",
      "status": "applied",
      "note": "Стенд в 6 режимах, схемы в 2 аварийных + 6 штатных, мутация типов в 2 конфигурациях include; назван худший"
    },
    {
      "item": 8,
      "title": "Крайние значения",
      "status": "applied",
      "note": "Пустой каталог (2), только сироты (1), битый JSON схем, отсутствующий каталог, пустой/мусорный аргумент, --help"
    },
    {
      "item": 9,
      "title": "Оценки без замера",
      "status": "applied",
      "note": "Заявка «два прогона байт-идентичны» замерена cmp; «таймаута нет» — ограничение измерено (5000 ms)"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто везде",
      "status": "applied",
      "note": "F2-оговорка (npm → stand: unavailable) есть во всех 6 носителях; но в 4 из них вставка разорвала фразу — R1; README-таблица кодов не дополнена — R2"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном",
      "status": "applied",
      "note": "Эталон паритета — test/translation.test.ts (file sets в обе стороны): locale-check/kit-verify --proj теперь повторяют это правило (сироты), проверено на копии"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы",
      "status": "applied",
      "note": "Два прогона kit и --proj байт-идентичны; границы (пусто/сироты/мусор) — запуском"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "locale-check: парный режим (1/1 rc=0, mismatch rc=1) и self-check (12/12, сироты 12/13); kit-verify: kit/--proj/пусто/сироты-только"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей",
      "status": "applied",
      "note": "E_SCHEMA_IO доезжает до инструмента и его описания, но не до README-таблицы (R2); оговорка npm доезжает до 6 носителей, но с разрывом фразы в 4 (R1)"
    },
    {
      "item": 15,
      "title": "Непроверенное не как факт",
      "status": "applied",
      "note": "Симлинки — только по исходнику (ОС не даёт создать), Linux-ветка и сессии — в not_verified"
    },
    {
      "item": 16,
      "title": "Дисциплина rc",
      "status": "applied",
      "note": "rc по каждому прогону: тесты 0/1, стенд 0/1/2, tsc 0/2, ln 1, cmp 0; где пайп глотал rc — перезапуск в файл"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "Стенд: 6 режимов; схемы: 2 аварийных + 6 граничных отчётов; типы: 1 мутация x 2 конфигурации include — 9+ входов, исходы по контракту"
    },
    {
      "item": 18,
      "title": "Тесты — объект аудита",
      "status": "applied",
      "note": "Новый тест E_SCHEMA_IO load-bearing (откат краснеет); include проверен мутацией типа; у стенда по-прежнему нет своих тестов (только ручные прогоны)"
    },
    {
      "item": 19,
      "title": "База без git",
      "status": "not_applicable",
      "note": "История и базы 476e9bd/7ab0d82 доступны"
    }
  ],
  "findings": [
    {
      "id": "R1",
      "severity": "MINOR",
      "location": "docs/ru/call-mechanics.md:126, docs/en/call-mechanics.md:126, docs/ru/root-runbook.md:29, docs/en/root-runbook.md:29",
      "mechanism": "Оговорка F2 (npm не поставляет tools/ → stand: unavailable) вставлена внутрь скобочной конструкции без перестройки предложения: после '; ' идёт заглавная «Стенд/The stand», затем точка и строчное продолжение «в раундах по другим проектам / in rounds on other projects». Нормативная фраза разорвана в 4 носителях из 6; паритет локалей дефект не видит (он одинаков в обеих локалях и структурно невидим).",
      "evidence": "git grep -n '; Стенд поставляется|; The stand is shipped' → docs/{ru,en}/call-mechanics.md:126, docs/{ru,en}/root-runbook.md:29; git grep -n 'проверки\\. в раундах|checks\\. in rounds' → те же 4 файла; agents/{ru,en}/fix-runner.md:28 — вставка корректна (после завершённого предложения)",
      "fix": "Вынести оговорку отдельным предложением вне скобки: '…(verifier) in the kit directory. The stand ships in the git checkout only: the npm package omits tools/ ⇒ stand: unavailable. In rounds on other projects — only if the stand is explicitly included in the call boundaries): …' — так же в RU; проверить паритет локалей и структуру md."
    },
    {
      "id": "R2",
      "severity": "MINOR",
      "location": "README.md:84-92 (и README.ru.md:85-93)",
      "mechanism": "Таблица кодов ошибок validate_report перечисляет 7 кодов, но не E_SCHEMA_IO, который теперь возвращается инструментом и уже указан в его описании (lib/tools.ts). Пользовательский контракт-документ отстаёт от фактического набора кодов — тот же класс, что закрывали F1.",
      "evidence": "sed -n '82,92p' README.md → E_INPUT, E_NO_JSON, E_PARSE, E_UNKNOWN_SCHEMA, E_SCHEMA_MISMATCH, E_INVALID, E_ABORTED; E_SCHEMA_IO в README.md/README.ru.md отсутствует (встречается только в lib/tools.ts и тесте)",
      "fix": "Добавить строку '| `E_SCHEMA_IO` | schemas/*.json не читаются/битые (см. directory/file) |' в обе локали."
    },
    {
      "id": "R3",
      "severity": "NIT",
      "location": "tools/kit-verify.ts main()/runProjectStand",
      "mechanism": "Код 2 перегружен: и usage-ошибка, и «нет пар и сирот». Машинный потребитель не отличает неправильный вызов от «нечего проверять»; различие только в тексте.",
      "evidence": "bun tools/kit-verify.ts --bogus → usage, rc=2; bun tools/kit-verify.ts --proj <пустой каталог> → 'no agents/** or docs/** locale pairs …', rc=2",
      "fix": "Развести коды (например, 3 — «нет пар») либо документировать перегруз в docstring/README."
    },
    {
      "id": "R4",
      "severity": "NIT",
      "location": "test/support/locales.ts:23, tools/kit-verify.ts:103",
      "mechanism": "Листинги фильтруют entry.isFile(), поэтому симлинк на файл/каталог не считается ни парой, ни сиротой: проект с символьно-связанными docs/agents молча теряет пары (при ru-симлинке виден 'orphan translation' для en-файла, но сравнение содержимого не выполняется).",
      "evidence": "grep -n 'isFile()' → test/support/locales.ts:23, tools/kit-verify.ts:103; MSYS=winsymlinks:nativestrict ln -s ../ru/arbiter.md agents/en/linked.md → 'ln: failed to create symbolic link …: Operation not permitted', rc=1 (исполнение недоступно, вывод по исходнику)",
      "fix": "Принять как ограничение (задокументировать) либо принимать entry.isFile() || entry.isSymbolicLink() и проверять цель через stat."
    },
    {
      "id": "R5",
      "severity": "NIT",
      "location": "tools/kit-verify.ts:56 (Bun.spawn)",
      "mechanism": "У шага стенда нет таймаута/killSignal: зависший дочерний процесс держит стенд без ограничения. Основной риск ограничен изнутри bun test (5000 ms на тест), поэтому severity низкая, но зависание tsc/biome (локи, ожидание stdin) не ограничено.",
      "evidence": "grep -n 'Bun.spawn|timeout|killSignal' tools/kit-verify.ts → только строка 56 без timeout; temp-клон с тестом, спящим 30 s: bun test → '(fail) hang probe [5000.72ms]', 'this test timed out after 5000ms', rc=1, прогон 5234 ms",
      "fix": "Добавить timeout + killSignal на шаг (например, 600 s) и строку TIMEOUT в вывод, либо принять как осознанное ограничение."
    }
  ],
  "contract_gaps": [
    {
      "item": "Значение кода 2 у стенда",
      "where": "tools/kit-verify.ts docstring/USAGE; README",
      "why": "Один код на два разных исхода (неверный вызов и отсутствие проверяемых пар) — машинная семантика неоднозначна"
    },
    {
      "item": "Область сканирования пар (симлинки)",
      "where": "test/support/locales.ts:23; tools/kit-verify.ts:103",
      "why": "Не задано, считаются ли символьные ссылки частью набора файлов; поведение вытекает из реализации isFile(), а не из контракта"
    },
    {
      "item": "Границы времени шага стенда",
      "where": "tools/kit-verify.ts:56",
      "why": "Не задано, сколько может длиться шаг и что делать при зависании; бюджет фиксера при этом расходуется молча"
    }
  ],
  "not_verified": [
    {
      "item": "Поведение стенда на Linux/macOS (ветка WINDOWS=false, localBinary без .cmd)",
      "why": "Проверял только win32"
    },
    {
      "item": "Симлинк-файлы в наборе (исполнение)",
      "why": "Создание симлинка на этой машине запрещено ОС ('Operation not permitted'); вывод сделан по исходнику"
    },
    {
      "item": "Сессии live-эксперимента и npm-установка (из r3)",
      "why": "Логов сессий нет; состав tarball проверялся ранее через npm pack --dry-run"
    }
  ]
}
```
