# Эмпирический аудит pfx (круг 1)

Ревизия: `291a357` (aggregate `c407932d5e95a6e3ef9c49d953658cb9c61f6d6753354a083e876cf24d40f797`, 95 файлов; база `dfa4ee7`).
Роль: empiric (read-only). Эксперименты — во временных каталогах; репозиторий не изменялся (`git status` пуст, `git worktree list` = только основной каталог).

## Резюме

Вердикт: **not_ready**. Guard-набор на HEAD зелёный и пересчитан мной (12/12, 91/91, biome 0), структура md и EN-локаль целы — но заявка C1 «формулировки согласованы» опровергнута, и у механики изоляции три проверенных разрыва.

1. **worktree_create не создаёт ветку** (detached HEAD): основной путь не даёт «своей ветки», сведение «слиянием веток» по нему невыполнимо, а коммит после удаления worktree становится недостижимым (`git fsck --unreachable`).
2. **Нет документированного способа посадить фиксера в его worktree**: у `subagent(...)` нет параметра каталога, сессия субагента наследует cwd root'а; `session_move` в ките не упомянут — по описанному пути фиксеры оказываются в одном пространстве.
3. **Противоречие норм**: orchestrator:48 запрещает «одни файлы **и** одно пространство», call-mechanics:113 — «одно пространство **или** одни файлы». Состояние «разные worktree, одни файлы» разрешено промптом root'а и запрещено доком; сведение такое состояние молча сливает (0 маркеров), а guard'ы смысл норм не проверяют — ослабление самого правила проходит зелёным (мутация A), тогда как структурная мутация красит (мутация B).

Побочно: остаточное «писатели — последовательно» в общем цикле, слепота `git show --stat` к дельте раунда после merge, отсутствие поля branch/worktree в `fix-runner/v1`, неописанная установка зависимостей в свежем worktree (18.2 s, иначе guard rc=1), неукрашенный `process-ready-loop.md`, отсутствие жизненного цикла worktree.

## Ключевые замеры

| Что | Команда | Результат |
|---|---|---|
| Guard'ы на HEAD | `bun tools/locale-check.ts` / `bun test ./test/` / `npx biome check .` | rc=0 12/12 · rc=0 91 pass/759 expect · rc=0 33 файла |
| worktree_create | `rev-parse --abbrev-ref HEAD` в worktree | `HEAD` (detached); `git worktree list` → `(detached HEAD)` |
| сведение по ветке | `git merge probe` в основном репо | rc=1 `not something we can merge` |
| потеря коммита | `git worktree remove --force` → `git fsck --unreachable` | rc=0; коммит 8f0b61f только как unreachable |
| git-эталон | `git worktree add <path>` (без -b) | rc=0, ветка `wt-A`; второй worktree на ту же ветку → rc=128 |
| merge, далёкие хунки | 2 ветки, один файл | rc=0/rc=0, маркеров 0, противоречащие нормы сосуществуют |
| merge, один якорь | 2 ветки, одна строка | rc=1, CONFLICT, 1 файл с маркером |
| мутация правила | temp-копия, снят запрет «по одним файлам» | test rc=0, locales rc=0, biome rc=0 (не поймано) |
| контроль структуры | temp-копия, сменён уровень заголовка | test rc=1 (1 fail), locales rc=1 (11/12) |
| зависимости в worktree | `bun install --frozen-lockfile` | rc=0, 570 пакетов, 18.2 s; до установки guard rc=1 |
| дельта раунда | `git show --stat HEAD` vs `git diff <base>..HEAD` | 1 файл vs 2 файла |

## Находки

- **M1 (MAJOR)** — `worktree_create` = detached HEAD: нет ветки, merge по ветке невозможен, коммит теряется при уборке.
- **M2 (MAJOR)** — изоляция не обеспечена формой вызова: у `subagent` нет каталога, `session_move` не документирован.
- **M3 (MAJOR)** — область запрета orchestrator:48 ≠ call-mechanics:113 (C1 «согласованы» опровергнуто).
- **M4 (MAJOR)** — страховка сведения покрывает только форму: чистый merge + зелёные guard'ы при взаимоисключающих нормах; край C6 не описан.
- **m1 (MINOR)** — остаточное «писатели — последовательно» в общем цикле (orchestrator:18).
- **m2 (MINOR)** — `git show --stat` занижает дельту раунда после сведения (1 файл вместо 2).
- **m3 (MINOR)** — требование «укажи ветку/worktree и способ переноса» без поля в `fix-runner/v1`.
- **m4 (MINOR)** — свежий worktree без node_modules: guard rc=1 до `bun install` (18.2 s), шаг не описан.
- **m5 (MINOR)** — `process-ready-loop.md` не отражает сведение (0 упоминаний в обеих локалях).
- **m6 (MINOR)** — нет жизненного цикла worktree/ветки и судьбы прерванного фиксера.
- **m7 (NIT)** — `instruction-other-session` сжата сильнее остальных.

