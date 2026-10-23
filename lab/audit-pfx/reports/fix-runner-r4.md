# Fix-runner r4 (pfx, r3-арбитраж) — закрытие MINOR/NIT F1–F7

База: `476e9bd` (main, `C:\project\ai\opencode-orchestrator-uni`). Коммит правок: `816cffa18069e105b8a2f753aafd29ffbc5b6550`, один локальный, **не запушен**.
Запуск одиночный по явному указанию вызова — в основном чекауте на `main`, поэтому объект `workspace` не заполняется (preflight правила 12 применим к отдельному рабочему пространству и здесь не используется). В дереве до/после — только незакоммиченные lab-файлы root'а (`summary-pfx.md`, `risks-pfx.md`), не тронуты.

Итог: **F1–F7 закрыто** (0 `not_closed`, 0 `needs_decision`). Отклонения зафиксированы в `note`: опциональный «прогревающий» load (F1) не реализован; в F7 счётчик тестов — 93, а не 92 (F1 добавил тест); F4 «self-check» реализован в `tools/locale-check.ts` в дополнение к `--proj`.

Проверки после: `npm test` 93/0 (770 expect, 8 файлов), `bun tools/locale-check.ts` 12/12, `npx biome check .` rc=0 (34 файла), `bun run typecheck` rc=0 (в `include` теперь и `tools/**`), `bun tools/kit-verify.ts` 4/4 rc=0, `--proj` 12/12 rc=0 и с EN-сиротой 12/13 rc=1 (`FAIL docs/en/zz-extra.md — orphan translation`).

