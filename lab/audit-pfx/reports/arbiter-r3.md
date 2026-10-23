# Арбитр r3 — блокирующий статус F1/F2/F3 (ship-решение по 0.3.0)

Ревизия: `476e9bd`, aggregate `2290e3a95eb138202cabb8701b7b7f3a484cff60725d0e75ed4895805d6913e3` (96 файлов), HEAD совпал; в `git status` — только два lab-файла root'а. Читал: `empiric-r3.md`, `invariant-r3.md`, `summary-pfx.md`, `risks-pfx.md`, `agents/*/fix-runner.md`, `docs/*/{call-mechanics,root-runbook}.md`, `lib/tools.ts`, `tools/kit-verify.ts`, `package.json`, `tsconfig.json`, `schemas/arbiter.v1.json`. Прогоны — read-only; копии/пакет/скрипты — в `%TEMP%/opencode/arb-r3`, проектный каталог не менялся (только этот отчёт).

Спор: empiric — `ready` (T1/T2/T5 = MINOR/NIT); invariant — `not_ready` (0 MAJOR, «закрывающий минимум» F2/F3, F1 рекомендуется). Разбираю **только** блокирующий статус F1/F2/F3.

## Резюме

1. Все три пункта **воспроизведены моими прогонами**: F1 — сырое исключение вместо `E_*`; F2 — стенда нет в публикуемом пакете, ссылки в поставляемых доках и script `verify:kit` ведут в никуда; F3 — `tools/kit-verify.ts` объективно не проходит tsc, шаг tsc стенда не покрывает `tools/**`.
2. **Ни один не тянет MAJOR**: нет ложного «успеха», нет порчи целевого состояния. Картина отказа — деградация диагностики/покрытия, не поломка поставки. Доктрина (process-ready-loop:42; call-mechanics:147) для MINOR/NIT требует «закрыть **либо** явно принять с причиной», а не «закрыть обязательно» ⇒ «closing minimum» инварианта — обоснованная рекомендация, но **не ship-гейт**; гейт держат MAJOR, `closing_list`, `coverage_gaps`.
3. Часть подтезисов спора **опровергнута** (это и снижает severity):
   - F3 «работа держится на неявном свойстве Bun» — опция `shell` мёртвая: `Bun.spawn(["…/node_modules/.bin/biome.cmd","--version"], {shell:false})` и `{shell:true}` дают одинаковый `rc=0`, `Version: 2.5.15`. Правка — снять опцию (1 строка), не переписывать spawn.
   - F2 «каждый фиксер получит `stand: unavailable`» — в проектных раундах стенд по правилу 9 `fix-runner` не применим без явного включения в границы, формулировка доков условна («если в комплекте поставляется проверочный стенд»), fallback документирован. Ущерб уже: root, включивший стенд в границы, но работающий из установленного пакета.
   - Довод «это новый код, которым закрывали gaps» верен частично: F2 — предсуществующий паттерн упаковки (в том же tarball scripts `test` и `check:locales` тоже неисполнимы), новое только доковая ссылка и импорт `test/support/locales.ts:21`; F3 — предсуществующее исключение `tools/**` (старый `tools/locale-check.ts` тоже вне include), новое — первая реальная ошибка типов в этом классе.
4. **Ship-блокировки по severity нет ни у одного пункта.** Процедурно ship требует записи `accepted-risk (владелец)` по каждому (или правки) и, для F2, явной фиксации в `coverage_gaps`: «G3 закрыт для git-чекаута, не для npm-потребителя».

## F1 — сырые исключения при битых/недоступных схемах

Статус спора: **подтверждён** (MINOR). Стороны не расходятся в фактах — расходятся в блокирующем весе. Не блокирует.

Призма: `contract` + `falsification` (контроль «нет ложного valid»).

Проверка (мои прогоны, temp-каталог, шов `schemasDirectory` из `test/support/harness.ts`):

