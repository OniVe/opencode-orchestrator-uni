# fix-runner r5 — правки по списку (pfx, пара r4, кандидат 816cffa)

Окружение: основной чекаут `C:/project/ai/opencode-orchestrator-uni`, ветка `main`, base `816cffa18069e105b8a2f753aafd29ffbc5b6550` (по границам вызова — одиночный запуск в основном чекауте, отдельный worktree не создавался).
Коммит: `2f5c5817f9ffff68d43cab2e8bfde6b2db1a4709` — `fix: repair the stand note in normative docs and README codes` (6 файлов, +10/−4). Не запушено.
Чужие незакоммиченные изменения (`lab/audit-pfx/reports/summary-pfx.md`, `lab/audit-pfx/risks-pfx.md`) не тронуты и в коммит не попали.

## Резюме

- **G1/R1 — closed.** Оговорка про npm/`stand: unavailable` вынесена отдельным предложением ПОСЛЕ закрывающей скобки в 4 носителях; внутри скобки остались определение стенда и условие «в раундах по другим проектам — только если стенд явно включён в границы вызова»; порядок baseline → правки → повторный прогон сохранён. `agents/{ru,en}/fix-runner.md:28` не тронут (уже корректен), стиль нового предложения совпадает с ним.
- **R2/G2 — closed.** В таблицу кодов `validate_report` обеих README добавлена строка `E_SCHEMA_IO` (между `E_INVALID` и `E_ABORTED` — в порядке enum из описания инструмента, `lib/tools.ts:558`); поля `directory`/`file` — по факту реализации (`lib/tools.ts:406-414`: `directory` всегда, `file` только для конкретного файла). Выравнивание колонок сохранено (позиции `|`: EN 0/22/89, RU 0/22/93 — как у соседних строк).
- **G3 — closed.** В раздел «Development/Разработка» после блока скриптов добавлена одна фраза в каждой локали: команды требуют git-чекаута, в npm-пакете `tools/` нет → `stand: unavailable` и собственные проверки.

Отклонений от рекомендованного механизма нет. Статусов `needs_decision`/`not_closed`/`budget_exceeded` нет.

## before/after/proof

| id | before | after | proof |
|---|---|---|---|
| G1/R1 | `git grep -c -E '; Стенд поставляется\|; The stand is shipped' 816cffa -- docs` → 4 файла (`docs/{ru,en}/call-mechanics.md`, `docs/{ru,en}/root-runbook.md`), по 1 на файл; фраза разорвана: «…каталога комплекта; Стенд поставляется … проверки. в раундах …» | тот же grep по рабочему дереву → 0 совпадений, rc=1; фраза: «… каталога комплекта; в раундах по другим проектам — только если стенд явно включён в границы вызова): baseline → … (поле `stand`). Стенд поставляется в git-чекауте комплекта: … `stand: unavailable` и собственные воспроизводимые проверки.» | критерий «0 совпадений» на базе FAIL (4), после PASS (0) — правка load-bearing |
| R2/G2 | `git grep -c 'E_SCHEMA_IO' 816cffa -- README.md README.ru.md` → rc=1, совпадений 0 | `git grep -c 'E_SCHEMA_IO' -- README.md README.ru.md` → `README.md:1`, `README.ru.md:1`, rc=0 | критерий «по 1» на базе FAIL (rc=1/0 совпадений), после PASS |
| G3 | `npm pack --dry-run` → 39 файлов, `tools/` 0; README (обе локали) документируют `check:locales`/`verify:kit` без оговорки | добавлена одна фраза: README.md:310, README.ru.md:317 (`git grep -n 'stand: unavailable' README.md README.ru.md` → по 1 строке) | наличие оговорки проверяется grep'ом: на базе 0 совпадений (FAIL), после по 1 (PASS) |

## Стенд и проверки

- `bun tools/kit-verify.ts`: baseline `4/4 ok` rc=0 → after `4/4 ok` rc=0 (`PASS locale-check / test / biome / tsc`).
- `bun tools/locale-check.ts` → `12/12 ok` rc=0 (ru/en пары, включая оба `docs` и обе README-локали).
- `npm test` → `93 pass / 0 fail / 770 expect`, rc=0.
- `npx biome check .` → `Checked 34 files. No fixes applied.` rc=0.
- `bun run typecheck` → rc=0.
- Структура md не изменилась: заголовки/фенсы `call-mechanics` 22/20, `root-runbook` 7/2 — совпадают с `816cffa`; добавленные в EN строки — только ASCII (по диффу `git diff -U0 -- docs/en README.md`).

## Замечено вне списка (не правило)

- `package.json` (поставляется в пакете) по-прежнему объявляет `verify:kit`/`check:locales` → `bun tools/*.ts`, которых в npm-пакете нет (`npm pack --dry-run`: 39 файлов, `tools/` 0). Список выбрал вариант «оговорка в README» (G3), вариант «исключить скрипты из публикуемого package.json» не реализован — остаётся расхождение артефакта и документации.
- Генерическая фраза README.md:60 / README.ru.md:62 «(`E_INPUT`, `E_NO_JSON`, …)» перечисление не расширяет — не дефект, оставлено.

