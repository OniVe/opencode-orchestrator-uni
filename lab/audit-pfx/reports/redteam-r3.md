# Red-team pfx (r3) — приёмка кандидата ae6b9e4

Ревизия: ae6b9e4 (дерево: изменения только в lab/, исключён из снапшота). Aggregate: пересчитан orch_uni_snapshot · 96 файлов · 53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed — совпало с заявкой.
Дифф раунда 7ab0d82..ae6b9e4: lib/tools.ts (+114), tools/kit-verify.ts (новый, 198), tools/locale-check.ts (+25), test/tools.test.ts (+62), test/support/*, package.json (+1 script), tsconfig.json, 8 md (README ×2, agents/{ru,en}/fix-runner.md, docs/{ru,en}/{call-mechanics,root-runbook}.md).

## Резюме

Все четыре заявленных закрытия воспроизведены: (1) живой инструмент валидации перечитывает схемы — отчёт без workspace.base_commit теперь отвергается живым orch_uni_validate_report, чего в r2 не было; (2) E_SCHEMA_IO типизирован (directory + file) для отсутствующего каталога, битого JSON и неверной формы документа, а мутация «кэшировать схемы» валит ровно два теста (freshness и typed refusal) — guard load-bearing, в отличие от прозаических guard'ов r1/r2; (3) kit-verify в kit-режиме 4/4 rc=0, в --proj — rc=0/1/2 по контракту, вывод байт-идентичен между прогонами, .cmd-шаги на Windows идут через ComSpec; (4) docs ↔ артефакт согласованы: script verify:kit, 6 md-носителей + оба README называют kit-verify и оговорку про npm; kit-sync — 0 упоминаний. Git-часть live-experiment воспроизведена по факту (4 ветки, 4 коммита, цепочка merge до 39a1466, чистый статус, probe-файлы на месте).

Регрессии: bun test 93/93, locale-check 12/12, biome 34 файла / 0, tsc rc=0, kit-verify 4/4 rc=0. Правила hex-гейта и not_consolidated не тронуты (в дельте md-правки — по одной строке на носитель, стенд-оговорка).

Блокирующих дефектов нет. Открытые NIT: диагностика --proj для пути-файла; дубликаты id схем перезаписываются молча; сохранённые с r2 MINOR S1/S2 (схема допускает commit null/короткий/uppercase; привязка SHA к ветке — прозой).

## Эксперименты (команда → вывод)

1. Свежесть и живой инструмент: orch_uni_validate_report на крафтовых отчётах fix-runner/v1 → без workspace: valid=true (workspace не в required); workspace без base_commit: E_INVALID «$.workspace.base_commit: required field is missing» (в r2 тот же вход был valid=true — кэш побеждён); out_of_scope отсутствует: E_INVALID; неизвестная схема: E_UNKNOWN_SCHEMA.
2. E_SCHEMA_IO (прямой вызов loadSchemas из lib/tools.ts на temp-каталогах): нет каталога → SchemaIoError E_SCHEMA_IO dir=missing file=none; битый JSON → E_SCHEMA_IO с file=a.json; {id:5, schema:{}} → E_SCHEMA_IO с file=a.json.
3. Свежесть как механизм: два loadSchemas подряд с правкой файла между ними → первая загрузка даёт «$.k expected string, got number», вторая (после добавления required n) — «$.n required field is missing»; новая редакция схемы применяется без перезапуска.
4. Load-bearing мутация (копия в temp): в loadSchemas добавлен модульный кэш → bun test: (fail) schema freshness «a schema edited while the plugin is live is applied on the next validation», (fail) schema registry failures «a broken or missing schemas directory is a typed refusal, not a throw»; 91 pass / 2 fail (всего 93) — тесты действительно держат свойство.
5. kit-verify kit-режим: PASS locale-check / test / biome / tsc, «kit-verify: 4/4 ok», rc=0; два прогона подряд → cmp: вывод байт-идентичен (без таймингов).
6. kit-verify --proj: good (одна пара) → rc=0 «1/1 pairs ok»; EN-сирота docs/en/b.md → rc=1 «orphan translation: no docs/ru/b.md»; ru без en → rc=1 «missing translation file»; пустой каталог → rc=2 «no pairs»; путь-файл → rc=2; --proj без аргумента, с лишним аргументом, с пустым → usage, rc=2.
7. Спавн на Windows: шаги biome/tsc — это node_modules/.bin/*.cmd, прошли через ComSpec (PASS, rc=0); kit-режим не падает на shim-скриптах.
8. docs ↔ артефакт: package.json:48 «verify:kit»: bun tools/kit-verify.ts; kit-verify упомянут в agents/{ru,en}/fix-runner.md, docs/{ru,en}/{call-mechanics,root-runbook}.md, README.md, README.ru.md; kit-sync — 0 вхождений в agents/docs/README; во всех 6 носителях и обоих README — «в npm-пакете каталога tools/ нет → stand: unavailable».
9. Live-experiment (git-часть): клон %TEMP%/opencode/pfx-live/repo существует; git log → 39a1466 merge 8c65044, 30cae80 merge 577f33f, 0fc4dae merge 3b94c91, a5ad80a fix probe 1; cat-file -t всех четырёх SHA = commit; worktree list → wt1..wt4 на fix/live-1..4 с ожидаемыми коммитами; в дереве probe-1..4.txt, git status пуст.
10. Регрессии: bun test 93 pass / 0 fail; locale-check 12/12; biome 34 файла, 0; tsc --noEmit rc=0; kit-verify 4/4.

## Вывод по заявке

- Свежесть схем + E_SCHEMA_IO — подтверждено, guard держит (мутация ловится).
- kit-verify (kit/--proj, негативы, EN-сироты, детерминизм, спавн) — подтверждено.
- docs ↔ артефакт, удаление kit-sync, verify:kit, npm-оговорка — подтверждено на тексте; поведение установленного npm-пакета не исполнялось (coverage gap).
- Live-experiment: git-часть воспроизведена; session-часть (4 session_move, preflight в живых сессиях) — по артефактам root'а, из этой сессии не перепроверяема.
- Регрессии — подтверждено.

```json
{
  "schema": "redteam/v1",
  "verdict": "ready",
  "closing_list": [],
  "coverage_gaps": [
    "Session-часть live-experiment (4 реальные сессии fix-runner, session_move 4/4, preflight в них) не перепроверяема из этой сессии: родительские сессии недоступны, вложенные субагенты запрещены (depth limit 1). Проверена только git-часть по артефактам клона.",
    "Поведение установленного npm-пакета (tools/ отсутствует → stand: unavailable) не исполнялось: проверена только текстовая оговорка в 6 носителях и README; npm pack/install не запускался.",
    "Другие версии git/OpenCode (gap 5) не тестировались: экспериментальная база — текущие версии среды.",
    "Инструмент харнесса worktree_create по-прежнему не вызывался: он создаёт worktree в аудируемом репозитории (мутация запрещена).",
    "Частота прерываний фиксера (gap 7) и фактическое срабатывание N4-stash (gap 6): нет исторических логов, статистики не существует."
  ],
  "claims_attacked": [
    {
      "claim": "G2/G3: lib/tools.ts перечитывает schemas/*.json на каждом validate_report; при сбое — структурный E_SCHEMA_IO (directory/file); тесты freshness/typed refusal load-bearing",
      "attack": "живой orch_uni_validate_report на крафтовых отчётах (workspace отсутствует/неполный/строкой); прямой вызов loadSchemas на temp-каталогах (нет каталога, битый JSON, неверная форма); две загрузки с правкой схемы между ними; мутация «кэшировать схемы» в копии",
      "outcome": "claim_confirmed",
      "evidence": "Живой инструмент: workspace без base_commit → E_INVALID «$.workspace.base_commit: required field is missing» (в r2 тот же вход — valid=true); E_SCHEMA_IO: dir=missing file=none / file=a.json (битый JSON и {id:5}) / file=a.json (форма); свежесть: первая загрузка «$.k expected string, got number», вторая после правки — «$.n required field is missing»; мутация кэша: (fail) schema freshness, (fail) schema registry failures — 91 pass / 2 fail"
    },
    {
      "claim": "kit-verify: kit-режим (locale-check → test → biome → tsc, 4/4, rc=0), --proj (пары + EN-сироты, rc=0/1/2), детерминированный вывод, ComSpec-спавн на Windows",
      "attack": "прогон kit-режима дважды и cmp; --proj на good/orphan/missing/empty/путь-файл/без аргумента/лишний аргумент/пустой аргумент",
      "outcome": "claim_confirmed",
      "evidence": "kit: PASS×4, «kit-verify: 4/4 ok», rc=0, два прогона byte-identical (cmp пуст); --proj good rc=0 «1/1 pairs ok»; orphan rc=1 «orphan translation: no docs/ru/b.md»; missing rc=1 «missing translation file»; empty rc=2 «no pairs»; путь-файл rc=2; usage-варианты rc=2; biome/tsc — .cmd-шимы прошли через ComSpec (PASS rc=0)"
    },
    {
      "claim": "docs ↔ артефакт: verify:kit script, kit-verify в 6 md-носителях, kit-sync удалён, npm-оговорка в 6 носителях + README (F2/R19)",
      "attack": "grep по package.json/agents/docs/README; подсчёт упоминаний kit-sync; поиск формулировки stand: unavailable",
      "outcome": "claim_confirmed",
      "evidence": "package.json:48 verify:kit = bun tools/kit-verify.ts; kit-verify в agents/{ru,en}/fix-runner.md, docs/{ru,en}/{call-mechanics,root-runbook}.md, README.md, README.ru.md; kit-sync — 0 вхождений; в 6 носителях «в npm-пакете каталога tools/ нет → stand: unavailable», README.md:310 и README.ru.md:317 — та же оговорка"
    },
    {
      "claim": "Live-experiment: 4 сессии в отдельных worktree, сведение по SHA (git-часть)",
      "attack": "проверка клона %TEMP%/opencode/pfx-live/repo: log, cat-file -t по четырём SHA, worktree list, статус, наличие probe-файлов",
      "outcome": "claim_confirmed",
      "evidence": "git log: 39a1466 merge 8c65044, 30cae80 merge 577f33f, 0fc4dae merge 3b94c91, a5ad80a fix probe 1; cat-file -t: a5ad80a2/3b94c912/577f33fe/8c650442 = commit; worktree list: wt1..wt4 на fix/live-1..4 с этими коммитами; probe-1..4.txt в дереве; git status --porcelain пуст. Session-часть — coverage_gaps"
    },
    {
      "claim": "Регрессии: 93/93, 12/12, biome 0, tsc 0, kit-verify 4/4",
      "attack": "прогон всех пяти проверок на ae6b9e4",
      "outcome": "claim_confirmed",
      "evidence": "bun test ./test/ → 93 pass 0 fail; bun tools/locale-check.ts → 12/12 ok; biome → 34 файла, 0; tsc --noEmit → rc=0; bun tools/kit-verify.ts → 4/4 ok rc=0"
    },
    {
      "claim": "Правила сведения (hex-гейт, not_consolidated, префикс-проверка) не ослаблены в дельте",
      "attack": "дифф md в 7ab0d82..ae6b9e4; grep несущих токенов",
      "outcome": "claim_confirmed",
      "evidence": "md-дифф: 8 файлов по 1-2 строки (стенд-оговорка, npm-каталог); 0-9a-f]{40} присутствует в agents/ru/orchestrator.md, docs/ru/call-mechanics.md, docs/ru/root-runbook.md; not_consolidated — в call-mechanics и root-runbook (ru); схемы fix-runner.v1.json в дельте не менялись"
    }
  ],
  "findings": [
    {
      "id": "T1",
      "severity": "NIT",
      "location": "tools/kit-verify.ts:183 (runProjectStand)",
      "mechanism": "Если --proj указывает на обычный файл, каталоги agents/ и docs/ не читаются, и диагностика сообщает «no agents/** or docs/** locale pairs under <файл>» с rc=2 — причина (путь не каталог) не названа. Fail-closed, но сообщение уводит в сторону.",
      "evidence": "bun tools/kit-verify.ts --proj <путь-файл> → rc=2, «kit-verify: no agents/** or docs/** locale pairs under C:/…/proj/afile» (файл, не каталог).",
      "fix": "Проверять stat каталога до обхода: не каталог → отдельная диагностика и rc=2 (или rc=1) с явным «not a directory»."
    },
    {
      "id": "T2",
      "severity": "NIT",
      "location": "lib/tools.ts:118 (loadSchemas)",
      "mechanism": "Реестр схем строится schemas.set(id, …) в отсортированном порядке имён: два файла с одинаковым id молча перезаписывают друг друга (побеждает последний по алфавиту). Это единственный вид порчи реестра, который не даёт E_SCHEMA_IO, хотя остальные (нет каталога/битый JSON/неверная форма) типизированы — «fail-closed registry» неполон.",
      "evidence": "Текст lib/tools.ts:118 — schemas.set(id, schema as JsonSchemaNode) без проверки has(id); поведение воспроизводимо в temp: два файла a.json и z.json с id x/v1 → Map содержит одну запись, ошибки нет.",
      "fix": "Перед set проверять has(id) и бросать SchemaIoError с обоими именами файлов — реестр должен отказывать, а не выбирать победителя."
    },
    {
      "id": "T3",
      "severity": "MINOR",
      "location": "schemas/fix-runner.v1.json:9; docs/{ru,en}/call-mechanics.md:115",
      "mechanism": "Схема по-прежнему допускает commit: null, короткий и uppercase SHA для closed, а привязка SHA к ветке фиксера остаётся только прозой (S1/S2 из r2). Валидатор теперь свежий, но семантику сведения он не проверяет — это ожидаемо (схема ≠ процедура), однако вход с невалидным для сведения ключом проходит валидацию без предупреждения.",
      "evidence": "Живой validate_report: commit=null → valid=true (все прочие поля корректны), commit=ae6b9e4 (7 hex) → valid=true, commit=AE6B9E4 → valid=true; при этом docs/ru/call-mechanics.md:115 требует ^[0-9a-f]{40}$ и sha != base.",
      "fix": "Добавить в схему pattern ^[0-9a-f]{40}$ для commit при наличии closed-результатов (или отдельный warning-механизм), чтобы невалидный ключ сведения отсекался валидатором, а не только дисциплиной root'а."
    }
  ],
  "not_verified": [
    {
      "item": "Повторяемость live-experiment на другой версии OpenCode и поведение session_move для background-фиксера в общем случае",
      "why": "Требует запуска дочерних сессий; вложенные субагенты в этой сессии запрещены, а родительские сессии эксперимента недоступны для инспекции."
    },
    {
      "item": "npm-поставка: фактическое отсутствие tools/ и поведение stand: unavailable в установленном пакете",
      "why": "npm pack/install и запуск из установленного пакета не выполнялись (проверялась текстовая оговорка и files в package.json)."
    }
  ]
}
```
