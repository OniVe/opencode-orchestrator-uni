# Red-team pfx (r2) — re-check после правок 7ab0d82

Ревизия: 7ab0d82, aggregate d4032219ae8aa7500ef1d9212176a8df8a7b9498dd907d6b7d8b26684d4a36fc (95 файлов; пересчитано orch_uni_snapshot, совпало). Дифф раунда: git diff --stat c7f4231..7ab0d82 → 10 файлов, +18/−16 (agents/{ru,en}/{orchestrator,fix-runner}.md, docs/{ru,en}/{call-mechanics,root-runbook,instruction-other-session}.md).

## Резюме

**R1 (MAJOR из r1) закрыт**: commit принимается только как полный hex 40 — имена веток и инъекции отсекаются до git-команд; check-ref-format / rev-parse --verify прямо объявлены не-барьером; not_consolidated / not_closed введены как терминальные статусы; путь пространства проверяется префиксом; формулировка «любые мутации refs» исправлена; жизненный цикл (занятая ветка, locked) описан.

Остаточные дефекты — MINOR: (S1) SHA не привязан к фиксеру/вершине его ветки — частичный и чужой SHA проходят все четыре предписанные проверки; (S2) детектор no-op — английская строка Already up to date, а скобка «(пустая дельта)» неверна: дельта base..sha остаётся непустой; (S3) проверка префикса без канонизации путей не срабатывает на нативных формах Windows; (S4) guard'ы по-прежнему мутационно слепы. Блокирующих нет.

Guard'ы на 7ab0d82: bun test 91 pass / 0 fail, locale-check 12/12, biome 33 файла / 0.

## Эксперименты (команда → вывод)

1. Hex-гейт (как предписано: [[ $v =~ ^[0-9a-f]{40}$ ]]): ACCEPT — полные SHA A2/B1/base; REJECT — fix/r2-1, fix/x;id, 36dbc84, BC8625… (uppercase). Инъекция через commit закрыта (fail-closed на uppercase).
2. Четыре предписанные проверки (cat-file -t = commit, merge-base --is-ancestor base sha, git diff --quiet base sha rc=1, sha != base) для трёх SHA: A2 (полный фикс) — all_checks=1; **A1 (первый из двух коммитов фиксера)** — all_checks=1; **B1 (коммит другого фиксера)** — all_checks=1; base — all_checks=0 (корректно).
3. Сведение A1 при наличии A2: git merge A1 rc=0, в дереве только a.txt («a one»), файл b.txt из A2 отсутствует — половина работы перенесена, все проверки пройдены.
4. Повторное сведение того же SHA после merge: все четыре проверки снова all_checks=1 (diff_rc=1), git merge → Already up to date. rc=0, HEAD не изменился. git merge --quiet → rc=0, **пустой вывод** (детектировать нечего).
5. Проверка префикса пути: git rev-parse --show-toplevel = C:/Users/…/repo; путь внутри проекта в форме C:/Users/…/repo/wt-in → DETECTED; в формах C:\Users\…\repo\wt-in и /c/Users/…/repo/wt-in → **MISSED**, при этом git status показывает ?? wt-in/ (worktree физически внутри).
6. Мутации в копии комплекта: замена hex-нормы на «по имени ветки» в EN call-mechanics → 91 pass, 12/12; удаление префикс-клаузы preflight в RU fix-runner → 91 pass, 12/12.
7. Паритет: 0-9a-f]{40} и not_consolidated присутствуют в 4 EN-файлах и 4 RU-файлах, префикс-проверка — в root-runbook обеих локалей и fix-runner обеих; заголовки/фенсы не изменились (10 файлов, только строковые правки).
8. Остатки check-ref-format: 6 упоминаний, каждое — в форме «барьером НЕ является / резолвит имена» (orchestrator:49, call-mechanics:115, root-runbook:29, ru+en).

## Вывод по заявке

