# Эмпирический аудит pfx — re-audit (круг 3, кандидат 476e9bd)

Ревизия: `476e9bd` (aggregate `2290e3a95eb138202cabb8701b7b7f3a484cff60725d0e75ed4895805d6913e3`, 96 файлов; диапазон `7ab0d82..476e9bd` = 11 code-файлов, `7b980c9` — lab-only).
Роль: empiric (read-only). Прогоны — в temp-клонах/копиях; аудируемый репозиторий не менялся (в `git status` только `lab/`-правки root'а, исключённые из ревизии).

## Резюме

Вердикт: **ready** — G2 и G3 закрыты и воспроизведены, регрессий нет.

- **G2** подтверждена трижды: живой `orch_uni_validate_report` уже применяет свежую схему (workspace без `base_commit` → `invalid`, строкой → `invalid`, полный → `valid`); тест `schema freshness` PASS (92/92), а откат на кэш схем на регистрации красит его (1 fail с ожидаемым `{valid:false, E_INVALID}`). Цена — 0.45 ms/вызов (200 вызовов = 91 ms).
- **G3** подтверждена: `bun tools/kit-verify.ts` → 4/4, rc=0; `--proj` на копии → 12/12 (в т.ч. из чужого cwd и с относительным путём); негативы — битая пара rc=1 (11/12), пустой каталог rc=2, мусорный аргумент rc=2, `--help` rc=0; в kit-режиме при поломке 2/4 ok и rc=1 с явными FAIL. `kit-sync` — 0 совпадений вне `lab/`.
- **Регрессии**: `npm test` 92/92 (762 expect), `check:locales` 12/12, biome 0 (34 файла), `tsc --noEmit` 0; заголовки/фенсы 6 md совпали с базой, EN без кириллицы.
- **Live-эксперимент** сверен по артефактам клона: 4 SHA существуют, у каждого parent `7b980c9` и один файл `probe-N.txt`, все влиты в HEAD, наборы файлов не пересекаются, семантические проверки (cat-file/ancestry/non-empty delta) проходят. Расхождение описания: не «4 merge-коммита», а 3 merge + 1 fast-forward (T6).

Новое (не блокирует): **T1** — `tools/**` вне tsconfig, поэтому стенд не типизирует сам себя, и в `kit-verify.ts:56` есть реальная ошибка типов (`shell` не в `SpawnOptions`, TS2353 при прямом прогоне); **T2** — стенд не попадает в npm-пакет (`files`), а зависит от `test/support/locales`; NIT: устаревший комментарий `locales.ts:3` (T3), README без `verify:kit` и со старым счётчиком тестов (T4), сырая ошибка при битой схеме (T5), формулировка live-отчёта (T6).

## Ключевые прогоны

| Что | Команда | Результат |
|---|---|---|
| Стенд (kit) | `bun tools/kit-verify.ts` | PASS ×4, `4/4 ok`, rc=0 |
| Стенд (сломанная пара) | то же в temp-клоне | FAIL locale-check/test, PASS biome/tsc, `2/4 ok`, rc=1 |
| Стенд (`--proj`) | `--proj <копия>` | `12/12 pairs ok`, rc=0 |
| Негативы | `--proj <битая>` / `<пусто>` / `--bogus` | rc=1 (11/12) / rc=2 / rc=2 |
| Свежесть схем (live) | `orch_uni_validate_report` | missing base → invalid; строка → invalid; полный → valid |
| Свежесть схем (rollback) | temp-клон с кэшем на регистрации | `schema freshness` FAIL (1 fail) |
| Стоимость | 200 вызовов через harness | 91.0 ms → 0.45 ms/вызов |
| Битые схемы | подмена файла на невалидный JSON | вызов THREW `JSON Parse error` |
| Типы стенда | `tsc --listFiles` / `tsc tools/kit-verify.ts` | 0 файлов `tools/` / TS2353 `shell`, rc=2 |
| Пакет | `npm pack --dry-run --json` | 0 записей `tools/`, 0 записей `test/` |
| Live-артефакты | клон `%TEMP%/opencode/pfx-live/repo` | 4 SHA = parent `7b980c9`, по 1 файлу, все ancestor-of-HEAD |

## Out-of-scope (оценка и решение)

- **T1 (MINOR)** — `tsconfig.include` без `tools/**` + реальный TS2353 в `kit-verify.ts:56`. Решение: **фикс** (добавить `tools/**/*.ts`, типизировать опции spawn, `kit-verify` шаг tsc должен остаться зелёным уже с tools/).
- **T2 (MINOR)** — стенд не входит в npm-пакет и тянет `test/support/locales`. Решение: **фикс или явная оговорка в документах** (в tarball стенда нет; `stand: unavailable`).
- **T3 (NIT)** — комментарий `locales.ts:3`. Решение: **фикс** (одна строка).
- **T4 (NIT)** — README без `verify:kit` и с устаревшим счётчиком. Решение: **фикс** (две строки) либо принять как долг.
- **T5 (NIT)** — сырая ошибка при битой схеме. Решение: **принять** (fail-closed) либо обернуть в `E_SCHEMA_UNAVAILABLE` с тестом.
- **T6 (NIT)** — «4 merge-коммита» в live-отчёте. Решение: **фикс** формулировки на «3 merge + 1 ff».

```json
{
  "schema": "empiric/v1",
  "verdict": "ready",
  "claims_checked": [
    {
      "claim": "Кандидат: HEAD=476e9bd, 11 файлов в 7ab0d82..476e9bd (7b980c9 — lab-only), aggregate 2290e3a9…, 96 файлов",
      "method": "run",
      "command": "git log --oneline -3; git diff --name-status 7ab0d82..476e9bd; git show --stat 7b980c9; orch_uni_snapshot(exclude lab, eval/results)",
      "rc": "0",
      "result": "HEAD=476e9bd; 11 code-файлов (agents 2, docs 4, lib/tools.ts, package.json, test/support/harness.ts, test/tools.test.ts, tools/kit-verify.ts) + lab-файлы в 7b980c9; aggregate=2290e3a95eb138202cabb8701b7b7f3a484cff60725d0e75ed4895805d6913e3, files=96",
      "verdict": "confirmed"
    },
    {
      "claim": "G2: тест schema freshness PASS на текущем состоянии",
      "method": "run",
      "command": "bun test ./test/; bun test в temp-клоне 476e9bd",
      "rc": "0",
      "result": "92 pass / 0 fail / 762 expect (rc=0) в обоих прогонах; тест присутствует в test/tools.test.ts ('schema freshness')",
      "verdict": "confirmed"
    },
    {
      "claim": "G2: rollback-вариант (схемы кэшируются на регистрации) — тест FAIL",
      "method": "measure",
      "command": "temp-клон: const cachedSchemas = await loadSchemas(...) на регистрации + checkReport(..., schemas: cachedSchemas) → bun test",
      "rc": "1",
      "result": "1 fail: 'schema freshness > a schema edited while the plugin is live is applied on the next validation'; received {valid:true, schema:'probe/v1', errors:[]} vs expected {valid:false, code:'E_INVALID'}; 91 pass / 1 fail",
      "verdict": "confirmed"
    },
    {
      "claim": "G2: живой orch_uni_validate_report применяет свежую схему (workspace без base_commit / строкой → invalid, полный → valid)",
      "method": "run",
      "command": "orch_uni.validate_report(text, schema=fix-runner/v1) x4",
      "rc": "0",
      "result": "missingBase → valid:false '$.workspace.base_commit required field is missing'; wrongType (строка) → valid:false 'expected type object, got string'; full → valid:true; noWorkspace → valid:true (по прозе допустимо для одиночного запуска)",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: bun tools/kit-verify.ts → 4/4, rc=0",
      "method": "run",
      "command": "bun tools/kit-verify.ts",
      "rc": "0",
      "result": "PASS locale-check (rc=0, 0.1s) / PASS test (rc=0, 0.2s) / PASS biome (rc=0, 0.2s) / PASS tsc (rc=0, 1.9s); 'kit-verify: 4/4 ok'",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: --proj на temp-копии → 12/12",
      "method": "run",
      "command": "bun tools/kit-verify.ts --proj <temp agents+docs>",
      "rc": "0",
      "result": "'PASS docs/en/…'; 'kit-verify --proj: 12/12 pairs ok'; тот же результат при вызове из другого cwd с относительным путём (rc=0)",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: негативы — rc=1 на битой паре, rc=2 на пустом каталоге",
      "method": "run",
      "command": "sed '## 7'→'### 7' в копии; kit-verify --proj <копия>; kit-verify --proj <пустой>; kit-verify --bogus",
      "rc": "1",
      "result": "битая пара: 'kit-verify --proj: 11/12 pairs ok', rc=1; пустой каталог: 'no agents/** or docs/** locale pairs …' rc=2; мусорный аргумент: usage rc=2; --help rc=0",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: стенд сам сообщает о провале и продолжает шаги (kit-режим)",
      "method": "run",
      "command": "temp-клон: сломан заголовок ru/call-mechanics → bun tools/kit-verify.ts",
      "rc": "1",
      "result": "FAIL locale-check (rc=1) / FAIL test (rc=1) / PASS biome / PASS tsc; 'kit-verify: 2/4 ok', rc=1 — шаги не прерываются, провал виден",
      "verdict": "confirmed"
    },
    {
      "claim": "G3: упоминаний kit-sync не осталось",
      "method": "run",
      "command": "git grep -n 'kit-sync' -- . ':!lab' ':!node_modules'",
      "rc": "1",
      "result": "0 совпадений (rc=1); 'kit-verify' присутствует в agents/{ru,en}/fix-runner.md, docs/{ru,en}/{call-mechanics,root-runbook}.md, package.json — по одному на файл",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессии: npm test 92/92, locale-check 12/12, biome 0, typecheck 0",
      "method": "run",
      "command": "bun test ./test/; bun tools/locale-check.ts; npx biome check .; npx tsc --noEmit",
      "rc": "0",
      "result": "92 pass/0 fail/762 expect; 12/12 ok; 'Checked 34 files, No fixes applied'; tsc rc=0 без вывода",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессии: структура md и EN-локаль целы",
      "method": "compare_base",
      "command": "для 6 md: git show 7ab0d82:$f | grep -cE '^#{1,6} ' vs grep -cE '^#{1,6} ' $f; grep кириллицы agents/en docs/en",
      "rc": "0",
      "result": "call-mechanics 22/20 и root-runbook 7/2 в обеих локалях совпали с базой; агенты 0/0; EN_HAS_CYRILLIC=no",
      "verdict": "confirmed"
    },
    {
      "claim": "Live-эксперимент: 4 коммита с указанными SHA, по одному файлу, база 7b980c9, сведены в HEAD",
      "method": "run",
      "command": "в клоне %TEMP%/opencode/pfx-live/repo: git log -1 --format='%H parent=%p' для a5ad80a/3b94c91/577f33f/8c65044; git show --stat; git merge-base --is-ancestor <sha> HEAD; git worktree list",
      "rc": "0",
      "result": "все 4 существуют: parent=7b980c9, по одному файлу probe-N.txt (+1 строка); все ancestor-of-HEAD=yes; worktrees wt1..wt4 на ветках fix/live-1..4 с HEAD на своих SHA; в дереве probe-1..4.txt, status чист",
      "verdict": "confirmed"
    },
    {
      "claim": "Live-эксперимент: семантические проверки перед merge проходят для всех SHA",
      "method": "run",
      "command": "cat-file -t; merge-base --is-ancestor <base> <sha>; git diff --quiet <base> <sha>",
      "rc": "0",
      "result": "для каждого из 4 SHA: type=commit, ancestor_of_base=yes, diff_quiet_rc=1 (дельта непуста) — ровно те проверки, что предписаны root-runbook:29",
      "verdict": "confirmed"
    },
    {
      "claim": "Live-эксперимент: непересекающиеся наборы файлов и дельта по одному файлу на шаг",
      "method": "run",
      "command": "git show --stat по каждому коммиту; git diff --stat <merge>^1 <merge>",
      "rc": "0",
      "result": "наборы {probe-1},{probe-2},{probe-3},{probe-4} не пересекаются; дельты merge-шагов: 0fc4dae +probe-2, 30cae80 +probe-3, 39a1466 +probe-4, первый шаг — fast-forward a5ad80a (+probe-1)",
      "verdict": "confirmed"
    },
    {
      "claim": "Live-эксперимент: «история — 4 merge-коммита»",
      "method": "run",
      "command": "git log --graph --oneline -9; git log --merges --oneline | wc -l",
      "rc": "0",
      "result": "в истории 3 merge-коммита (0fc4dae, 30cae80, 39a1466) и один fast-forward (a5ad80a стоит прямо на main) — формулировка отчёта неточна, механика сведения при этом верна",
      "verdict": "refuted"
    },
    {
      "claim": "Out-of-scope: tsconfig.include без tools/** — kit-verify не типизируется",
      "method": "run",
      "command": "npx tsc --noEmit --listFiles | grep -c 'tools/'; npx tsc --noEmit --target esnext --module esnext --moduleResolution bundler --types node,bun --strict --skipLibCheck tools/kit-verify.ts",
      "rc": "2",
      "result": "tsc --listFiles → 0 файлов tools/ (include = index.ts, lib/**, test/**); прямой прогон по tools/kit-verify.ts → 'tools/kit-verify.ts(56,5): error TS2353: Object literal may only specify known properties, and 'shell' does not exist in type SpawnOptions<\"ignore\",\"pipe\",\"pipe\">', rc=2",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: стенд не попадает в npm-пакет (tools/ и test/ вне files)",
      "method": "run",
      "command": "npm pack --dry-run --json | grep -c '\"path\": \"tools/' ; grep -c '\"path\": \"test/'",
      "rc": "0",
      "result": "0 записей tools/ и 0 записей test/ в tarball; kit-verify.ts импортирует ../test/support/locales (строка 21) — стенд существует только в git-чекауте",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: устаревший комментарий test/support/locales.ts:3",
      "method": "run",
      "command": "sed -n '1,6p' test/support/locales.ts; ls lab/locale-check.ts",
      "rc": "0",
      "result": "комментарий: 'shared by the translation guard (test/translation.test.ts) and the dev checker (lab/locale-check.ts)'; ls → 'No such file or directory' (rc=2); фактический потребитель — tools/locale-check.ts и новый tools/kit-verify.ts",
      "verdict": "confirmed"
    },
    {
      "claim": "Out-of-scope: README без verify:kit",
      "method": "run",
      "command": "grep -n 'kit-verify\\|verify:kit' README.md README.ru.md; sed -n '295,312p' README.md",
      "rc": "1",
      "result": "0 совпадений в обоих README (rc=1); в разделе Development перечислены typecheck/test/lint/lint:fix без verify:kit; там же 'the shipped suite (90 tests in 8 files)' при фактических 92",
      "verdict": "confirmed"
    },
    {
      "claim": "Побочный эффект G2: битая схема всплывает на вызове валидатора, а не на регистрации",
      "method": "run",
      "command": "temp-клон: harness + подмена schemas/fix-runner.v1.json на невалидный JSON → runTool(validate_report)",
      "rc": "0",
      "result": "baseline valid:true; после порчи файла вызов THREW 'JSON Parse error: Expected }'; после восстановления снова valid:true — fail-closed, но ошибка сырая и не покрыта тестом",
      "verdict": "confirmed"
    },
    {
      "claim": "Стоимость свежих схем: «несколько небольших JSON на вызов»",
      "method": "measure",
      "command": "200 вызовов orch_uni_validate_report через harness",
      "rc": "0",
      "result": "200 вызовов за 91.0 ms = 0.45 ms/вызов (включая 7 чтений схем) — заявленная цена незначима",
      "verdict": "confirmed"
    }
  ],
  "modes_measured": [
    {
      "operation": "kit-verify в режимах стенда",
      "regimes": [
        "kit (4 шага)",
        "kit с поломкой пары",
        "--proj на целом клоне",
        "--proj на битой паре",
        "--proj на пустом каталоге",
        "--proj из другого cwd с относительным путём"
      ],
      "best": "kit: 4/4 ok rc=0; --proj целый: 12/12 rc=0 (в т.ч. из другого cwd)",
      "worst": "kit с поломкой: 2/4 ok rc=1 (FAIL locale-check/test, PASS biome/tsc); --proj битый: 11/12 rc=1; пустой каталог: rc=2 (отдельный код)",
      "budget_claim": null,
      "measured": "шаги 0.1–1.9 s; стенд не прерывается на первом провале; коды различают «нет пар» (2) и «есть ошибки» (1)"
    },
    {
      "operation": "цена свежих схем в validate_report",
      "regimes": [
        "200 последовательных вызовов"
      ],
      "best": "0.45 ms/вызов (200 за 91.0 ms), включая 7 чтений schemas/*.json",
      "worst": "то же (единственный режим; кэш убран намеренно)",
      "budget_claim": "«a price of a few small JSON reads per validation» (lib/tools.ts, комментарий)",
      "measured": "0.45 ms/вызов — бюджет не заявлен числом, деградации не видно"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение",
      "status": "applied",
      "note": "Temp-клон 476e9bd + rollback схемного кэша (тест краснеет), temp-копия agents/docs для --proj (целая/битая/пустая), harness-пробники на битую схему и стоимость"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "11 файлов; 96 файлов; 92 pass/762 expect; 12/12; 4/4; 12/12; 11/12 rc=1; rc=2; 0.45 ms/вызов; 0 tools/ в --listFiles; 0 записей tools/test в npm pack"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора",
      "status": "applied",
      "note": "Пересчитаны 4/4, 12/12, rc=1/rc=2, 92 pass, 12/12, biome, tsc — совпали; поправка: «4 merge-коммита» → 3 merge + 1 fast-forward"
    },
    {
      "item": 4,
      "title": "Сравнение с базой",
      "status": "applied",
      "note": "Структура md 7ab0d82 vs 476e9bd; для live-эксперимента база 7b980c9 и дерево клона сохранены — сверял коммиты/merge-топологию"
    },
    {
      "item": 5,
      "title": "Факты окружения из команд",
      "status": "applied",
      "note": "bun 1.4.2, node_modules 373 записи, tsc --listFiles, npm pack --dry-run — всё из прогонов"
    },
    {
      "item": 6,
      "title": "Первоисточники",
      "status": "applied",
      "note": "Читал lib/tools.ts (изменённый executor), tools/kit-verify.ts целиком, test/tools.test.ts (новый тест), tsconfig.json, package.json files, отчёты live-experiment/fix-runner-r3"
    },
    {
      "item": 7,
      "title": "Прототип в нескольких режимах",
      "status": "applied",
      "note": "Стенд в 6 режимах (kit/kit-fail/--proj ok/--proj fail/пусто/чужой cwd); схемы: stale vs fresh vs битая; назван худший"
    },
    {
      "item": 8,
      "title": "Крайние значения",
      "status": "applied",
      "note": "validate_report: workspace без base_commit / строкой / полный / отсутствует; kit-verify: пустой каталог (2), мусорный аргумент (2), --help (0), --proj из другого cwd"
    },
    {
      "item": 9,
      "title": "Оценки без замера",
      "status": "applied",
      "note": "Единственная оценка — «несколько JSON на вызов»; замерил 0.45 ms/вызов; чисел бюджета в диффе нет"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто везде",
      "status": "applied",
      "note": "kit-sync: 0 совпадений вне lab (agents/docs/README/package/lib/test/tools); kit-verify присутствует в 6 md + package.json; README (shipped) упоминания не получил — зафиксировано как NIT"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном",
      "status": "applied",
      "note": "Эталон стенда — прежний ручной набор (locale-check/test/biome/tsc): kit-verify выдаёт те же шаги с теми же rc; отличия: rc=2 для «нет пар», отсутствие kit-sync — согласовано с документами"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы",
      "status": "applied",
      "note": "Повторные прогоны стенда и тестов дают те же счётчики; границы (пустой каталог, битая пара, мусорные аргументы) проверены запуском"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "Две формы запуска стенда (kit из KitRoot и по абсолютному пути из чужого cwd) дают один результат; --proj с относительным путём разрешается от cwd; коды 0/1/2 различают исходы"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей до потребителя",
      "status": "applied",
      "note": "workspace-валидация доезжает до живого инструмента (проверено); стенд доезжает до git-чекаута, но не до npm-пакета (files) — зафиксировано как MINOR"
    },
    {
      "item": 15,
      "title": "Непроверенное не как факт",
      "status": "applied",
      "note": "Linux/macOS-ветка стенда, сессии live-эксперимента, установка из npm-пакета — в not_verified"
    },
    {
      "item": 16,
      "title": "Дисциплина rc",
      "status": "applied",
      "note": "rc зафиксированы: kit-verify 0/1/2, rollback-тест 1, tsc по tools 2, grep без совпадений 1, ls отсутствующего 2; где пайп глотал rc — перезапуск в файл"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "Стенд: 6 режимов, из них 3 негативных (битая пара, пустой каталог, мусорный аргумент); схемы: 4 варианта отчёта + порча файла схемы; статистика 8 входов, все исходы соответствуют контракту"
    },
    {
      "item": 18,
      "title": "Тесты — объект аудита",
      "status": "applied",
      "note": "Новый тест load-bearing подтверждён откатом (краснеет); при этом tools/** вне tsconfig и у kit-verify нет собственных тестов — сетка не покрывает сам стенд"
    },
    {
      "item": 19,
      "title": "База без git",
      "status": "not_applicable",
      "note": "История и база 7ab0d82/7b980c9 доступны"
    }
  ],
  "findings": [
    {
      "id": "T1",
      "severity": "MINOR",
      "location": "tsconfig.json (include) + tools/kit-verify.ts:56",
      "mechanism": "Стенд не типизируется собственным шагом: tsconfig.include = index.ts, lib/**, test/** — tools/** вне охвата, поэтому `tsc --noEmit` (и шаг tsc в kit-verify) зелёный, хотя kit-verify.ts содержит реальную ошибку типов TS2353: параметр `shell` отсутствует в типе SpawnOptions установленного @types/bun. Рантайм работает (шаг biome на Windows проходит через shell), но «tsc зелёный» о стенде ничего не говорит, и любая типовая регрессия в tools/ пройдёт незамеченной.",
      "evidence": "npx tsc --noEmit --listFiles | grep -c 'tools/' → 0 (rc=1); npx tsc --noEmit --target esnext --module esnext --moduleResolution bundler --types node,bun --strict --skipLibCheck tools/kit-verify.ts → 'error TS2353 … 'shell' does not exist in type SpawnOptions<\"ignore\",\"pipe\",\"pipe\">', rc=2; при этом bun tools/kit-verify.ts → 4/4 ok rc=0 (шаг biome через .cmd-шим прошёл)",
      "fix": "Добавить \"tools/**/*.ts\" в tsconfig.include и убрать ошибку: типизировать опции как Bun.SpawnOptions (или не передавать shell — на Windows вызывать .cmd через shell-обёртку явно), затем прогнать kit-verify: шаг tsc должен остаться rc=0 уже с tools/."
    },
    {
      "id": "T2",
      "severity": "MINOR",
      "location": "package.json (files) + tools/kit-verify.ts:21 + agents/*/fix-runner.md:9, docs/*/root-runbook.md:29",
      "mechanism": "Документы называют стенд инструментом комплекта («инструмент tools/kit-verify каталога комплекта»), но в npm-пакет он не попадает: files = index.ts, lib, schemas, agents, docs, README*, LICENSE; tools/ и test/ отсутствуют в tarball. Дополнительно kit-verify импортирует ../test/support/locales, т.е. поставить его в пакет нельзя без тестовых хелперов. Для потребителя из npm стенд недоступен, и формулировка «поставляется» неоднозначна (git-чекаут vs tarball).",
      "evidence": "npm pack --dry-run --json → 0 записей 'path: tools/', 0 записей 'path: test/' (rc=0); package.json files: [index.ts, lib, schemas, agents, docs, README.md, README.ru.md, LICENSE]; grep kit-verify в agents/docs — 6 файлов, package.json — 1",
      "fix": "Либо добавить tools/ (+test/support) в files и отвязать стенд от test-хелпера (перенести pairIssues в lib/), либо в документах писать «стенд доступен в git-чекауте комплекта, в npm-пакете его нет» и оставить stand: unavailable для потребителей."
    },
    {
      "id": "T3",
      "severity": "NIT",
      "location": "test/support/locales.ts:3",
      "mechanism": "Комментарий описывает потребителей неверно: указан несуществующий 'dev checker (lab/locale-check.ts)'; фактически pairIssues используют tools/locale-check.ts и новый tools/kit-verify.ts. Комментарий вводит в заблуждение при поиске контракта паритета.",
      "evidence": "sed -n '1,6p' test/support/locales.ts → '… and the dev checker (lab/locale-check.ts)'; ls lab/locale-check.ts → 'No such file or directory' (rc=2); grep pairIssues → tools/locale-check.ts:15,22 и tools/kit-verify.ts:21,134",
      "fix": "Заменить на 'shared by the translation guard (test/translation.test.ts) and the dev checkers (tools/locale-check.ts, tools/kit-verify.ts)'."
    },
    {
      "id": "T4",
      "severity": "NIT",
      "location": "README.md:295-312 (и README.ru.md), package.json:48",
      "mechanism": "В разделе Development перечислены typecheck/test/lint/lint:fix, но новый script verify:kit не упомянут; там же устаревший счётчик тестов ('90 tests in 8 files' при 92). README — единственный пользовательский документ, описывающий набор проверок, и он расходится с package.json.",
      "evidence": "grep -n 'kit-verify|verify:kit' README.md README.ru.md → 0 (rc=1); sed -n '295,312p' README.md → 'npm run typecheck / npm test / npm run lint / npm run lint:fix' и 'the shipped suite (90 tests in 8 files)'; фактически 92 pass (762 expect)",
      "fix": "Добавить строку `npm run verify:kit  # bun tools/kit-verify.ts (locale parity, tests, lint, types)` и обновить счётчик тестов в обоих README."
    },
    {
      "id": "T5",
      "severity": "NIT",
      "location": "lib/tools.ts:351 (свежая загрузка схем)",
      "mechanism": "Побочный эффект G2: схемы читаются в каждом вызове, поэтому битый/недописанный файл схемы теперь всплывает как исключение из executor'а (сырая ошибка JSON.parse) вместо прежнего fail-fast на регистрации плагина. Поведение fail-closed (валидного отчёта не выдаёт), но семантика ошибки нигде не задана и тестом не покрыта.",
      "evidence": "temp-клон: baseline validate_report → valid:true; после записи '{ this is not json' в schemas/fix-runner.v1.json тот же harness → THREW 'JSON Parse error: Expected }'; после восстановления → valid:true (probe rc=0)",
      "fix": "Обернуть loadSchemas в executor и возвращать типизированный отказ (например E_SCHEMA_UNAVAILABLE с путём файла), добавить тест на битую схему."
    },
    {
      "id": "T6",
      "severity": "NIT",
      "location": "lab/audit-pfx/reports/live-experiment.md (раздел «Сведение по SHA»)",
      "mechanism": "Отчёт утверждает «история — 4 merge-коммита поверх своих веток», фактически в клоне 3 merge-коммита (0fc4dae, 30cae80, 39a1466) и первый шаг — fast-forward (a5ad80a стоит прямо на main). Механика сведения и дельты при этом верны, но описание топологии неточно.",
      "evidence": "git log --graph --oneline -9 в %TEMP%/opencode/pfx-live/repo → 'a5ad80a fix: probe 1' на линии main, затем три merge-коммита; git diff --stat <merge>^1 <merge> → по одному файлу probe-2/3/4",
      "fix": "Поправить формулировку: «3 merge-коммита + 1 fast-forward» (или явно указать, что первый SHA влит ff-ом)."
    }
  ],
  "contract_gaps": [
    {
      "item": "Что значит «стенд поставляется в комплекте»",
      "where": "agents/*/fix-runner.md:9; docs/*/root-runbook.md:29; package.json files",
      "why": "Не различаются git-чекаут и npm-пакет: в tarball нет tools/ и test/, а стенд зависит от test/support/locales — потребитель не может определить, доступен ли стенд"
    },
    {
      "item": "Гарантии стенда о самом себе",
      "where": "tools/kit-verify.ts (шаг tsc) + tsconfig.json",
      "why": "Шаг tsc покрывает lib/test, но не tools/**; не задано, входит ли сам стенд в проверяемую поверхность"
    },
    {
      "item": "Семантика отказа при недоступных/битых схемах",
      "where": "lib/tools.ts:351 (validate_report)",
      "why": "Не задано, что должен вернуть валидатор при нечитаемом schemas/*.json: типизированный отказ, E_INVALID или исключение"
    }
  ],
  "not_verified": [
    {
      "item": "Linux/macOS-ветка kit-verify (WINDOWS=false: localBinary без .cmd, spawn без shell)",
      "why": "Проверял только на win32; другая ветка кода не исполнялась"
    },
    {
      "item": "Сессии live-эксперимента (4 дочерние сессии, session_move 4/4, preflight)",
      "why": "Логов сессий нет; проверены только артефакты (коммиты, worktrees, дерево), сами LLM-сессии не наблюдались"
    },
    {
      "item": "Установка из npm-пакета и наличие стенда у потребителя",
      "why": "Проверен только состав tarball через npm pack --dry-run, без установки"
    }
  ]
}
```