| Сценарий | Результат |
|---|---|
| `arbiter.v1.json` = `{ not json` | `THREW SyntaxError \| JSON Parse error: Expected '}'` |
| каталог схем отсутствует | `THREW Error \| ENOENT: no such file or directory, scandir '…\nope'` |
| файл не той формы (`{foo:1}`) | `THREW Error \| schemas/x.json: expected { id: string, schema: object }` |
| каталог схем пуст (схема удалена) | `{"valid":false,"code":"E_UNKNOWN_SCHEMA",…}` — **структурно** |
| штатные схемы | `{"valid":false,"code":"E_INVALID",…}` — нормальный отчёт |

Контракт нарушен по букве модуля: `lib/tools.ts` (шапка) — «Failures are typed (`E_*`) codes in the body rather than thrown tool errors, so an agent can branch on the code»; `lib/report-schema.ts:360` — «Never throws for malformed input»; описание инструмента перечисляет `E_INPUT|E_NO_JSON|E_PARSE|E_UNKNOWN_SCHEMA|E_SCHEMA_MISMATCH|E_INVALID|E_ABORTED`. `loadSchemas` бросает **намеренно** (комментарий в `lib/tools.ts:50-53`), но исполнитель (`lib/tools.ts:351`) это не конвертирует.

Регрессия по факту диффа: `git diff 7ab0d82..476e9bd -- lib/tools.ts` — `const schemas = await loadSchemas()` убран из регистрации и перенесён внутрь `validateReport`. То есть «fail-early потерян» — следствие этого изменения (цена закрытия M14/свежести схем), а не претензия к прежнему коду.

Фальсификация «ложного успеха»: ни в одном сценарии нет `valid:true` — fail-closed держится. Тестом путь отказа не покрыт (`grep -rn "malformed\|SyntaxError" test/` — только `parseLocaleTag`), т.е. находка законна, но её цена — качество диагностики и момент обнаружения, а не корректность вердиктов.

Почему не MAJOR: ущерб — стек вместо кода/пути у агента и позднее обнаружение порчи установки; отчёты при этом не валидируются ложно. Правка дешёвая: try/catch → `failure("E_SCHEMA_IO"…, {directory, file})` + тест на битый/отсутствующий каталог.

Для ship: **в риски-бэклог** (accepted-risk). Не блокирует.

## F2 — стенд не доезжает до потребителя пакета

Статус спора: **подтверждён** (MINOR). Invariant права в фактах, но «ship-decision»-вес завышен. Не блокирует при явной записи о сужении области G3.

Призма: `contract` + `falsification` (подтезис «каждый фиксер останется без стенда»).

Проверка (мои прогоны):

```
npm pack --dry-run --json → 39 файлов; записей 'tools/' = 0; записей 'test/' = 0
npm pack --pack-destination %TEMP% → tarball; npm i <tgz> в чистый temp-проект
ls node_modules/opencode-orchestrator-uni → LICENSE README.md README.ru.md agents docs index.ts lib package.json schemas
ls node_modules/…/tools → No such file or directory
cd node_modules/opencode-orchestrator-uni && npm run verify:kit
  > bun tools/kit-verify.ts
  error: Module not found "tools/kit-verify.ts"
grep -n "tools/kit-verify" docs/ru/call-mechanics.md   → :126 (файл входит в tarball)
grep -n "tools/kit-verify" agents/ru/fix-runner.md     → :28 (файл входит в tarball)
```

Плюс зависимость: `tools/kit-verify.ts:21` — `import { pairIssues } from "../test/support/locales"`, `test/` вне `files` ⇒ копирование `tools/` вручную не помогает (расчёт invariant подтверждаю).