```json
{
  "schema": "fix-runner/v1",
  "round": "pfx-r4",
  "commit": "816cffa18069e105b8a2f753aafd29ffbc5b6550",
  "results": [
    {
      "id": "F1",
      "status": "closed",
      "change": "lib/tools.ts:49-119 — типизированный `SchemaIoError` (code=E_SCHEMA_IO, поля directory/file): readdir, readFile, JSON.parse и проверка формы документа оборачиваются в него вместо сырых Error/SyntaxError; lib/tools.ts:402-415 — `validateReport` ловит его и возвращает `failure(\"E_SCHEMA_IO\", message, {directory, file})`, любой иной throw — тоже E_SCHEMA_IO; отчётные коды (E_NO_JSON/E_PARSE/E_UNKNOWN_SCHEMA/E_INVALID) не тронуты; lib/tools.ts:558 — E_SCHEMA_IO добавлен в рекламируемый список кодов инструмента. test/tools.test.ts:336-365 — новый тест «schema registry failures» (битый JSON + отсутствующий каталог).",
      "before": "bun %TEMP%/repro-f1.ts → `broken-json THREW SyntaxError | JSON Parse error: Expected '}'`; `missing-dir THREW Error | ENOENT: no such file or directory, scandir …\\nope`",
      "after": "тот же сценарий через runTool → `{ok:false, code:\"E_SCHEMA_IO\", directory, file:\"…\\broken.v1.json\"}` (PASS теста, 8 expect); сообщение содержит каталог и файл",
      "proof": "git checkout -- lib/tools.ts && bun test ./test/ -t \"schema registry failures\" → 1 fail (SyntaxError в loadSchemas, стек на lib/tools.ts:63/351); git apply (восстановление) → 1 pass / 0 fail",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0",
      "tests": "bun test ./test/ -t \"schema registry failures\" → 1 pass / 0 fail; npm test → 93 pass / 0 fail",
      "note": "отклонение: опциональный «прогревающий» load при регистрации (fail-early) не реализован — у `registerAuditTools` нет типизированного канала отказа (возвращает cleanup, throw обрывает загрузку плагина), а требуемое поведение «отсутствующий каталог → типизированный отказ, не throw» достигается только на пути вызова инструмента, потому что harness/регистрация происходят до любого вызова. Тест покрывает оба сценария; отчётные коды не менялись (проверено test/tools.test.ts «delegates schema failures to their own codes»)."
    },
    {
      "id": "F2",
      "status": "closed",
      "change": "agents/{ru,en}/fix-runner.md:28 (правило 9) и docs/{ru,en}/{call-mechanics.md:126,root-runbook.md:29}: в каждый носитель добавлено одно предложение — стенд поставляется в git-чекауте комплекта, в npm-пакете каталог `tools/` не поставляется → `stand: unavailable` и собственные воспроизводимые проверки. `package.json`/`files` не менялись; фенсы/заголовки/фронтматтер/enum-токены сохранены.",
      "before": "git show HEAD:<file> | grep -c 'npm-пакете|npm package does not ship' → 0 в каждом из 6 носителей",
      "after": "grep -c по тем же файлам → 1 в каждом: agents/ru/fix-runner.md=1, agents/en/fix-runner.md=1, docs/ru/call-mechanics.md=1, docs/en/call-mechanics.md=1, docs/ru/root-runbook.md=1, docs/en/root-runbook.md=1",
      "proof": "grep-проверка присутствия формулировки в 6 носителях (before 0 → after 1 каждый); структурный паритет подтверждён test/translation.test.ts (входит в npm test 93/0) и bun tools/locale-check.ts 12/12 — правка текста без изменения структуры",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0 (шаг locale-check покрывает пары ru↔en)",
      "tests": "npm test → 93 pass / 0 fail (в т.ч. structural parity ru/en); bun tools/locale-check.ts → 12/12 ok",
      "note": "Формулировка EN без кириллицы (проверено скриптом по \\u0400-\\u04FF: EN_CYRILLIC=none). Смысл/структура сохранены: добавлено одно предложение, остальной текст не менялся."
    },
    {
      "id": "F3",
      "status": "closed",
      "change": "tools/kit-verify.ts:45-67 — удалена мёртвая опция `shell` и хелпер `needsShell`; на Windows `.cmd` спавнится как `[process.env.ComSpec ?? \"cmd.exe\", \"/c\", ...command]`, остальное — прямой spawn. tsconfig.json:12 — в `include` добавлен `tools/**/*.ts`.",
      "before": "npx tsc --noEmit --listFiles | grep -c 'tools/' → 0; прямой прогон по tools/kit-verify.ts → `TS2353: 'shell' does not exist in type SpawnOptions<...>`, rc=2",
      "after": "npx tsc --noEmit --listFiles | grep 'tools/' → tools/kit-verify.ts, tools/locale-check.ts (2 файла); bun run typecheck → rc=0; bun tools/kit-verify.ts → PASS biome/tsc (спавн через ComSpec работает)",
      "proof": "git checkout -- tsconfig.json && npx tsc --noEmit --listFiles | grep -c 'tools/' → 0 (свойство «tools типизируются» пропадает); восстановление → 2 файла, rc=0. git checkout -- tools/kit-verify.ts (при include с tools) && npx tsc --noEmit → TS2353, rc=2; восстановление → rc=0",
      "stand": "baseline 4/4 ok rc=0 (шаг tsc зелёный без tools/) → after 4/4 ok rc=0 (шаг tsc реально покрывает tools/**)",
      "tests": "bun run typecheck → rc=0; npx tsc --noEmit → rc=0; npx biome check . → rc=0",
      "note": "Арбитр отмечал, что `shell:true/false` для `.cmd` эквивалентны; правка выполнена по рекомендованному механизму (ComSpec /c), чтобы не держать поведение на неявном свойстве Bun: Windows-ветка теперь явная, `.cmd` получает интерпретатор, прочие бинари идут прямым spawn."
    },
    {
      "id": "F4",
      "status": "closed",
      "change": "tools/kit-verify.ts:133-149,160-181 — `orphanTranslations()` и проверка в `runProjectStand`: наборы имён ru↔en сравниваются в обе стороны, EN-файл без ru-близнеца даёт `FAIL <root>/en/<file>` + `- orphan translation: no <root>/ru/<file>`, rc=1, итог `N/M pairs ok` по сумме пар и сирот. tools/locale-check.ts:26-35,53-77 — та же двусторонняя проверка наборов в self-check комплекта (шаг locale-check стенда).",
      "before": "копия agents+docs в temp + docs/en/zz-extra.md → bun tools/kit-verify.ts --proj <копия> → `kit-verify --proj: 12/12 pairs ok`, rc=0 (сирота невидима)",
      "after": "чистая копия → 12/12 pairs ok, rc=0; с docs/en/zz-extra.md → `FAIL  docs/en/zz-extra.md` / `- orphan translation: no docs/ru/zz-extra.md`, 12/13, rc=1. Self-check: `printf > docs/en/zz-orphan-probe.md; bun tools/locale-check.ts` → `FAIL docs\\en\\zz-orphan-probe.md` / `- orphan translation: no reference file`, 12/13, rc=1 (проба удалена, дерево чисто); без пробы — 12/12, rc=0",
      "proof": "git checkout -- tools/kit-verify.ts && bun tools/kit-verify.ts --proj <копия с сиротой> → 12/12, rc=0 (проверка не срабатывает); после восстановления → rc=1 с FAIL orphan",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0 (+ --proj: 12/12 rc=0, с сиротой rc=1)",
      "tests": "npm test → 93 pass / 0 fail; --proj чистый → rc=0, --proj с сиротой → rc=1",
      "note": "«добавить проверку в self-check» реализовано в tools/locale-check.ts (шаг locale-check стенда) сверх указанной локации `--proj` — это тот же класс дефекта (двустороннее сравнение наборов имён), и без него self-check комплекта оставался слеп к EN-сироте. Дефолтный вывод комплекта не изменился: 12/12 ok."
    },
    {
      "id": "F5",
      "status": "closed",
      "change": "tools/kit-verify.ts:32-35,69-78 — из строки шага убраны секунды: `PASS/FAIL <step> (rc=N)`; поле `seconds` и замер `performance.now()` удалены. Структура PASS/FAIL + итог `kit-verify: N/M ok` сохранена.",
      "before": "два прогона подряд → diff: `PASS biome (rc=0, 0.1s)` vs `PASS biome (rc=0, 0.2s)`",
      "after": "два прогона подряд → diff пуст (IDENTICAL); вывод: PASS locale-check (rc=0) / PASS test (rc=0) / PASS biome (rc=0) / PASS tsc (rc=0) / kit-verify: 4/4 ok",
      "proof": "git checkout -- tools/kit-verify.ts → два прогона различаются (`FAIL tsc (rc=2, 1.7s)` vs `1.6s`); после восстановления → IDENTICAL",
      "stand": "baseline (с таймингами) 4/4 ok rc=0 → after (без таймингов, байт-детерминирован) 4/4 ok rc=0",
      "tests": "bun tools/kit-verify.ts ×2 → вывод идентичен; rc=0",
      "note": "отклонений нет: структура PASS/FAIL и итог сохранены, изменилась только строка шага."
    },
    {
      "id": "F6",
      "status": "closed",
      "change": "test/support/locales.ts:2-3 — комментарий: `lab/locale-check.ts` → `tools/locale-check.ts`, `tools/kit-verify.ts`.",
      "before": "git show HEAD:test/support/locales.ts | grep -c 'lab/locale-check' → 1",
      "after": "grep -c 'lab/locale-check' test/support/locales.ts → 0; ссылки на tools/locale-check.ts и tools/kit-verify.ts присутствуют (по 1)",
      "proof": "grep-проверка (before 1 → after 0) — комментарий, рантайм-поведения не имеет; типы/линт проходят",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0",
      "tests": "npm test → 93 pass / 0 fail; npx biome check . → rc=0",
      "note": "—"
    },
    {
      "id": "F7",
      "status": "closed",
      "change": "README.md:301-303 и README.ru.md:308-310 — в блок скриптов добавлены `npm run check:locales` (bun tools/locale-check.ts) и `npm run verify:kit` (bun tools/kit-verify.ts); README.md:309 / README.ru.md:316 — счётчик набора обновлён 90 → 93 теста в 8 файлах.",
      "before": "git show HEAD:README.md | grep -Ec 'check:locales|verify:kit' → 0 (то же для README.ru.md); счётчик `(90 tests)` / `(90 тестов)` присутствует",
      "after": "grep -Ec 'check:locales|verify:kit' → 2 в каждом README; `(93 tests` / `(93 теста` присутствует, `(90 …` отсутствует",
      "proof": "grep-проверка парности ru/en + test/translation.test.ts (heading levels и fences README.ru.md против README.md) в составе npm test → PASS",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0",
      "tests": "npm test → 93 pass / 0 fail (включая README-паритет); bun tools/locale-check.ts → 12/12 ok",
      "note": "отклонение: счётчик записан как 93, а не 92 — F1 добавил новый тест, фактический набор после правок 93 (bun test: 93 pass / 0 fail). Запись «92» была бы устаревшей в момент коммита."
    }
  ],
  "out_of_scope": [
    {
      "note": "README.md:84-91 / README.ru.md:85-92 — таблица кодов validate_report не содержит E_SCHEMA_IO (код задокументирован только в описании инструмента, lib/tools.ts:558).",
      "why_suspicious": "Новый публичный код отказа не виден в таблице README; правка README ограничена разделом скриптов (F7), поэтому строка таблицы не добавлена."
    },
    {
      "note": "tools/kit-verify.ts — rc=2 используется и для usage-ошибки, и для «нет пар/сирот».",
      "why_suspicious": "Два разных смысла одним кодом (contract_gap из invariant-r3); вне списка."
    },
    {
      "note": "tools/kit-verify.ts — обход нерекурсивный и фильтрует только Dirent.isFile(): файлы-симлинки молча выпадают из пар.",
      "why_suspicious": "Молчаливое сужение области проверки; вне списка."
    },
    {
      "note": "tools/kit-verify.ts — шаги ждут child.exited без таймаута.",
      "why_suspicious": "Зависший бинарь повесит стенд без диагностики; вне списка."
    }
  ]
}
```