- R1 — **закрыт**: hex-40 до git-команд, запрет подстановки строк отчёта в shell, запрет имён для сведения, семантические проверки, not_consolidated / not_closed.
- R2/R7 (no-op и пустая дельта) — частично: проверки добавлены, но единственный детектор повтора — текст Already up to date, а «(пустая дельта)» противоречит факту (diff base..sha непуст и после слияния).
- R3 (worktree внутри дерева) — частично: проверка добавлена, но без канонизации путей на Windows не срабатывает.
- R5 (refs) и R6 (жизненный цикл) — закрыты: правило 11 разрешает коммит и git switch -c в своей ветке; §5 и шаг 6 описывают занятую ветку и locked (unlock / remove -f -f).
- C5 «guard'ы зелёные» — подтверждено как факт прогона; как доказательство свойств — нет (S4).

```json
{
  "schema": "redteam/v1",
  "verdict": "ready",
  "closing_list": [],
  "coverage_gaps": [
    "Окно посадки background-фиксера через session_move не воспроизведено: вложенные субагенты запрещены (subagent depth limit 1), перемещение собственной сессии не выполнялось.",
    "Инструмент харнесса worktree_create не вызывался: он создаёт worktree в аудируемом репозитории (мутация запрещена); проверен только текст нормы про немедленный git switch -c.",
    "Живой orch_uni_validate_report после перезапуска плагина не проверялся: кэш схем подтверждён в текущем процессе, свежая загрузка проверена прямым вызовом checkReport.",
    "Стенд kit-verify/kit-sync не прогонялся: инструментов в поставке нет (норма условная)."
  ],
  "claims_attacked": [
    {
      "claim": "R1 (MAJOR r1): check-ref-format как барьер и cat-file -t как ключ сведения — закрыты переходом на полный hex SHA",
      "attack": "hex-гейт на крафтовых значениях (имена, инъекции, короткий SHA, uppercase); повтор подстановки в sh -c; cat-file -t по именам веток",
      "outcome": "claim_confirmed",
      "evidence": "ACCEPT только полные SHA; REJECT: fix/r2-1, fix/x;id, 36dbc84, BC8625…UPPER. Текст: agents/ru/orchestrator.md:49 и docs/ru/call-mechanics.md:115 — commit только ^[0-9a-f]{40}$, check-ref-format/rev-parse барьером не являются, строки отчётов в shell-слова не подставлять, SHA отдельным аргументом в кавычках; 6 упоминаний check-ref-format в форме «не барьер» (ru+en)"
    },
    {
      "claim": "R2/R7: no-op и пустая дельта закрыты (not_consolidated, git diff --quiet, sha != base)",
      "attack": "повторное сведение уже влитого SHA; git merge --quiet; прогон четырёх предписанных проверок после слияния",
      "outcome": "claim_partial",
      "evidence": "После merge A1 все проверки снова проходят (cat-file=commit, is-ancestor ok, diff_rc=1, sha != base), git merge печатает Already up to date rc=0, HEAD не меняется; git merge --quiet → rc=0 и пустой вывод. Формулировка «Already up to date (пустая дельта)» неверна: дельта base..sha непуста (diff_rc=1). Единственный детектор — текст сообщения git"
    },
    {
      "claim": "R3: worktree внутри дерева проекта отсекается preflight-проверкой префикса путей",
      "attack": "worktree внутри проекта; сравнение путей в формах прямых слэшей, обратных слэшей (Windows) и MSYS /c/",
      "outcome": "claim_partial",
      "evidence": "PROJ=C:/Users/…/repo; путь C:/Users/…/repo/wt-in → DETECTED; нативная Windows-форма (обратные слэши) → MISSED; MSYS-форма /c/Users/…/repo/wt-in → MISSED; git status → ?? wt-in/ (пространство физически внутри). Канонизация путей не предписана"
    },
    {
      "claim": "Сведение переносит именно работу отчитавшегося фиксера (по commit SHA)",
      "attack": "SHA первого из двух коммитов фиксера; SHA коммита другого фиксера — прогон полной цепочки из четырёх проверок и merge",
      "outcome": "claim_partial",
      "evidence": "A1 (первый из двух коммитов) — all_checks=1, merge переносит только a.txt, b.txt из A2 отсутствует; B1 (чужой фиксер) — all_checks=1. Ни одна проверка не связывает SHA с workspace.branch/вершиной ветки"
    },
    {
      "claim": "R5 (мутации refs) и R6 (жизненный цикл: занятая ветка, locked worktree) закрыты",
      "attack": "чтение правила 11 и §5; сверка с ранее воспроизведёнными отказами git",
      "outcome": "claim_confirmed",
      "evidence": "agents/ru/fix-runner.md:30 — запрещены мутации чужих refs, коммит в свою ветку и git switch -c разрешены; docs/ru/call-mechanics.md §5 — resume в том же worktree либо явное удаление/переименование ветки, locked → unlock либо remove -f -f; root-runbook:29 повторяет"
    },
    {
      "claim": "Guard'ы зелёные (91/91, 12/12, biome 0) на 7ab0d82",
      "attack": "прогон на ревизии и в копии; мутации новой нормы и preflight-клаузы",
      "outcome": "claim_confirmed",
      "evidence": "bun test → 91 pass 0 fail; locale-check → 12/12; biome → 33 файла, 0. Мутации: hex-норма заменена на «по имени ветки» (EN) → 91/91, 12/12; префикс-клауза удалена (RU) → 91/91, 12/12"
    },
    {
      "claim": "Ревизия состояния и паритет ru/en не сдвинуты",
      "attack": "пересчёт снапшота с исключениями lab и eval/results; пофайловый grep новых токенов",
      "outcome": "claim_confirmed",
      "evidence": "orch_uni_snapshot → aggregate d4032219ae8aa7500ef1d9212176a8df8a7b9498dd907d6b7d8b26684d4a36fc, 95 файлов; hex40/not_consolidated — по 4 файла в каждой локали; заголовки и фенсы не изменились (диффы — только строки)"
    }
  ],
  "findings": [
    {
      "id": "S1",
      "severity": "MINOR",
      "location": "docs/{ru,en}/call-mechanics.md:115; docs/{ru,en}/root-runbook.md:29; agents/{ru,en}/orchestrator.md:49",
      "mechanism": "Ключ сведения (полный hex SHA) не связан с личностью фиксера и вершиной его ветки. Проверки cat-file/ancestor/diff/!=base проходят и для более раннего коммита того же фиксера (частичный перенос), и для коммита другого фиксера (чужая работа под чужим id): оба потомки base с непустой дельтой. workspace.branch в отчёте остаётся, но для сведения не используется — привязки нет.",
      "evidence": "A1=3f7126e1… (первый из двух коммитов): все четыре проверки all_checks=1; merge A1 → rc=0, в дереве только a.txt («a one»), b.txt из A2 отсутствует. B1=9ad2749e… (другой фиксер): all_checks=1.",
      "fix": "Добавить привязку: sha должен быть достижим из объявленной ветки и равен её вершине (git rev-parse refs/heads/<branch>, имя по строгому шаблону) — иначе not_consolidated; либо требовать от фиксера ветку и SHA и сверять оба."
    },
    {
      "id": "S2",
      "severity": "MINOR",
      "location": "docs/{ru,en}/call-mechanics.md:115; docs/{ru,en}/root-runbook.md:29",
      "mechanism": "Единственный детектор повторного сведения — английская строка Already up to date; при git merge --quiet вывод пуст, а все четыре семантические проверки после слияния по-прежнему проходят. Скобка «Already up to date (пустая дельта)» фактически неверна: дельта base..sha остаётся непустой, поэтому root, проверяющий «дельта непуста», зафиксирует closed при отсутствии переноса. Локализованный git даёт тот же эффект.",
      "evidence": "После merge A1: cat-file=commit, is-ancestor ok, git diff --quiet base A1 → rc=1, A1 != base, HEAD=3f7126e; git merge A1 → Already up to date., rc=0, HEAD не изменён; git merge --quiet A1 → rc=0, output пуст.",
      "fix": "Заменить текстовый детектор на проверку состояния: git merge-base --is-ancestor <sha> HEAD до merge ⇒ not_consolidated; после merge — git rev-parse HEAD == <sha> (или слияние через merge --no-ff с проверкой нового коммита); убрать неверное «(пустая дельта)»."
    },
    {
      "id": "S3",
      "severity": "MINOR",
      "location": "agents/{ru,en}/fix-runner.md:31 (правило 12); docs/{ru,en}/root-runbook.md:29",
      "mechanism": "Проверка «путь пространства не подкаталог корня проекта» задана как сравнение префиксов строк без канонизации: git rev-parse --show-toplevel возвращает путь с прямыми слэшами, а границы/пути в Windows-среде приходят с обратными или в MSYS-форме — префикс не совпадает, и worktree внутри дерева проекта проходит preflight.",
      "evidence": "PROJ=C:/Users/Owner/AppData/Local/Temp/opencode/rt-r2/repo; C:/…/repo/wt-in → DETECTED; нативная Windows-форма (обратные слэши) → MISSED; MSYS-форма /c/…/repo/wt-in → MISSED; git status → ?? wt-in/ (физически внутри).",
      "fix": "Предписать канонизацию: realpath/abspath обеих сторон, приведение разделителей и регистра (Windows), затем сравнение по компонентам пути (не строковым префиксом); при невозможности канонизации — needs_decision."
    },
    {
      "id": "S4",
      "severity": "MINOR",
      "location": "test/*.test.ts; tools/locale-check.ts",
      "mechanism": "Guard'ы не проверяют несущие нормы: замена hex-нормы на сведение по имени ветки и удаление префикс-клаузы preflight оставляют 91/91 и 12/12. Остаётся принятый в r1 риск (реестр R1/R6) — новая, более сильная формулировка норм тоже не закреплена тестом.",
      "evidence": "Копия 7ab0d82: замена Consolidation is strictly by the full hex SHA → by the branch name (EN) → 91 pass, 12/12; удаление клаузы про канонический путь (RU fix-runner) → 91 pass, 12/12; контроль в r1: удаление строки workspace из шаблона → 11/12 + 1 fail.",
      "fix": "Табличный тест несущих норм (id → обязательная подстрока в каждом носителе обеих локалей), включая hex-гейт, not_consolidated и preflight-канонизацию."
    },
    {
      "id": "S5",
      "severity": "NIT",
      "location": "docs/{ru,en}/root-runbook.md:29-30; schemas/fix-runner.v1.json",
      "mechanism": "not_consolidated введён в тексте шага 6, но не входит в перечень статусов реестра (§4) и не отражён в схеме/enum (в отличие от no_report, который хотя бы назван в root-runbook). Статус живёт в одной строке — при своде он может не попасть в артефакт summary.",
      "evidence": "grep not_consolidated → 8 файлов (4 ru + 4 en), все в одной и той же норме шага 6/§5; в §4 (таблица root → fix-runner и реестр) статуса нет; schemas/fix-runner.v1.json не менялся в 7ab0d82 (commit остаётся string|null).",
      "fix": "Добавить not_consolidated в перечень статусов §4 и в описание реестра фиксеров (наряду с no_report), зафиксировать как терминальный статус root'а."
    }
  ],
  "not_verified": [
    {
      "item": "Поведение реальной LLM-сессии fix-runner (соблюдение preflight и hex-гейта на практике)",
      "why": "Требует запуска субагента-фиксера в отдельном worktree; вложенные субагенты запрещены, запуск писал бы в аудируемый репозиторий."
    },
    {
      "item": "Поставка и работоспособность стенда kit-verify/kit-sync",
      "why": "Инструментов в репозитории нет; норма сформулирована условно."
    }
  ]
}
```