Фальсификация подтезиса: в том же установленном пакете **предсуществующие** scripts тоже неисполнимы — `npm test` → `Test filter "./test/" had no matches`, `npm run check:locales` → `Module not found "tools/locale-check.ts"`. Значит «битый script в tarball» — не новый класс, введённый `476e9bd`; новое — (а) доковая фраза «`tools/kit-verify` каталога комплекта», (б) импорт из `test/`. Формулировка доков условна, `fix-runner.md:28` ограничивает применимость («когда объект аудита — сам комплект… иначе `stand: unavailable`»), fallback документирован. Конкретный ущерб: root, работающий из npm-пакета и включивший стенд в границы, получит no-op вместо проверки. При этом G3 (gap «стенд отсутствует») закрыт по существу: стенд существует и работает в чекауте — `bun tools/kit-verify.ts` → `4/4 ok`, rc=0 (мой прогон).

Почему не MAJOR: ни одного ложного «зелёного», ни порчи данных/репозитория; штатный путь отказа (`stand: unavailable` + собственные проверки) предписан и безопасен. Правка дешёвая: `files += "tools"` + перенос `pairIssues` в поставляемый `lib/`, либо явное сужение «каталог комплекта = git-чекаут» в 3 носителях ×2 локали.

Для ship: **в риски-бэклог** + обязательная строка в `coverage_gaps`/`risks-pfx.md`: «G3 закрыт для чекаута; для npm-потребителя стенд недоступен (MINOR, принято)». Не блокирует.

## F3 — стенд не типизирует сам себя; `shell` не проходит tsc

Статус спора: **подтверждён** (MINOR), один подтезис опровергнут. Не блокирует.

Призма: `reproducibility` + `contract`.

Проверка (мои прогоны):

```
npx tsc --noEmit --listFiles | grep -c 'tools/'          → 0        (tools/** вне include)
npx tsc --noEmit … --strict tools/kit-verify.ts          → tools/kit-verify.ts(56,5):
                                                            error TS2353 … 'shell' does not exist in type
                                                            'SpawnOptions<"ignore","pipe","pipe">' ; rc=2
temp tsconfig: include = tools/**/*.ts + typeRoots проекта → тот же TS2353, rc=2  («починка include» красит CI)
npx tsc --noEmit  (поставка)                             → rc=0 (зелено)
bun tools/kit-verify.ts                                  → PASS ×4, 4/4 ok, rc=0 (рантайм цел)
npx tsc --noEmit … tools/locale-check.ts (старый файл)   → rc=0 (контроль)
```

Контроль важен для атрибуции: `tools/locale-check.ts` вне include, но типы проходит ⇒ само исключение `tools/**` было безобидным, а первую реальную ошибку типов вносит новый файл. Отсюда «ложное покрытие» — верно: шаг `tsc` стенда и `npm run typecheck` печатают зелёное, не проверяя 169-строчный инструмент, которым закрывают гейт.

Опровергнутый подтезис: «опция `shell` не входит в типизированный API — держится на неявном свойстве Bun». Замер: `Bun.spawn(["C:/…/node_modules/.bin/biome.cmd","--version"], {shell:false})` → `rc=0`, `Version: 2.5.15`; с `{shell:true}` — тот же вывод. Bun запускает `.cmd` сам, опция ни на что не влияет ⇒ мёртвый код, а не скрытая зависимость. Следствие для правки: достаточно удалить `shell: needsShell(...)` и хелпер `needsShell`; переписывать spawn на `cmd /c` не требуется.

Почему не MAJOR: рантайм работает, ложного вердикта о поведении нет; цена — невидимость будущих ошибок типов в `tools/**` и ловушка «включил include — покраснел CI». Это дефект покрытия, а не поставки.

Для ship: **в риски-бэклог** (править парой: снять `shell` + добавить `tools/**/*.ts` в include; иначе include трогать нельзя). Не блокирует.

## Итог для ship-условия

