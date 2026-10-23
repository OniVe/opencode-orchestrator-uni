# Арбитраж F/G (аудит pfx)

Дата: 2026-10-23. Спорные пункты: F (жизненный цикл прерванного фиксера: invariant MAJOR vs empiric MINOR) и G (guard'ы не несут смысл норм: empiric MAJOR vs invariant MINOR). Ревизия: commit `291a357`, aggregate `c407932d5e95a6e3ef9c49d953658cb9c61f6d6753354a083e876cf24d40f797` (95 файлов).

Итог: F — **MAJOR** (severity invariant), G — **MINOR** (severity invariant; MAJOR эмпирика опровергнут).

```json
{
  "schema": "arbiter/v1",
  "verdict": "resolved",
  "disputes": [
    {
      "id": "F",
      "item": "Жизненный цикл прерванного фиксера: терминального перехода «отчёта нет» и уборки worktree/ветки нет. Статус спора: ПОДТВЕРЖДЁН на severity стороны A (invariant) — MAJOR.",
      "verdict": "confirmed",
      "prism": ["reproducibility", "contract"],
      "severity": "MAJOR",
      "severity_reason": "Вердикт по severity дала призма contract, факты — reproducibility. 291a357 вводит механизм параллельных писателей (worktree+ветка на фиксера) и правило сведения ветвей, но не закрывает жизненный цикл: (а) у производителя нет представимого терминального состояния «отчёта нет» — в схеме отчёта его и не может быть, значит оно обязано быть на стороне root, а там его нет; (б) у ресурса (worktree/ветка) не определён владелец и момент освобождения. Следствие воспроизведено и это порча целевого репозитория: частичный коммит брошенной ветки вливается в main fast-forward'ом без отчёта и проверки, рабочее пространство залипает. MINOR стороны B опирается на «пре-существующую неполноту», но параллельные worktree-писатели и перенос коммитов/диффов появились именно в этом коммите (git show --stat 291a357: agents/*/fix-runner.md +1 строка, worktree-правила в 6 файлах) — неполнота введена изменением. Путь отказа штатный: те же документы предусматривают упавший/прерванный субагент (docs/ru/call-mechanics.md:197), на «Agent not found» предписано лишь «проверить файлы агентов». Цена правки — строки в ru+en доках; цена пропуска — молчаливый merge непроверенного частичного коммита в main пользователя.",
      "method": "1) Схема: git show 291a357:schemas/fix-runner.v1.json → status.enum = [closed, not_closed, needs_decision, budget_exceeded]; «отчёта нет» отсутствует. 2) Потребитель: docs/ru/root-runbook.md:29 — только needs_decision/not_closed/out_of_scope; budget_exceeded и пропавший отчёт не обработаны. 3) Уборка: git grep -ni 'prune|worktree remove|уборк' → 0 совпадений про worktree; git grep -n worktree -- tools lib index.ts → пусто (автоматики нет, только проза). 4) git-репро в temp-репо: worktree add -b fixer-1 ../wt; правка+untracked; worktree remove ../wt → fatal (exit 128); prune -v → exit 0 без эффекта, worktree остаётся в списке; add ../wt2 fixer-1 → \"fatal: 'fixer-1' is already used by worktree at ...\"; branch -d fixer-1 → exit 1 'used by worktree'. 5) Частичный коммит: коммит в worktree, remove --force → exit 0, ветка жива, merge --no-edit fixer-1 → 'Fast-forward, 2 files changed'; после branch -D тот же коммит → 'unreachable commit' в git fsck --unreachable.",
      "evidence": "remove dirty: exit 128 'contains modified or untracked files, use --force'; prune: exit 0 без эффекта (worktree в списке); повторный add той же ветки: \"fatal: 'fixer-1' is already used by worktree\"; branch -d: exit 1 'used by worktree'; merge брошенной ветки: 'Updating 3109e59..418d935 Fast-forward, 2 files changed, create mode 100644 u.txt'; fsck: 'unreachable commit c609628...' только после удаления ветки. Схема без терминального «отчёта нет»; root-runbook:29 без ветки для budget_exceeded/пропавшего отчёта; уборка worktree в 291a357 не описана."
    },
    {
      "id": "G",
      "item": "Guard'ы не несут смысл норм: мутация (инверсия несущего запрета + замена worktree_create на несуществующий инструмент) оставляет npm test 91/91 и check:locales 12/12 зелёными. Статус спора: ПОДТВЕРЖДЁН на severity стороны B (invariant) — MINOR; MAJOR стороны A (empiric) опровергнут.",
      "verdict": "confirmed",
      "prism": ["falsification", "contract"],
      "severity": "MINOR",
      "severity_reason": "Мутационные факты верны и воспроизведены, но MAJOR-квалификация («зелёные guard'ы дают ложную уверенность при приёмке») не держится. Призма contract: guard'ы заявляют ровно форму/паритет — test/support/locales.ts: 'file sets, frontmatter, markdown shape, and the schema-bound enum tokens'; test/consistency.test.ts: 'Guards identifier consistency'; TOOL_TOKEN = /\\borch_uni_[A-Za-z0-9_*]+/g покрывает только id комплекта. Семантику прозы они не заявляли ни до, ни после, а 291a357 не тронул ни одного файла test/ (git show --stat: 10 файлов, все agents/ и docs/) — ослабления нет, есть отсутствие нового класса проверок. Призма falsification: граница слепоты ýже тезиса A — несуществующий id из пространства комплекта ловится (orch_uni_ghost → 89 pass, 2 fail), не ловится только имя чужого пространства (worktree_create — инструмент харнесса OpenCode). Доктрина комплекта прямо запрещает трактовать зелёный прогон как доказательство свойства (agents/ru/invariant.md:18: «Зелёные тесты и сборка не считаются проверкой инварианта»), поэтому «ложная уверенность» не лицензирована контрактом guard'ов: это бэклог (смысловой guard на нормы прозы), не дефект поставки.",
      "method": "1) Baseline на чистой копии 291a357 (git archive 291a357 | tar -x в temp, node_modules через junction): bun test ./test/ → 91 pass / 0 fail / 759 expect(); bun tools/locale-check.ts → 12/12 ok. 2) Мутация по обоим локалям (чтобы паритет не ломался формой): worktree_create → worktree_create_ghost в agents/{ru,en}/orchestrator.md и docs/{ru,en}/call-mechanics.md; «Два фиксера в одном пространстве или по одним файлам — запрещено» → «— разрешено» (en forbidden → allowed); «не трогай основную ветку и чужие worktree» → «трогай ...» (en do not touch → do touch). Повтор: 91 pass / 0 fail; 12/12 ok. 3) Контроль границы: worktree_create_ghost → orch_uni_ghost в docs/ru/call-mechanics.md → 89 pass, 2 fail ('unknown tool id \"orch_uni_ghost\"', 'locale content parity'). 4) Контракт guard'ов — test/support/locales.ts, test/consistency.test.ts; отсутствие правок test/ — git show --stat 291a357.",
      "evidence": "Baseline: '91 pass, 0 fail, 759 expect() calls' + '12/12 ok'. После мутации (инверсия запрета + несуществующий worktree_create_ghost): '91 pass, 0 fail' + '12/12 ok'. Контроль с orch_uni_ghost: '89 pass' + '(fail) prose references only existing agent and tool ids → unknown tool id \"orch_uni_ghost\"' + '(fail) locale content parity'. git show --stat 291a357: только agents/ и docs/, test/ не тронут → guard'ы не ослаблены."
    }
  ],
  "not_verified": [
    {
      "item": "F: фактическая частота прерываний фиксеров (вероятность залипания)",
      "why": "В комплекте нет журнала прогонов/сессий с метаданными о прерванных субагентах; вероятность выведена из документированного штатного пути «упал/прерван → resume» (docs/ru/call-mechanics.md:197), а не замером. На severity не влияет: последствие (fast-forward частичного коммита в main) воспроизведено, правка — строки в доках."
    },
    {
      "item": "F: поведение харнесс-инструмента worktree_create при занятой ветке/повторном имени",
      "why": "В комплекте нет кода, вызывающего worktree_create (это инструмент OpenCode, не комплекта); проверял git-семантику и документированную альтернативу «иначе git worktree add», на которой все четыре отказа воспроизведены. Другая реализация инструмента может отличаться в деталях, но не отменяет отсутствие терминального перехода и уборки в документах."
    },
    {
      "item": "G: полнота мутационного корпуса по остальным нормам изменения",
      "why": "Проверял заявленный класс (инверсия несущего запрета + несуществующий инструмент) двумя прогонами; полный перебор всех нормативных строк 10 файлов не делал — вопрос спора о классе слепоты, не о полноте корпуса."
    }
  ]
}
```