```json
{
  "schema": "fix-runner/v1",
  "round": "pfx-r5",
  "commit": "2f5c5817f9ffff68d43cab2e8bfde6b2db1a4709",
  "results": [
    {
      "id": "G1/R1",
      "status": "closed",
      "change": "docs/ru/call-mechanics.md:126, docs/en/call-mechanics.md:126, docs/ru/root-runbook.md:29, docs/en/root-runbook.md:29 — оговорка npm/`stand: unavailable` вынесена отдельным предложением после закрывающей скобки; внутри скобки остались определение стенда и условие «в раундах по другим проектам — только если стенд явно включён в границы вызова»; порядок baseline → правки → повторный прогон сохранён; agents/{ru,en}/fix-runner.md:28 не менялся",
      "before": "git grep -c -E '; Стенд поставляется|; The stand is shipped' 816cffa -- docs → 4 файла (call-mechanics ru/en, root-runbook ru/en), по 1 совпадению; фраза разорвана: «…каталога комплекта; Стенд поставляется … проверки. в раундах по другим проектам — только если…»",
      "after": "git grep -n -E '; Стенд поставляется|; The stand is shipped' -- docs → 0 совпадений, rc=1; фраза: «…каталога комплекта; в раундах по другим проектам — только если стенд явно включён в границы вызова): baseline → … (поле `stand`). Стенд поставляется в git-чекауте комплекта: … → `stand: unavailable` и собственные воспроизводимые проверки.» (EN зеркально)",
      "proof": "git grep -c -E '; Стенд поставляется|; The stand is shipped' 816cffa -- docs → 4 (FAIL критерия «0») / git grep -n -E '…' -- docs → rc=1, 0 совпадений (PASS)",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0",
      "tests": "bun tools/locale-check.ts → 12/12 ok rc=0; npm test → 93 pass/0 fail/770 expect rc=0; npx biome check . → 34 files, no fixes, rc=0; bun run typecheck → rc=0",
      "note": "Структура md сохранена: заголовки/фенсы call-mechanics 22/20, root-runbook 7/2 — как в 816cffa; EN-добавки только ASCII; стиль нового предложения согласован с agents/{ru,en}/fix-runner.md:28."
    },
    {
      "id": "R2/G2",
      "status": "closed",
      "change": "README.md:91, README.ru.md:92 — в таблицу кодов validate_report добавлена строка `E_SCHEMA_IO` («схемы комплекта недоступны/битые, см. `directory`, `file`»), между `E_INVALID` и `E_ABORTED` — в порядке enum описания инструмента (lib/tools.ts:558)",
      "before": "git grep -c 'E_SCHEMA_IO' 816cffa -- README.md README.ru.md → rc=1, 0 совпадений (таблица из 7 кодов без E_SCHEMA_IO)",
      "after": "git grep -c 'E_SCHEMA_IO' -- README.md README.ru.md → README.md:1, README.ru.md:1, rc=0",
      "proof": "критерий «по 1 в каждой локали»: на базе FAIL (rc=1, 0), после PASS (1/1)",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0",
      "tests": "npx biome check . → rc=0 (34 files); bun tools/locale-check.ts → 12/12 ok; npm test → 93 pass/0 fail",
      "note": "Поля сверены с реализацией: lib/tools.ts:406-414 — `directory` всегда, `file` только при отказе конкретного файла. Выравнивание таблицы сохранено: позиции '|' в новой строке — EN 0/22/89, RU 0/22/93 (как у соседних строк), ширина колонок не менялась."
    },
    {
      "id": "G3",
      "status": "closed",
      "change": "README.md:310, README.ru.md:317 — одна фраза после блока скриптов: команды требуют git-чекаута комплекта; в npm-пакете каталога `tools/` нет, поэтому в установленном пакете — `stand: unavailable` и собственные воспроизводимые проверки",
      "before": "npm pack --dry-run → 39 файлов, 'tools/' 0 совпадений; README (обе локали) документируют `check:locales`/`verify:kit` без оговорки (git grep -n 'stand: unavailable' README.md README.ru.md → 0)",
      "after": "git grep -n 'stand: unavailable' README.md README.ru.md → README.md:310, README.ru.md:317",
      "proof": "наличие оговорки: на базе 0 совпадений (FAIL), после по 1 в каждой локали (PASS); факт «в npm-пакете нет tools/» подтверждён npm pack --dry-run (39 файлов, 0 tools/)",
      "stand": "baseline 4/4 ok rc=0 → after 4/4 ok rc=0",
      "tests": "npx biome check . → rc=0; bun tools/locale-check.ts → 12/12 ok (ru/en зеркальность README в порядке); npm test → 93 pass/0 fail",
      "note": "Формулировка зеркальна agents/{ru,en}/fix-runner.md:28. Отклонение: вторая опция списка («исключить скрипты из публикуемого package.json») не реализована — выбран вариант «оговорка в README»."
    }
  ],
  "out_of_scope": [
    {
      "note": "package.json (поставляется в npm-пакете) объявляет verify:kit/check:locales → bun tools/*.ts, которых в пакете нет (npm pack --dry-run: 39 файлов, tools/ 0)",
      "why_suspicious": "Документация теперь предупреждает, но сами скрипты в установленном пакете падают с ENOENT — остаточное расхождение артефакт↔документация; вариант «исключить скрипты из публикуемого package.json» не входил в выбранный механизм списка"
    },
    {
      "note": "README.md:60 / README.ru.md:62 — генерическое перечисление «(`E_INPUT`, `E_NO_JSON`, …)» не расширено на E_SCHEMA_IO",
      "why_suspicious": "Список требовал только строку таблицы; перечисление с многоточием не является контрактом кодов"
    }
  ]
}
```
