# fix-runner pfx r3 — стенд `kit-verify` и свежие схемы валидатора (G2/G3)

Раунд: `pfx-r3` (аудит pfx, закрытие coverage_gaps; кандидат `7b980c9`; правки кита — по явному решению владельца).
Пространство: основной чекаут `C:\project\ai\opencode-orchestrator-uni` (main, дерево на старте чистое), одиночный запуск — объект `workspace` в отчёте опущен.
Коммит: `476e9bdd103c5eb22962076751b5cf442e603267` (11 файлов, +232/−13). Не запушен.
Отчёт в коммит не включён: требование вызова — «один локальный коммит»; файл отчёта остаётся рабочим артефактом для root.

| id | статус | суть |
|---|---|---|
| G2 | **closed** | `validate_report` перечитывает `schemas/*.json` на каждом вызове; закрытая константа убрана, комментарий `registerAuditTools` исправлен; тест на подмену схемы без перезапуска |
| G3 | **closed** | поставлен `tools/kit-verify.ts` (комплект + `--proj`), script `verify:kit`, 6 md-носителей (ru/en) согласованы с фактическим стендом, `kit-sync` удалён |

Изменённые файлы:

- `lib/tools.ts:301-320,351` — `RegisterAuditToolsOptions` (тестовый шов `schemasDirectory`), свежая загрузка схем внутри executor'а, новый комментарий;
- `test/tools.test.ts:308-336` — тест `schema freshness` (подмена файла схемы во временном каталоге);
- `test/support/harness.ts:33-34,156-159` — проброс `schemasDirectory` в `registerAuditTools` (по умолчанию — штатный каталог, поведение плагина не меняется);
- `tools/kit-verify.ts` (новый, 169 строк) — стенд; `package.json:48` — script `verify:kit`;
- `agents/{ru,en}/fix-runner.md:28` (правило 9), `docs/{ru,en}/call-mechanics.md:126`, `docs/{ru,en}/root-runbook.md:29` — `kit-sync` убран, команда/порядок стенда согласованы.

## Доказательства (команда → вывод)

G2, механизм до правки и load-bearing тест (rollback-вариант: та же правка, но `const schemas = await loadSchemas(schemasDirectory)` на регистрации):

```
(rollback) bun test test/tools.test.ts -t "schema freshness"
  → (fail) schema freshness > a schema edited while the plugin is live is applied on the next validation
    received { valid: true, schema: "probe/v1", errors: [], warnings: [] }  ← схема при старте
    expected { valid: false, code: "E_INVALID" }                            ← подмена не видна
(после)    bun test test/tools.test.ts -t "schema freshness"  → 1 pass, 0 fail
```

G3, до/после:

```
git cat-file -e 7b980c9:tools/kit-verify.ts        → rc=128 (файла в базе нет)
grep -rn "kit-sync" agents docs                    → 6 совпадений (agents {ru,en}, docs {ru,en} ×2)
grep -rn "kit-sync" agents docs README.md README.ru.md package.json tools lib test → rc=1 (0 совпадений)
bun tools/kit-verify.ts                            → PASS locale-check / test / biome / tsc; kit-verify: 4/4 ok, rc=0
bun tools/kit-verify.ts --proj <temp-копия agents+docs> → 12/12 pairs ok, rc=0
bun tools/kit-verify.ts --proj <пустой каталог>    → kit-verify: no agents/** or docs/** locale pairs … rc=2
bun tools/kit-verify.ts --proj <копия с кириллицей в agents/en/arbiter.md> → 11/12 pairs ok, rc=1
```

Стандартные проверки после правок: `bun tools/locale-check.ts` → 12/12 ok; `npm test` → 92 pass / 0 fail (было 91); `npx biome check .` → rc=0; `bun run typecheck` → rc=0.