## Что не проверено

Перемещение живой дочерней сессии (лимит вложенности субагентов), иные пути спавна в OpenCode (только бинарь), поведение при N>3 и в других версиях, фактический выбор нормы root'ом в рантайме.

```json
{
  "schema": "empiric/v1",
  "verdict": "not_ready",
  "claims_checked": [
    {
      "claim": "Изменение = ровно 10 заявленных файлов (agents/{ru,en}/{orchestrator,fix-runner}, docs/{ru,en}/{call-mechanics,root-runbook,instruction-other-session})",
      "method": "run",
      "command": "git diff --name-status dfa4ee7..291a357",
      "rc": "0",
      "result": "10 строк M, ровно заявленный набор; 20 вставок / 14 удалений",
      "verdict": "confirmed"
    },
    {
      "claim": "HEAD = 291a357, дерево чистое, origin/main не содержит изменения",
      "method": "run",
      "command": "git status --porcelain; git rev-parse HEAD; git rev-parse origin/main",
      "rc": "0",
      "result": "status пуст; HEAD=291a357e8e9ab0ecd67a13380dfedf6951fa924b; origin/main=dfa4ee757faf6ced85c12a8728fd25a348056189",
      "verdict": "confirmed"
    },
    {
      "claim": "Ревизия состояния = aggregate c407932d…f797, 95 файлов (exclude lab, eval/results), детерминированно",
      "method": "measure",
      "command": "orch_uni_snapshot x2 (exclude lab, eval/results) + git ls-files | grep -v '^lab/' | grep -v '^eval/results/' | wc -l",
      "rc": "0",
      "result": "оба вызова вернули aggregate c407932d5e95a6e3ef9c49d953658cb9c61f6d6753354a083e876cf24d40f797; tracked_files_excl=95",
      "verdict": "confirmed"
    },
    {
      "claim": "C5: check:locales = 12/12, npm test = 91/91, biome rc=0 на HEAD",
      "method": "run",
      "command": "bun tools/locale-check.ts; bun test ./test/; npx biome check .",
      "rc": "0",
      "result": "12/12 ok (rc=0); 91 pass / 0 fail / 759 expect (rc=0); Checked 33 files, No fixes applied (rc=0)",
      "verdict": "confirmed"
    },
    {
      "claim": "C1 (часть 1): правило про параллельные fix-runner зафиксировано во всех 10 файлах",
      "method": "source",
      "command": "git grep -n -i 'worktree|fix-runner' -- agents docs",
      "result": "все 10 изменённых файлов содержат новое правило (fix-runner: 1 строка, orchestrator: 2 правила, call-mechanics: правило §5 + инвариант §7, root-runbook: шаг 6 + передача данных, instruction: 1 строка)",
      "verdict": "confirmed"
    },
    {
      "claim": "C1 (часть 2): формулировки согласованы между собой",
      "method": "compare_base",
      "command": "grep -n 'per workspace|на одно рабочее пространство' agents/*/orchestrator.md; grep -n 'Two fixers in one workspace|Два фиксера' docs/*/call-mechanics.md",
      "rc": "0",
      "result": "orchestrator:48 запрещает 'по одним и тем же файлам в одном пространстве' (конъюнкция); call-mechanics:113 — 'Два фиксера в одном пространстве или по одним файлам — запрещено' (дизъюнкция). Состояние (разные workspace, одни файлы) разрешено первой нормой и запрещено второй",
      "verdict": "refuted"
    },
    {
      "claim": "C2: старых формулировок 'строго последовательно' / 'single writer в каждый момент' не осталось",
      "method": "run",
      "command": "git grep -n -E 'Единственный писатель|единственный пишущий|строго последовательно|single writer|strictly sequentially|one writer at any moment|писател'",
      "rc": "0",
      "result": "совпадения только: README.ru:12 и call-mechanics:13,16 ('единственный пишущий субагент' — ролевое), orchestrator:18 ('писатели — последовательно; несколько fix-runner — только в изолированных…'), orchestrator:48/50 и call-mechanics:220 (новые формулировки). 'строго последовательно'/'single writer' отсутствуют",
      "verdict": "confirmed"
    },
    {
      "claim": "C2: остаточных противоречащих формулировок нет",
      "method": "source",
      "command": "sed -n '18p;49p' agents/ru/orchestrator.md",
      "result": "строка 18 сохраняет плоское правило 'писатели — последовательно' (исключение только в скобках той же строки), строка 49 разрешает несколько fix-runner (писателей) параллельно — общее правило цикла и RULES расходятся",
      "verdict": "refuted"
    },
    {
      "claim": "C3: механика изоляции полна — worktree+branch, непересекающиеся списки, сведение, запрет двух фиксеров в одном пространстве",
      "method": "run",
      "command": "worktree_create({name:'probe'}) в temp-репо; git -C <dir> rev-parse --abbrev-ref HEAD; git worktree list; git merge probe",
      "rc": "1",
      "result": "каталог создан; 'HEAD' (detached); worktree list: '(detached HEAD)'; git branch -a в основном репо: только main; git merge probe → rc=1 'merge: probe - not something we can merge'. Заявленный основной путь не даёт ветку, а сведение описано как слияние веток",
      "verdict": "refuted"
    },
    {
      "claim": "C3: способ посадить фиксера в его worktree задан в документированной форме вызова",
      "method": "run",
      "command": "git grep -n 'session_move|directory=' -- docs agents; pwd (своя сессия, запущена root'ом без каталога)",
      "rc": "0",
      "result": "session_move/directory= — 0 совпадений; у subagent параметры agent/description/model/prompt/sessionID/background; моя сессия-субагент имеет cwd = корень проекта; tools.opencode.session_move({directory}) вернул каталог (API есть)",
      "verdict": "refuted"
    },
    {
      "claim": "C4: инварианты процесса сохранены (вердикт до правок, fix-runner не пушит, публикация после ship, MAJOR-верификация, re-audit=resume)",
      "method": "source",
      "command": "git grep -n 'не пушить|ship|Фаза 3.5|resume|до вердикта' -- docs agents",
      "result": "инварианты на месте: call-mechanics §7, root-runbook шаги 4/5/7/9, instruction:31 (правки после вердикта запрещены; fix-runner не пушит; SHIP-условие единое; MAJOR-верификация fail-closed; re-audit=resume тех же сессий)",
      "verdict": "confirmed"
    },
    {
      "claim": "C5 (часть 2): структура md не поехала, EN без кириллицы, уровни заголовков/фенсы совпадают с базой",
      "method": "compare_base",
      "command": "for f in <10 файлов>; git show dfa4ee7:$f | grep -cE '^#{1,6} '; grep -cE '^#{1,6} ' $f; LC_ALL=C.UTF-8 grep -rqP '[\\xD0-\\xD1][\\x80-\\xBF]' agents/en docs/en",
      "rc": "0",
      "result": "заголовки/фенсы base=HEAD по всем 10 файлам (call-mechanics 22/20, root-runbook 7/2, instruction 5/0, агенты 0/0); EN_HAS_CYRILLIC=no",
      "verdict": "confirmed"
    },
    {
      "claim": "C6: краевые случаи (одни файлы при непересекающихся списках; отсутствие worktree_create; прерванный фиксер; конфликт при сведении; out_of_scope) описаны или осознанно не покрыты",
      "method": "run",
      "command": "git grep -n -i 'worktree remove|cleanup|прерван|interrupted|по одним|on the same files' -- docs agents",
      "rc": "0",
      "result": "out_of_scope покрыт (root-runbook:29); конфликт при сведении назван без процедуры; 'worktree remove'/cleanup — 0; прерванный фиксер — только общий 'Субагент упал/прерван → resume' (call-mechanics:197), судьба worktree/частичных коммитов не описана; 'одни файлы' — 4 файла из 10 с разной областью, остальные 6 молчат",
      "verdict": "refuted"
    },
    {
      "claim": "Guard-набор является носителем нового правила (мутационная чувствительность к C1)",
      "method": "measure",
      "command": "temp-копия: sed ослабил запрет в docs/ru/call-mechanics.md → bun test; bun tools/locale-check.ts; npx biome check .",
      "rc": "0",
      "result": "MUT-A (снят запрет 'по одним файлам' — ровно класс C1): test rc=0 (91 pass), locales rc=0 (12/12), biome rc=0. Контроль MUT-B (смена уровня заголовка ru §7): test rc=1 (1 fail), locales rc=1 (11/12, 'heading levels differ')",
      "verdict": "refuted"
    },
    {
      "claim": "Дефект C1 обнаруживается на сведённом состоянии (merge detection)",
      "method": "measure",
      "command": "temp-репо: две ветки правят один файл в разных якорях → git merge wt-H; git merge wt-I",
      "rc": "0",
      "result": "mergeH rc=0, mergeI rc=0, grep -c '<<<<<<<' = 0, в файле сосуществуют 'RULE-H: same files allowed across workspaces' и 'RULE-I: same files forbidden always'; при правке одной строки/якоря — CONFLICT rc=1 и 1 файл с маркерами",
      "verdict": "refuted"
    }
  ],
  "modes_measured": [
    {
      "operation": "прогон guard-набора в рабочем пространстве фиксера (worktree)",
      "regimes": [
        "свежий worktree без зависимостей",
        "после bun install --frozen-lockfile"
      ],
      "best": "после установки: check:locales rc=0 (12/12), bun test rc=0 (91 pass), biome rc=0; сам прогон 0.2–0.33 s",
      "worst": "свежий worktree: check:locales rc=1 ('Cannot find package gray-matter'), bun test rc=1 — проверки не запускаются",
      "budget_claim": null,
      "measured": "node_modules в .gitignore; установка 18.2 s / 570 пакетов на worktree; в диффе числовых бюджетов нет, сверять нечего"
    },
    {
      "operation": "сведение двух веток фиксеров (merge) и его обнаружимость",
      "regimes": [
        "разные файлы",
        "один файл, далёкие хунки",
        "один файл, одна строка/якорь"
      ],
      "best": "разные файлы: merge rc=0, конфликтов нет; дельта видна только через git diff <round-base>..HEAD",
      "worst": "одна строка/якорь: CONFLICT rc=1, 1 файл с маркерами; промежуточный режим (далёкие хунки): merge rc=0 без маркеров, но семантическое противоречие остаётся и guard'ы его не ловят (MUT-A rc=0)",
      "budget_claim": null,
      "measured": "git show --stat после сведения — 1 файл, git diff <round-base>..HEAD — 2 файла"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение на этой машине",
      "status": "applied",
      "note": "Воспроизведены: worktree_create→detached HEAD и потеря коммита после удаления (temp-репо), merge-поведение (temp-репо), мутации guard-набора (временная копия репозитория + junction node_modules)"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "10 файлов/20+14 строк; 12/12; 91/759; 95 файлов; 18.2 s/570 пакетов; 1 vs 2 файла дельты; 0 маркеров vs 1 конфликтный файл; 4/10 и 6/10 по матрице формулировок"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора его же командами",
      "status": "applied",
      "note": "Пересчитаны guard'ы (12/12, 91/91, biome 0) и snapshot (aggregate совпал с c407932d…); производительностных заявок в диффе нет — отмечено в modes_measured"
    },
    {
      "item": 4,
      "title": "Сравнение с базой (git)",
      "status": "applied",
      "note": "git show dfa4ee7:<file> для заголовков/фенсов; git diff dfa4ee7..291a357; поведение merge на реконструкции базы (две ветки от одного base-коммита)"
    },
    {
      "item": 5,
      "title": "Факты об окружении — из вывода команд",
      "status": "applied",
      "note": "bun 1.4.2, git worktree list, pwd, 373 записи node_modules — всё из прогонов; версия OpenCode-бинаря не извлекалась (not_verified)"
    },
    {
      "item": 6,
      "title": "Первоисточники: схемы, тесты, инструменты",
      "status": "applied",
      "note": "schemas/fix-runner.v1.json, test/consistency.test.ts, test/translation.test.ts, tools/locale-check.ts; поведение worktree_create проверено запуском, а не описанием"
    },
    {
      "item": 7,
      "title": "Прототип ключевой операции в нескольких режимах",
      "status": "applied",
      "note": "Guard'ы в свежем worktree vs после install; три режима merge (разные файлы / далёкие хунки / один якорь); худший режим назван"
    },
    {
      "item": 8,
      "title": "Опции и крайние значения",
      "status": "applied",
      "note": "validate_report: нет commit → invalid; commit-массив → invalid; статус вне enum → invalid; лишние поля (branch/worktree/transfer) → valid (additionalProperties не задан); пустой results → valid"
    },
    {
      "item": 9,
      "title": "Оценки без замера → замер или явный риск",
      "status": "applied",
      "note": "Числовых бюджетов в диффе нет; собственные замеры 18.2 s, 0.33 s, 2 файла дельты; непроверяемое вынесено в not_verified"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто во всех местах",
      "status": "applied",
      "note": "Проверены все 12 несущих файлов (10 изменённых + process-ready-loop + README): process-ready-loop — 0 упоминаний новой механики, README — только ролевая формулировка; 6/10 не содержат запрета 'по одним файлам'"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном/аналогом",
      "status": "applied",
      "note": "Эталон — git: `git worktree add <path>` создаёт ветку (замер: 'wt-A'), второй worktree на ту же ветку — rc=128 'already used by worktree'. Документ предпочитает worktree_create с другим поведением (detached) — расхождение = M1"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы входа",
      "status": "applied",
      "note": "snapshot дважды — один aggregate; guard'ы дважды (репо и temp-копия) — одинаковые счётчики; границы схемы проверены (пустой results, лишние поля, отсутствие commit)"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "Валидация по тексту (JSON-блок) и по схеме — один результат; счётные крайности: results=[], commit=null|string, массив → invalid; формы вызова root→fixer (call-mechanics §2, root-runbook:44, instruction:30) сверены — расходятся по составу полей"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей до потребителя",
      "status": "applied",
      "note": "Требование 'укажи ветку/worktree и способ переноса' не имеет поля в fix-runner/v1 и не встречается в составе свода root'а → мёртвое требование (m3)"
    },
    {
      "item": 15,
      "title": "Непроверенное не подаётся как факт",
      "status": "applied",
      "note": "Перемещение живой дочерней сессии, иные пути спавна, другие версии — в not_verified"
    },
    {
      "item": 16,
      "title": "Дисциплина кода возврата",
      "status": "applied",
      "note": "rc зафиксированы: diff 0, guards 0/0/0, MUT-A 0/0/0, MUT-B 1/1, конфликтный merge 1, чистый merge 0, worktree add на ту же ветку 128; где пайп глотал rc — перезапуск без пайпа (merge → /tmp/*.log)"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "Спецификация здесь — структурный паритет локалей: 4 варианта мутаций прогнаны через guard'ы; статистика: 2 смысловые/структурные мутации — 1 обнаружена (уровень заголовка), 1 пропущена (снятие запрета 'по одним файлам')"
    },
    {
      "item": 18,
      "title": "Поставляемые тесты — объект аудита",
      "status": "applied",
      "note": "translation/consistency проверяют только форму (файлы, заголовки, фенсы, frontmatter, enum, кириллица); несущая способность подтверждена контролем MUT-B (красит) и пробелом MUT-A (не красит)"
    },
    {
      "item": 19,
      "title": "База без git / реконструкция",
      "status": "not_applicable",
      "note": "Репозиторий и полная история доступны (dfa4ee7, локальные теги, origin/main) — реконструкция не нужна"
    }
  ],
  "findings": [
    {
      "id": "M1",
      "severity": "MAJOR",
      "location": "docs/ru/call-mechanics.md:113 (=docs/en:113), docs/ru/call-mechanics.md:220, agents/ru/orchestrator.md:49, agents/en/orchestrator.md:49",
      "mechanism": "Документ предписывает 'каждому свой git worktree и ветка (worktree_create, иначе git worktree add)', но worktree_create создаёт worktree на detached HEAD: ветка не создаётся, слияние 'веток' невозможно, поле отчёта 'своя ветка' пусто. Коммит фиксера существует только как HEAD worktree; после git worktree remove он недостижим (fsck --unreachable) — потеря правок при уборке до переноса. Фолбэк git worktree add ведёт себя правильно, т.е. основной путь хуже запасного.",
      "evidence": "worktree_create({name:'probe'}) → 'C:\\Users\\Owner\\.local\\share\\opencode\\worktree\\4ec1b0\\probe'; git -C <dir> rev-parse --abbrev-ref HEAD → 'HEAD' (rc=0); git worktree list → '(detached HEAD)' (rc=0); коммит в worktree → rc=0 (8f0b61f); git branch -a → только '* main' (rc=0); git merge probe → rc=1 'merge: probe - not something we can merge'; git worktree remove --force → rc=0; git log --all теряет коммит; git fsck --unreachable | grep -c 8f0b61f → 1",
      "fix": "Заменить основной путь на `git worktree add -b fix/<round>-<n> <path> <base>` (или worktree_create + обязательный `git switch -c`), добавить в правила фиксера/шаблон вызова создание ветки и запрет удалять worktree до подтверждения переноса; в отчёт — поле с веткой/коммитом"
    },
    {
      "id": "M2",
      "severity": "MAJOR",
      "location": "docs/ru/call-mechanics.md §2 (формы вызова) и :113; docs/en/call-mechanics.md §2, :113; agents/ru/orchestrator.md:49; docs/ru/root-runbook.md:44",
      "mechanism": "Изоляция заявлена, но способа посадить фиксера в его worktree в документированной механике нет: subagent({agent,prompt,background?,sessionID?,model?}) не имеет параметра каталога, сессия субагента наследует рабочее пространство root'а. По описанному пути два фиксера окажутся в одном (основном) пространстве — ровно то, что правило запрещает; 'не трогай основную ветку' невыполнимо без смены cwd. API session_move(sessionID, directory) существует, но в ките не упомянут ни разу.",
      "evidence": "pwd в моей сессии (запущена root'ом как субагент без каталога) → /c/project/ai/opencode-orchestrator-uni (rc=0); параметры инструмента subagent: agent, description, model, prompt, sessionID, background — каталога нет; git grep -n 'session_move|directory=' -- docs agents → 0 совпадений (rc=0); tools.opencode.session_move({directory}) → вернул новый каталог (API работоспособен)",
      "fix": "Вписать в call-mechanics §2/§5 и шаблон вызова: создать worktree → session_move(sessionID=<фиксер>, directory=<worktree>) → работа → отчёт с веткой; либо снять заявку на параллельность"
    },
    {
      "id": "M3",
      "severity": "MAJOR",
      "location": "agents/ru/orchestrator.md:48 и agents/en/orchestrator.md:48 vs docs/ru/call-mechanics.md:113 и docs/en/call-mechanics.md:113",
      "mechanism": "Разная область запрета у двух нормативных носителей: orchestrator запрещает конъюнкцию ('по одним и тем же файлам в одном пространстве'), call-mechanics — дизъюнкцию ('в одном пространстве или по одним файлам'). Состояние 'два фиксера, разные worktree, одни файлы' разрешено промптом root'а и запрещено доком; сведение такие ветки сливает молча, guard'ы противоречия не видят. Заявка C1 'формулировки согласованы' опровергнута.",
      "evidence": "agents/ru/orchestrator.md:48 'Не запускай двух писателей по одним и тем же файлам в одном пространстве.' vs docs/ru/call-mechanics.md:113 'Два фиксера в одном пространстве или по одним файлам — запрещено.'; следствие замерено: mergeH rc=0, mergeI rc=0, grep -c '<<<<<<<' = 0, в файле одновременно 'RULE-H: same files allowed across workspaces' и 'RULE-I: same files forbidden always'",
      "fix": "Свести к одной области действия (рекомендую безусловный запрет на одни файлы либо явное разрешение + процедура разрешения семантических пересечений) и продублировать дословно в orchestrator/call-mechanics/root-runbook/instruction"
    },
    {
      "id": "M4",
      "severity": "MAJOR",
      "location": "docs/ru/call-mechanics.md:113 ('прогоняет проверки на сведённом состоянии'), docs/ru/root-runbook.md:29; край C6 'разные фиксеры правят одни файлы при непересекающихся списках'",
      "mechanism": "Страховка сведения покрывает только форму. 'Непересекающиеся списки' — id находок, а не файлы: два фиксера легально правят один документ. Git либо молча сливает (далёкие хунки) и оставляет взаимоисключающие нормы, либо даёт конфликт без критерия разрешения. Guard-набор (12/12 локали, 91 тест, biome) не содержит проверки смысла норм: ослабление самого правила проходит зелёным. Класс дефекта, который уже есть в C1, сведение не обнаруживает и не предотвращает — край C6 не описан и не принят осознанно.",
      "evidence": "temp-репо: ветки H и I правят docs/b.md в разных якорях → git merge wt-H rc=0, git merge wt-I rc=0, grep -c '<<<<<<<' = 0, обе строки в файле; правка одной строки → CONFLICT rc=1, 1 файл с маркерами; temp-копия кита: MUT-A (снят запрет 'по одним файлам') → bun test rc=0 (91 pass), locale-check rc=0 (12/12), biome rc=0; контроль MUT-B (уровень заголовка) → test rc=1 (1 fail), locale-check rc=1 (11/12)",
      "fix": "Требовать непересекающиеся *файлы* на фиксера (а не списки) и объявить это в 4 носителях, либо ввести шаг пост-merge смысловой сверки правок; край записать в risks как принятый"
    },
    {
      "id": "m1",
      "severity": "MINOR",
      "location": "agents/ru/orchestrator.md:18; agents/en/orchestrator.md:18",
      "mechanism": "В общем цикле осталось плоское правило 'писатели — последовательно'; исключение для нескольких fix-runner дано только в скобках той же строки. Строка 49 разрешает параллельных писателей — общее правило и RULES расходятся при чтении вне скобок; C2 'нет противоречащих формулировок' полностью не выполнен.",
      "evidence": "sed -n '18p;49p' agents/ru/orchestrator.md → ':18 …(писатели — последовательно; несколько `fix-runner` — только в изолированных рабочих пространствах…)', ':49 Несколько `fix-runner` можно запускать параллельно (background)…'",
      "fix": "Переформулировать строку 18: 'писатели — по одному на рабочее пространство; несколько fix-runner — только изолированно'"
    },
    {
      "id": "m2",
      "severity": "MINOR",
      "location": "docs/ru/root-runbook.md:29 (и docs/en:29); docs/ru/call-mechanics.md §5 ('Root проверяет дельту (git show --stat …)')",
      "mechanism": "Проверка дельты перед re-audit описана командой git show --stat. После сведения раунда из N веток она показывает только дельту последнего merge относительно первого родителя, т.е. занижает объём правок (на замере 1 файл вместо 2) — шаг 'root проверяет дельту' в новом режиме частично слеп.",
      "evidence": "temp-репо: git merge J rc=0, git merge K rc=0; git show --stat HEAD → 'docs/b.md | 2 +-' (1 файл); git diff --stat 514d56b..HEAD → 'docs/a.md | 2 +-', 'docs/b.md | 4 +++-' (2 файла); rc=0",
      "fix": "В параллельном режиме заменить на `git diff <round-base>..HEAD --stat` (или перечислить все merge/коммиты раунда) в обеих локалях"
    },
    {
      "id": "m3",
      "severity": "MINOR",
      "location": "agents/ru/fix-runner.md:59 (=agents/en:59) vs schemas/fix-runner.v1.json",
      "mechanism": "Правило требует 'в отчёте укажи свою ветку/worktree и способ переноса (коммиты/дифф)', но в контракте fix-runner/v1 такого поля нет (commit — одна строка|null), в шаблоне отчёта его нет, в составе свода root'а не упомянуто. Лишние поля валидатор пропускает — требование выполнимо только неконтрактно: информация не проверяется и не доезжает до потребителя.",
      "evidence": "validate_report({...report, branch:'fix/r1-a', worktree:'C:/tmp/wt-a', transfer:'diff'}) → valid:true; без commit → valid:false ('required field is missing', $.commit); commit-массив → valid:false ('expected type string|null, got array'); grep 'branch|transfer' schemas/fix-runner.v1.json → 0",
      "fix": "Добавить в схему workspace {branch, worktree, transfer} (+ шаблон в обеих локалях + тест), либо убрать требование из прозы"
    },
    {
      "id": "m4",
      "severity": "MINOR",
      "location": "docs/ru/call-mechanics.md:113 (фиксер 'прогони затронутые тесты'); docs/ru/root-runbook.md:29 (стенд раунда)",
      "mechanism": "Свежий worktree не содержит node_modules (.gitignore), поэтому предписанные фиксеру прогоны в его пространстве падают до установки зависимостей; шаг установки нигде не описан. Стоимость мала (18.2 s), но без него фиксер получает красный стенд и может списать это на дефект правки.",
      "evidence": "в worktree temp-клона: bun tools/locale-check.ts → rc=1 'Cannot find package gray-matter'; bun test ./test/ → rc=1; после bun install --frozen-lockfile → rc=0 (570 пакетов, 18.2 s); повторный locale-check → rc=0 (12/12)",
      "fix": "В границы вызова фиксера добавить 'установи зависимости в своём worktree (bun install --frozen-lockfile) до прогонов'"
    },
    {
      "id": "m5",
      "severity": "MINOR",
      "location": "docs/ru/process-ready-loop.md; docs/en/process-ready-loop.md (не изменены)",
      "mechanism": "Каноническое дерево шагов цикла (на него ссылаются call-mechanics и root-runbook) не отражает новую механику: узел [2] ПРАВКИ → [3] X1 описывает линейные правки, сведения и параллельных фиксеров нет. Формально не противоречит, но полнота 'во всех документах процесса' не достигнута: root, ведущий цикл по этому документу, коммитит в X1 без шага сведения.",
      "evidence": "grep -ci 'worktree|overlapping|сведённ|consolidat|по одним' docs/ru/process-ready-loop.md docs/en/process-ready-loop.md → 0 по всем токенам (rc=0); в изменённых 10 файлах worktree упоминается 1–2 раза на файл",
      "fix": "Добавить в [2]/[3] подшаг 'сведение веток → проверки на сведённом состоянии → X1' в обеих локалях"
    },
    {
      "id": "m6",
      "severity": "MINOR",
      "location": "docs/ru/call-mechanics.md:197 (§5 Отказы); docs/ru/root-runbook.md:29 — жизненный цикл worktree",
      "mechanism": "Жизненный цикл рабочего пространства не описан: когда удалять worktree/ветку после сведения, что делать с worktree и частичными коммитами прерванного фиксера (общий рецепт 'resume с места остановки' не учитывает, что cwd сессии — отдельное пространство). Замер показывает цену: коммит, оставшийся в удалённом worktree, становится недостижимым.",
      "evidence": "git grep -n -i 'worktree remove|cleanup|удалить worktree' -- docs agents → 0 совпадений (rc=0); git worktree remove --force → rc=0; git log --all теряет коммит; git fsck --unreachable | grep -c 8f0b61f → 1",
      "fix": "В §5: worktree хранится до подтверждения переноса root'ом; при прерывании — resume в том же worktree; уборка — после merge с проверкой, что все коммиты вошли"
    },
    {
      "id": "m7",
      "severity": "NIT",
      "location": "docs/ru/instruction-other-session.md:30; docs/en:30",
      "mechanism": "Сжатая карточка передачи содержит только 'отдельные worktree + непересекающиеся списки + сведение': нет ветки на фиксера, проверок на сведённом состоянии и альтернативы worktree_create/git worktree add. Сессия, работающая только по этой инструкции, сведёт без проверок — состав механики в носителях неодинаков.",
      "evidence": "grep -ci 'сведённ|consolidat' docs/ru/instruction-other-session.md → 1 (только 'последующим сведением'); 'проверк' в контексте сведения — 0; для сравнения docs/ru/call-mechanics.md → 2",
      "fix": "Довести строку до состава call-mechanics: ветка + сведение + проверки на сведённом состоянии"
    }
  ],
  "contract_gaps": [
    {
      "item": "Определение 'рабочее пространство'",
      "where": "agents/*/orchestrator.md:48; docs/*/call-mechanics.md:113",
      "why": "Не задано, что считается пространством (git worktree? каталог сессии? копия?) — от этого зависит область действия запрета"
    },
    {
      "item": "Критерий непересечения",
      "where": "call-mechanics:113; root-runbook:44",
      "why": "'Непересекающиеся списки' — id находок; пересечение по файлам/якорям не нормировано, хотя именно оно определяет конфликт при сведении"
    },
    {
      "item": "Процедура сведения и владелец разрешения",
      "where": "call-mechanics:113; root-runbook:29",
      "why": "Сказано 'root разрешает пересечения и конфликты', но не задано, кто правит конфликтный файл, по какому критерию, что делать с семантическими противоречиями и нужен ли re-audit до фиксации итога"
    },
    {
      "item": "Формат переноса и поле отчёта",
      "where": "agents/*/fix-runner.md:59; schemas/fix-runner.v1.json",
      "why": "'Коммиты/дифф' — разные способы с разными последствиями (diff без истории, коммит в detached worktree без ветки), а поле в контракте одно и не описывает ветку/worktree/способ"
    },
    {
      "item": "Ревизия состояния после сведения",
      "where": "call-mechanics §7; root-runbook шаг 3",
      "why": "Вердикт фиксируется вместе с ревизией (хэш/коммит), но для раунда из N веток не задано, что считается состоянием (последний merge? aggregate? набор коммитов)"
    },
    {
      "item": "Жизненный цикл worktree/ветки и прерванный фиксер",
      "where": "call-mechanics §5; C6",
      "why": "Не задано, когда удаляется worktree/ветка, что с частичными коммитами прерванного фиксера, кто отвечает за уборку"
    }
  ],
  "not_verified": [
    {
      "item": "Перемещение живой дочерней сессии фиксера через session_move",
      "why": "Вложенность субагентов ограничена ('Subagent depth limit reached (1)') — на дочерней сессии проверить не удалось; API проверен на собственной сессии"
    },
    {
      "item": "Наличие в OpenCode иного worktree-aware пути спавна сессии",
      "why": "Локально только бинарь @opencode/cli/bin/opencode.exe, исходников нет; семантика проверялась вызовами инструментов"
    },
    {
      "item": "Поведение при N>3 фиксерах и в других версиях OpenCode/git",
      "why": "Замеры на 2–3 ветках и на этой версии git; версия бинаря не извлекалась"
    },
    {
      "item": "Фактический выбор нормы root'ом при расхождении orchestrator:48 и call-mechanics:113",
      "why": "Наблюдать рантайм-решение агента нельзя; зафиксировано текстовое расхождение и его последствия на git-уровне"
    }
  ]
}
```
