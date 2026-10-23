# Эмпирический аудит pfx — re-audit (круг 6, узкий; кандидат ae6b9e4)

Ревизия: `ae6b9e4` (aggregate `53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed`, 96 файлов; диапазон `2f5c581..ae6b9e4` = 2 файла, +2/−2).
Роль: empiric (read-only). Прогоны — в temp-каталоге (удалён); аудируемый репозиторий не менялся (в `git status` только `lab/`-правки root'а).

## Резюме

Вердикт: **ready**. N1/S1 закрыт:

- позиционных ссылок («last two» / «две последние») нет — `git grep` по README/docs/agents даёт 0 (rc=1);
- обе README называют команды явно и параллельно: `The `check:locales` and `verify:kit` scripts need a git checkout of the kit …` / `Команды `check:locales` и `verify:kit` требуют git-чекаута комплекта …`;
- референт подтверждён запуском: в распакованном npm-пакете `tools/` отсутствует, `bun tools/locale-check.ts` и `bun tools/kit-verify.ts` дают `Module not found` (rc=1) — то есть оговорка относится ровно к этим двум скриптам;
- факт «npm-пакет без tools/» не изменился (tarball: LICENSE, README*, agents, docs, index.ts, lib, package.json, schemas), `E_SCHEMA_IO` в README пакета присутствует;
- регрессий нет: 93/93 (770 expect), 12/12, biome 0, tsc 0, kit-verify 4/4; README h=16/16, fence=30/30 в обеих локалях, EN без кириллицы; дифф — ровно одна строка в каждом README.

Находок нет: новых расхождений диапазон не вносит.

## Ключевые прогоны

| Что | Команда | Результат |
|---|---|---|
| Позиционные ссылки | `git grep -nE 'last two commands|две последние'` | 0 совпадений, rc=1 |
| Именование команд | `grep 'check:locales` and `verify:kit'` | README.md:310 и README.ru.md:317 — параллельные формулировки |
| Референт | `npm pack` → `tar --force-local` → запуск в пакете | tools/ нет (ls rc=2); `Module not found` ×2, rc=1 |
| Guard'ы | test / locale / biome / tsc / kit-verify | 93 pass · 12/12 · 0 · 0 · 4/4 |
| Структура README | h/fence 2f5c581 vs ae6b9e4 | 16/16 и 30/30 в обеих локалях |

```json
{
  "schema": "empiric/v1",
  "verdict": "ready",
  "claims_checked": [
    {
      "claim": "Кандидат: HEAD=ae6b9e4, ровно 2 файла в 2f5c581..ae6b9e4 (+2/−2), aggregate 53dd7b96…, 96 файлов",
      "method": "run",
      "command": "git log --oneline -1; git diff --name-status 2f5c581..ae6b9e4; git diff; orch_uni_snapshot(exclude lab, eval/results)",
      "rc": "0",
      "result": "HEAD=ae6b9e4; изменены только README.md и README.ru.md (+2/−2, по одной строке в каждом); aggregate=53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed, files=96",
      "verdict": "confirmed"
    },
    {
      "claim": "N1/S1: позиционной ссылки («last two» / «две последние») больше нет",
      "method": "run",
      "command": "git grep -nE 'last two commands|the last two|две последние|двух последних|последние две' -- README.md README.ru.md docs agents",
      "rc": "1",
      "result": "0 совпадений (rc=1)",
      "verdict": "confirmed"
    },
    {
      "claim": "N1/S1: оговорка называет именно tools-команды в обеих README, формулировки параллельны",
      "method": "run",
      "command": "grep -n 'check:locales` and `verify:kit|check:locales` и `verify:kit' README.md README.ru.md",
      "rc": "0",
      "result": "README.md:310 'The `check:locales` and `verify:kit` scripts need a git checkout of the kit — the npm package ships no `tools/` directory, so in an installed package they are unavailable (`stand: unavailable` plus your own reproducible checks).'; README.ru.md:317 'Команды `check:locales` и `verify:kit` требуют git-чекаута комплекта — в npm-пакете каталог `tools/` не поставляется, поэтому в установленном пакете они недоступны (`stand: unavailable` и собственные воспроизводимые проверки).'",
      "verdict": "confirmed"
    },
    {
      "claim": "N1/S1: референт верен — именно эти два скрипта недоступны в npm-пакете",
      "method": "run",
      "command": "npm pack --pack-destination <temp>; tar --force-local -xzf; bun tools/locale-check.ts и bun tools/kit-verify.ts в распакованном пакете",
      "rc": "1",
      "result": "в пакете нет tools/ (ls → No such file or directory, rc=2); check:locales → 'error: Module not found \"tools/locale-check.ts\"', rc=1; verify:kit → 'error: Module not found \"tools/kit-verify.ts\"', rc=1 — оговорка относится ровно к ним",
      "verdict": "confirmed"
    },
    {
      "claim": "Факт «npm-пакет без tools/» не изменился, README в пакете содержит E_SCHEMA_IO",
      "method": "run",
      "command": "ls распакованного пакета; grep -c E_SCHEMA_IO package/README.md",
      "rc": "0",
      "result": "состав: LICENSE, README.md, README.ru.md, agents, docs, index.ts, lib, package.json, schemas; tools/ отсутствует; E_SCHEMA_IO в README пакета — 1",
      "verdict": "confirmed"
    },
    {
      "claim": "Регрессии: 93/93, locale 12/12, biome 0, tsc 0, kit-verify 4/4",
      "method": "run",
      "command": "bun test ./test/; bun tools/locale-check.ts; npx biome check .; npx tsc --noEmit; bun tools/kit-verify.ts",
      "rc": "0",
      "result": "93 pass / 0 fail / 770 expect; 12/12 ok; 'Checked 34 files, No fixes applied'; tsc rc=0; 'kit-verify: 4/4 ok'",
      "verdict": "confirmed"
    },
    {
      "claim": "Структура README и паритет ru/en не поехали",
      "method": "compare_base",
      "command": "заголовки/фенсы README.md и README.ru.md 2f5c581 vs ae6b9e4; LC_ALL=C.UTF-8 grep кириллицы в README.md",
      "rc": "0",
      "result": "README.md h=16/16, fence=30/30; README.ru.md h=16/16, fence=30/30; различие только в одной строке абзаца; в английском README кириллицы нет (EN_HAS_CYRILLIC=no)",
      "verdict": "confirmed"
    },
    {
      "claim": "Новых расхождений не внесено (диапазон трогает только README-абзац)",
      "method": "run",
      "command": "git diff --name-status 2f5c581..ae6b9e4; git diff",
      "rc": "0",
      "result": "изменены ровно 2 файла, ровно по одной строке (позиционная ссылка заменена на именование команд); прочие разделы, таблица кодов, нормативные доки не тронуты",
      "verdict": "confirmed"
    }
  ],
  "modes_measured": [
    {
      "operation": "доступность объявленных tools-скриптов у потребителя",
      "regimes": [
        "git-чекаут (tools/ есть)",
        "npm-пакет (tools/ нет)"
      ],
      "best": "чекаут: kit-verify 4/4 rc=0 (и --proj 12/12 ранее)",
      "worst": "npm-пакет: оба скрипта 'Module not found', rc=1",
      "budget_claim": null,
      "measured": "tarball без tools/; оговорка README теперь ссылается ровно на эти два скрипта"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение",
      "status": "applied",
      "note": "npm pack + распаковка и запуск обоих tools-скриптов в пакете; grep-критерии по позиционным ссылкам"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "2 файла/+2−2; 96; 93/770; 12/12; 4/4; grep=0; README 16/16 и 30/30 в обеих локалях; 1 вхождение E_SCHEMA_IO в пакете"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора",
      "status": "applied",
      "note": "Совпало: 93/93, 12/12, 4/4, формулировки в обеих локалях; референт подтверждён запуском в пакете"
    },
    {
      "item": 4,
      "title": "Сравнение с базой",
      "status": "applied",
      "note": "Структура README 2f5c581 vs ae6b9e4 (h/fence), дифф — одна строка на файл"
    },
    {
      "item": 5,
      "title": "Факты окружения из команд",
      "status": "applied",
      "note": "bun 1.4.2, npm pack, tar --force-local (обычный tar на win-пути падал: 'Cannot connect to C: resolve failed') — из прогонов"
    },
    {
      "item": 6,
      "title": "Первоисточники",
      "status": "applied",
      "note": "Читал обе README вокруг абзаца, package.json files (из пакета), исполнение скриптов в распакованном tarball"
    },
    {
      "item": 7,
      "title": "Прототип в нескольких режимах",
      "status": "applied",
      "note": "чекаут vs npm-пакет — двухрежимная проверка референта оговорки"
    },
    {
      "item": 8,
      "title": "Крайние значения",
      "status": "applied",
      "note": "пакет без tools/; явные имена скриптов вместо позиционной ссылки"
    },
    {
      "item": 9,
      "title": "Оценки без замера",
      "status": "applied",
      "note": "заявка «командам нужен чекаут» проверена запуском в пакете (Module not found)"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто везде",
      "status": "applied",
      "note": "позиционных ссылок нет ни в README, ни в docs/agents (grep=0); оговорка присутствует в обеих локалях"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном",
      "status": "applied",
      "note": "эталон формулировки — предыдущая версия абзаца: смысл сохранён, референт исправлен на именованный"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы",
      "status": "applied",
      "note": "guard-прогоны стабильны, структура README не изменилась"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "RU/EN абзацы параллельны (одинаковая структура: имена команд → требование чекаута → следствие stand: unavailable)"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей",
      "status": "applied",
      "note": "референт оговорки доезжает до реального поведения: оба названных скрипта действительно недоступны в пакете"
    },
    {
      "item": 15,
      "title": "Непроверенное не как факт",
      "status": "applied",
      "note": "установка у потребителя через npm install не воспроизводилась (только распакованный tarball) — в not_verified"
    },
    {
      "item": 16,
      "title": "Дисциплина rc",
      "status": "applied",
      "note": "rc: grep 1, pack 0, extract 0, ls 2, check:locales 1, verify:kit 1, тесты/стенд 0"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "2 режима (чекаут/пакет) x 2 скрипта — исходы соответствуют оговорке"
    },
    {
      "item": 18,
      "title": "Тесты — объект аудита",
      "status": "applied",
      "note": "паритет локалей снова слеп к смысловым ошибкам, поэтому референт проверялся запуском, а не тестами"
    },
    {
      "item": 19,
      "title": "База без git",
      "status": "not_applicable",
      "note": "история и база 2f5c581 доступны"
    }
  ],
  "findings": [],
  "contract_gaps": [],
  "not_verified": [
    {
      "item": "Поведение после npm install у потребителя (с установленными devDependencies)",
      "why": "Проверял распакованный tarball без установки зависимостей потребителя"
    }
  ]
}
```