- `severity`: F1 = MINOR, F2 = MINOR, F3 = MINOR. Открытых MAJOR нет (согласен с обеими сторонами).
- Блокирует до правки: **нет ни одного**. Все три — в риски-бэклог с записью `accepted-risk` (F2 — плюс явное сужение области закрытия G3 в `coverage_gaps`).
- Вердикт `not_ready` стороны invariant **не опровергнут как позиция роли** (роль вправе не давать ready на открытых MINOR), но его «закрывающий минимум» не является ship-гейтом: доктрина допускает явное принятие MINOR с причиной. Расхождение снимается записью в реестре рисков, а не обязательной правкой. Если владелец не хочет накапливать долг в новом механизме — все три правки стоят ~5 строк кода и одну строку доков.
- Рекомендация root'у: строки R18–R20 в `risks-pfx.md` (F1 — бэклог с тестом; F2 — сужение «каталог комплекта = чекаут» либо `files += tools`; F3 — парная правка типов + include), затем мета-гейт.

```json
{
  "schema": "arbiter/v1",
  "verdict": "resolved",
  "disputes": [
    {
      "id": "F1",
      "item": "Битый/отсутствующий schemas/*.json даёт сырое исключение (SyntaxError/ENOENT) вместо структурного E_*, fail-early на старте потерян. empiric (T5): NIT/MINOR, не блокирует. invariant (F1): MINOR, рекомендуется закрыть. Спор — о блокирующем статусе.",
      "verdict": "confirmed",
      "prism": ["contract", "falsification"],
      "severity": "MINOR",
      "blocking": false,
      "blocking_status": "в риски-бэклог (accepted-risk владельцем), не блокирует ship",
      "method": "Воспроизведение через шов schemasDirectory (test/support/harness.ts) в %TEMP%: T1 schemas/arbiter.v1.json = '{ not json'; T2 каталог схем отсутствует; T3 файл формы {foo:1}; T4 каталог схем пуст; T5 штатные схемы. Сверка контракта: lib/tools.ts (шапка, 50-53, 351), lib/report-schema.ts:360, git diff 7ab0d82..476e9bd -- lib/tools.ts, grep тестов на путь отказа.",
      "evidence": "T1: THREW SyntaxError 'JSON Parse error: Expected }'. T2: THREW Error 'ENOENT: no such file or directory, scandir …\nope'. T3: THREW Error 'schemas/x.json: expected { id: string, schema: object }'. T4: {\"valid\":false,\"code\":\"E_UNKNOWN_SCHEMA\",…} — структурно. T5: {\"valid\":false,\"code\":\"E_INVALID\",…}. Диффом loadSchemas перенесён из регистрации внутрь validateReport (−const schemas = await loadSchemas() / +const schemas = await loadSchemas(schemasDirectory)) ⇒ потеря fail-early введена этим изменением. Ложного valid:true нет ни в одном сценарии; теста на путь отказа нет (grep 'SyntaxError|malformed' в test/ — только parseLocaleTag)."
    },
    {
      "id": "F2",
      "item": "Стенд не попадает в публикуемый пакет (files без tools/ и test/), при этом поставляемые docs/*/call-mechanics.md:126 и agents/*/fix-runner.md:28 ссылаются на tools/kit-verify, а поставляемый package.json содержит script verify:kit. empiric (T2): MINOR, не блокирует. invariant (F2): MINOR, closing minimum до ship.",
      "verdict": "confirmed",
      "prism": ["contract", "falsification"],
      "severity": "MINOR",
      "blocking": false,
      "blocking_status": "в риски-бэклог + обязательная запись в coverage_gaps «G3 закрыт для чекаута, не для npm»; не блокирует ship",
      "method": "npm pack --dry-run --json; затем npm pack --pack-destination %TEMP% и npm i <tgz> в чистый temp-проект; в установленном пакете: ls tools, npm run verify:kit, grep ссылок в поставляемых docs/agents; контрольные npm test и npm run check:locales для атрибуции новизны; контроль работоспособности стенда в чекауте.",
      "evidence": "dry-run: total files 39, 'tools/' = 0, 'test/' = 0 (files: index.ts, lib, schemas, agents, docs, README.md, README.ru.md, LICENSE). В установленном пакете: каталога tools нет; 'npm run verify:kit' → 'error: Module not found \"tools/kit-verify.ts\"'; docs/ru/call-mechanics.md:126 и agents/ru/fix-runner.md:28 (поставляются) обещают 'tools/kit-verify каталога комплекта'; tools/kit-verify.ts:21 импортирует ../test/support/locales (test/ вне files). Фальсификация новизны: в том же tarball 'npm test' → 'Test filter \"./test/\" had no matches', 'npm run check:locales' → 'Module not found \"tools/locale-check.ts\"' ⇒ паттерн упаковки предшествует ревизии; новое — доковая ссылка и импорт из test/. Стенд в чекауте: bun tools/kit-verify.ts → 4/4 ok, rc=0."
    },
    {
      "id": "F3",
      "item": "tools/kit-verify.ts объективно не проходит tsc (TS2353: 'shell' не в SpawnOptions); tools/** вне tsconfig.include ⇒ шаг tsc стенда и npm run typecheck дают ложное покрытие. empiric (T1): MINOR (фикс). invariant (F3): MINOR, closing minimum до ship.",
      "verdict": "confirmed",
      "prism": ["reproducibility", "contract"],
      "severity": "MINOR",
      "blocking": false,
      "blocking_status": "в риски-бэклог (править парой: снять shell + добавить tools/** в include); не блокирует ship",
      "method": "npx tsc --noEmit --listFiles | grep -c tools/; прямой прогон tsc по tools/kit-verify.ts; temp-tsconfig с include=tools/**/*.ts и typeRoots проекта (проверка «починка include красит CI»); контроль tools/locale-check.ts; поставка: npx tsc --noEmit и bun tools/kit-verify.ts; замер мёртвости опции shell (Bun.spawn biome.cmd --version с shell:false и shell:true).",
      "evidence": "tsc --listFiles: 0 файлов tools/. Прямой прогон: 'tools/kit-verify.ts(56,5): error TS2353: … shell does not exist in type SpawnOptions<\"ignore\",\"pipe\",\"pipe\">', rc=2; temp-tsconfig с include tools/** — тот же TS2353, rc=2. Поставка: npx tsc --noEmit rc=0; bun tools/kit-verify.ts → PASS locale-check/test/biome/tsc, 'kit-verify: 4/4 ok', rc=0. Контроль: tools/locale-check.ts (тоже вне include, старый) → rc=0 ⇒ реальная ошибка типов внесена новым файлом. Фальсификация подтезиса о неявном свойстве Bun: shell=false rc=0 'Version: 2.5.15' и shell=true rc=0 'Version: 2.5.15' — идентично, опция не влияет ⇒ мёртвый код, правка = удалить опцию и needsShell."
    }
  ],
  "not_verified": [
    {
      "item": "TOCTOU на полузаписанной схеме в реальном параллельном сценарии",
      "why": "Воспроизводил ручную порчу и отсутствие файла схемы; гонку с одновременной записью не организовывал — механизм fail-closed от этого не меняется (битый JSON всегда даёт исключение, ложного valid не возникает)."
    },
    {
      "item": "Поведение установленного пакета у реального npm-потребителя 0.3.0",
      "why": "Ревизия не опубликована (registry latest 0.2.1, package.json = 0.1.0); проверял локальный tarball из 476e9bd — эквивалент поставляемого содержимого, но не публикацию."
    },
    {
      "item": "G1/G4 (живой эксперимент, session_move, 4 LLM-сессии) и F4-F7",
      "why": "Вне мандата: разбираю только блокирующий статус F1/F2/F3; G1/G4 требуют depth-limit субагентов, F4-F7 не спорны (обе стороны согласны)."
    }
  ]
}
```