```json
{
  "schema": "fix-runner/v1",
  "round": "pfx-r3",
  "commit": "476e9bdd103c5eb22962076751b5cf442e603267",
  "results": [
    {
      "id": "G2",
      "status": "closed",
      "change": "lib/tools.ts:351 — схемы читаются заново в каждом вызове validate_report (`const schemas = await loadSchemas(schemasDirectory)`); закрытая константа из registerAuditTools:318 убрана, комментарий :307-313 больше не обещает «immutable state»; lib/tools.ts:301-305 — тестовый шов RegisterAuditToolsOptions.schemasDirectory (плагин вызывает без опций, поведение валидатора не изменилось); test/tools.test.ts:308-336 — тест подмены схемы во временном каталоге без перезапуска плагина; test/support/harness.ts:33-34,156-159 — проброс каталога схем",
      "before": "(rollback-вариант с закрытой константой) bun test test/tools.test.ts -t \"schema freshness\" → 1 fail: received {valid:true, schema:\"probe/v1\"} после подмены файла схемы, expected {valid:false, code:\"E_INVALID\"}",
      "after": "bun test test/tools.test.ts -t \"schema freshness\" → 1 pass, 0 fail; тот же harness-инстанс видит новое требование схемы ($.gate)",
      "proof": "rollback (const schemas на регистрации) → FAIL(1 fail, stale valid:true) / после → PASS(1 pass); полный набор: npm test → 92 pass / 0 fail",
      "stand": "baseline (7b980c9): tools/kit-verify.ts отсутствовал (git cat-file -e → rc=128), эквивалентные шаги вручную: locale-check 12/12 rc=0, bun test 91 pass rc=0, biome rc=0, tsc rc=0 → after: bun tools/kit-verify.ts → PASS locale-check (rc=0) / test (rc=0) / biome (rc=0) / tsc (rc=0), kit-verify: 4/4 ok, rc=0",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 92 pass / 0 fail; npx biome check . → rc=0; bun run typecheck → rc=0",
      "note": "Поведение валидатора не менялось: default-каталог схем прежний (SCHEMAS_DIRECTORY), коды/предупреждения те же; стоимость — чтение нескольких небольших JSON на вызов. Отклонение от буквы списка: для executor-уровневого теста добавлен необязательный параметр schemasDirectory (иначе подмена схем в живом плагине невоспроизводима без мутации поставки); альтернатива «только тест loadSchemas(directory)» отвергнута — она не доказывает свежесть на пути executor'а."
    },
    {
      "id": "G3",
      "status": "closed",
      "change": "tools/kit-verify.ts — новый стенд (bun/TS, без внешних зависимостей): режим комплекта `bun tools/kit-verify.ts` гоняет locale-check → bun test ./test/ → biome check . → tsc --noEmit локальными бинарниками node_modules/.bin (без сети), печатает `PASS/FAIL <step> (rc=N, Xs)` и `kit-verify: N/M ok`, rc=1 при провале; режим `--proj <dir>` сравнивает пары agents|docs/{ru,en}/*.md через pairIssues (как locale-check), тесты комплекта не запускает, rc=2 при отсутствии пар; shebang + usage. package.json:48 — script `verify:kit`. docs: agents/{ru,en}/fix-runner.md:28 (правило 9) — стенд `tools/kit-verify`, команда `bun tools/kit-verify.ts` / `bun <kit>/tools/kit-verify.ts --proj <каталог проекта>`, порядок baseline → правки → повторный kit-verify, `stand: unavailable: <почему>`; docs/{ru,en}/call-mechanics.md:126 и docs/{ru,en}/root-runbook.md:29 — «`tools/kit-verify` и `tools/kit-sync`» → «`tools/kit-verify`», «синк копий и повторный прогон» → «повторный прогон стенда»",
      "before": "git cat-file -e 7b980c9:tools/kit-verify.ts → rc=128 (fatal: path exists on disk, but not in HEAD — файла нет); bun tools/kit-verify.ts → нет такого файла; grep -rn kit-sync agents docs → 6 совпадений в 6 носителях; package.json → нет script verify:kit",
      "after": "bun tools/kit-verify.ts → PASS locale-check (rc=0, 0.1s) / PASS test (rc=0, 0.2s) / PASS biome (rc=0, 0.1s) / PASS tsc (rc=0, 1.7s); kit-verify: 4/4 ok, rc=0; bun tools/kit-verify.ts --proj <temp-копия agents+docs> → 12/12 pairs ok, rc=0; grep -rn kit-sync agents docs README.md README.ru.md package.json tools lib test → rc=1, 0 совпадений",
      "proof": "на базе стенда нет (git cat-file -e 7b980c9:tools/kit-verify.ts → rc=128) / после — есть и зелёный (4/4 ok, rc=0); провал стенда load-bearing: --proj на копии с кириллицей в agents/en/arbiter.md → 11/12 pairs ok, rc=1; пустой каталог → rc=2; оба md-носителя проверены bun tools/locale-check.ts → 12/12 ok",
      "stand": "baseline (7b980c9): стенда нет (rc=128), ручной эквивалент locale-check 12/12 + bun test 91 pass + biome rc=0 + tsc rc=0 → after: kit-verify: 4/4 ok, rc=0 (лог выше)",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 92 pass / 0 fail; npx biome check . → rc=0; bun run typecheck → rc=0",
      "note": "Вывод детерминирован по структуре (фиксированный порядок шагов/пар, сортировка имён, POSIX-метки в --proj); секунды в строке шага — по требованию формата. Windows: .cmd-шимы node_modules/.bin запускаются через shell, остальное — напрямую; абсолютных путей в аргументах нет (cwd = корень комплекта)."
    }
  ],
  "out_of_scope": [
    {
      "note": "test/support/locales.ts:3 — комментарий ссылается на `lab/locale-check.ts`, фактический инструмент — `tools/locale-check.ts`",
      "why_suspicious": "устаревшая ссылка в шапке контракта переводов; к G3 не относится (правился только набор файлов из списка), но вводит в заблуждение при следующем переносе инструментов"
    },
    {
      "note": "tsconfig.json include не содержит `tools/**/*.ts` — `tools/kit-verify.ts` не покрыт `tsc --noEmit` (в т.ч. шагом tsc самого стенда)",
      "why_suspicious": "новый поставляемый инструмент не проверяется типами, хотя это стандартный шаг стенда; расширение include меняет область typecheck и требует отдельного решения"
    },
    {
      "note": "README/README.ru не упоминают `verify:kit`/`tools/kit-verify`, хотя раньше fix-runner ссылался на README за командой запуска",
      "why_suspicious": "правило 9 теперь несёт команду само, но у пользователя комплекта нет точки входа в стенд из README — кандидат в следующий список"
    }
  ]
}
```
