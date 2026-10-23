# Red-team pfx (r1) — приёмочная фальсификация заявки автора

Ревизия: `c7f4231` (дерево чистое; `orch_uni_snapshot` = `07552a62…a7f`, 95 файлов — совпало с заявкой).
Метод: собственные прогоны guard'ов, мутации в копии комплекта (`%TEMP%\opencode\rt-pfx\kit`), крафтовый git-репозиторий (`%TEMP%\opencode\rt-pfx\gitlab`). Аудируемый репозиторий не менялся (кроме этого отчёта в `lab/`, исключённом из снапшота).

## Резюме

Заявка **не подтверждена по пункту D**: норма «имена веток — только после `git check-ref-format --branch`» не является барьером для строки из отчёта (символы `;`, `&&`, `|`, `>`, `#` легальны в refname и проходят проверку), а единственный ключ сведения — `git cat-file -t` — принимает **имена веток**, поэтому «сведение по commit SHA» молча сливает чужую ветку (риск R2 реестра помечен «закрывается правкой D» — не закрыт). Остальные MAJOR-пункты (A, B, C, F) на текстовом уровне закрыты; новые ограничения — MINOR/NIT, часть уже в реестре рисков как accepted.

Guard'ы зелёные (91/91, 12/12, biome 33 файла) — воспроизведено, но свойства они не проверяют: удаление и инверсия нормы §7 в RU **и** EN, удаление preflight-правила 12, подмена `session_move` на несуществующий инструмент, удаление `properties.workspace` из схемы — всё остаётся зелёным (подтверждение принятого R1/R6).

## Ключевые эксперименты (команда → вывод)

1. `git check-ref-format --branch 'fix/x;id'` → rc=0, вывод `fix/x;id`; `sh -c 'git merge --no-edit fix/x;id'` → `merge: fix/x - not something we can merge` **и** `uid=197609(Owner)…` (исполнилась вторая команда). Также rc=0: `fix/x&&id`, `fix/x|cat`, `fix/x>pwn`.
2. `git cat-file -t main` / `git cat-file -t fix/r1-2` → `commit`. Отчёт с `commit: "fix/r1-2"` (ветка другого фиксера): `git cat-file -t` = commit → `git merge --no-edit fix/r1-2` → `foreign.txt | 1 +` … `rc=0` — чужая работа приземлилась под id отчитавшегося.
3. `commit = base_commit`: `git cat-file -t <base>` = `commit` → `git merge <base>` → `Already up to date.` rc=0, `git diff --stat base..HEAD` пуст, HEAD не сдвинулся.
4. Worktree внутри дерева проекта: `git worktree add -b fix/r1-2 ./wt-in <base>` rc=0; preflight внутри — `toplevel=…/repo/wt-in`, `branch=fix/r1-2` (≠ main) ⇒ **правило 12 проходит**; в основном дереве `git status` → `?? wt-in/`, в ревизии появляется `wt-in/a.txt`.
5. Мутации guard'ов (копия комплекта): удалить §7-буллет в RU → 12/12 ok, 91 pass; то же в EN → 12/12 ok, 91 pass; инверсия EN-нормы («two writers may share the same file set») → 12/12 ok, 91 pass; удалить правило 12 (preflight) → 12/12, 91 pass; `session_move` → `space_pin` в 8 файлах → 12/12, 91 pass; удалить `properties.workspace` из схемы → 12/12, 91 pass. Контроль с зубами: удаление строки `"workspace"` из RU-шаблона отчёта → 11/12 + 1 fail.
6. Свежая загрузка схемы (`loadSchemas` + `checkReport` на c7f4231): `noWorkspace` valid=true; `workspace:"fix/r1-1"` invalid; `wsMissingBase` invalid; `commit:null` при `closed` valid=true; `commit == base_commit` valid=true.
7. Живой `orch_uni_validate_report` (схемы из кэша старта плагина): отчёт без `workspace`, `workspace` строкой, без `base_commit`, `commit:null` — все `valid:true` (подтверждение M14/R9).
8. `git worktree remove --force` при живом процессе с cwd внутри worktree (Win32) → rc=0, worktree удалён; повторный вызов → rc=128 «not a working tree».
9. Повторный `git worktree add -b fix/r1-2` → rc=255 «a branch named 'fix/r1-2' already exists»; `remove --force` на locked worktree → rc=128, нужно `-f -f`.
10. Локаль/структура: кириллицы в `agents/en`, `docs/en`, `schemas` нет; заголовки и фенсы ru/en совпадают (call-mechanics 22/22, фенсы 20/20; root-runbook 7/7, 2/2; instruction 5/5, 0/0; process-ready-loop 6/6, 2/2).
11. Вердикты r2: `empiric-r2` `"verdict":"ready"`, `invariant-r2` `"verdict":"ready"`, `"severity": "MAJOR"` — 0 в обоих.

## Вывод по заявке

- A — подтверждено: «набор файлов» присутствует во всех 10 носителях (orchestrator/fix-runner/call-mechanics/root-runbook/instruction, ru+en) и в §7 (2 буллета). `process-ready-loop` (11-й файл) нормы не несёт, но получил шаг [2a] — не противоречие.
- B — частично: норма и предзапускная проверка root'а описаны; вторая линия (правило 11 фиксера «общий файл/класс с другим писателем») не имеет входных данных — наборы соседей фиксеру не передаются (принятый риск R8).
- C — подтверждено на тексте и механизме: `session_move`/`cd`+абсолютные пути/запрет параллели, preflight 12, запрет stash/ref-мутаций, зависимости до прогонов. Окно background-фиксера не воспроизведено (см. coverage_gaps); при неудавшейся посадке preflight даёт fail-closed.
- D — **опровергнуто в части защиты**: `check-ref-format` не отсекает исполняемые символы, `cat-file -t` принимает имена веток; «сведение по SHA» молча сливает чужую ветку (R1). Дополнительно: нет проверки непустой дельты (R2), worktree внутри дерева проекта проходит preflight (R3).
- F — подтверждено: `no_report`, `budget_exceeded`, уборка `--force`, запрет слияния без отчёта присутствуют в root-runbook:29-30, call-mechanics:115; `remove --force` работает и при живом cwd.
- m2/m3/m5/m7/M11 — подтверждено: `git diff <round-base>..HEAD --stat` (call-mechanics:122, root-runbook:29), шаг [2a] в process-ready-loop обеих локалей, `workspace` в схеме и обоих шаблонах (свежая валидация: без `base_commit` — invalid), «если поставляются» для kit-verify/kit-sync.
- «Обе ready, 0 MAJOR» — подтверждено.
- C5 «guard'ы зелёные» — подтверждено как факт прогона; как доказательство свойств — нет (п. 5).

```json
{
  "schema": "redteam/v1",
  "verdict": "not_ready",
  "closing_list": ["R1"],
  "coverage_gaps": [
    "Окно посадки background-фиксера через session_move не воспроизведено: вложенные субагенты запрещены (subagent depth limit 1), перемещение собственной сессии не выполнялось (риск для харнесса). Семантика «move at the next message boundary» взята из описания инструмента, не из прогона.",
    "Инструмент харнесса worktree_create не вызывался: он создаёт worktree в аудируемом репозитории (мутация запрещена). Проверено только текстом нормы «worktree_create только с немедленным git switch -c».",
    "Живой orch_uni_validate_report после перезапуска плагина не проверялся: кэш схем подтверждён в текущем процессе, свежая загрузка проверена прямым вызовом checkReport, а не через MCP после рестарта.",
    "Стенд kit-verify/kit-sync не прогонялся: инструментов в поставке нет (норма сформулирована условно «если поставляются»)."
  ],
  "claims_attacked": [
    {
      "claim": "(A) единая безусловная норма «писатель один на рабочее пространство; не запускай двух писателей, чьи наборы файлов могут пересечься» во всех носителях ru/en + §7",
      "attack": "пофайловый grep «набор файлов|file sets?» по 10 носителям + §7; проверка на остатки старой нормы («писатели — последовательно», «единственный писатель»)",
      "outcome": "claim_confirmed",
      "evidence": "grep -c: agents/{ru,en}/orchestrator.md=3/3, agents/{ru,en}/fix-runner.md=2/2, docs/{ru,en}/call-mechanics.md=4/4, docs/{ru,en}/root-runbook.md=2/2, docs/{ru,en}/instruction-other-session.md=2/2; docs/ru/call-mechanics.md:224-225 — два буллета §7; старых формулировок нет (docs/en/call-mechanics.md:224 «single writer per workspace» — норма, не противоречие); process-ready-loop.md — 0 упоминаний нормы, но есть шаг [2a]"
    },
    {
      "claim": "(B) непересечение по файлам: «набор файлов» в границах вызова, root считает пересечение до запуска, пересечение ⇒ сериализация",
      "attack": "проверка, что набор файлов доезжает до фиксера и что вторая линия (правило 11) имеет входные данные о соседях",
      "outcome": "claim_partial",
      "evidence": "шаблон вызова содержит «Границы: набор файлов: <пути>» (docs/ru/call-mechanics.md:120, docs/ru/instruction-other-session.md:52); но agents/ru/fix-runner.md:30 требует «общий файл/класс с другим писателем — needs_decision», а наборы соседей в промпт не передаются — правило не может сработать (совпадает с принятым R8)"
    },
    {
      "claim": "(C) посадка сессии фиксера (session_move/cd+абсолютные пути, иначе параллель запрещена) + preflight (rev-parse --show-toplevel / не основная ветка), запрет stash/ref-мутаций, зависимости до прогонов",
      "attack": "поиск норм по файлам; попытка воспроизвести окно background-фиксера; проверка, что при неудачной посадке фиксер не пишет",
      "outcome": "claim_confirmed",
      "evidence": "agents/ru/fix-runner.md:31 (preflight: --show-toplevel = пространство из границ, HEAD не основная ветка и не HEAD/detached, иначе needs_decision без правок; npm ci/bun install до прогонов), :30 (запрет git stash / git checkout -b / мутаций refs); agents/ru/orchestrator.md:49 и docs/ru/call-mechanics.md:114 (session_move, иначе cd + абсолютные пути, иначе параллель запрещена); en — зеркально. Окно background-посадки не воспроизведено — coverage_gaps"
    },
    {
      "claim": "(D) основной путь git worktree add -b fix/<round>-<n> вне дерева проекта, worktree_create только с немедленным git switch -c, сведение по commit SHA (cat-file -t), check-ref-format для имён, worktree не удалять до переноса",
      "attack": "крафтовые имена веток через git check-ref-format --branch и подстановка в sh -c; cat-file -t по именам веток/базе; merge отчёта с commit = чужая ветка; worktree внутри дерева проекта + preflight; merge base SHA",
      "outcome": "claim_partial",
      "evidence": "check-ref-format rc=0 для 'fix/x;id', 'fix/x&&id', 'fix/x|cat', 'fix/x>pwn'; sh -c 'git merge --no-edit fix/x;id' исполнил id (uid=197609(Owner)); cat-file -t main / fix/r1-2 → commit; merge отчёта с commit='fix/r1-2' принёс foreign.txt (rc=0); merge base SHA → 'Already up to date' rc=0, дельта пуста; worktree ./wt-in создан rc=0, preflight прошёл (toplevel совпал, ветка ≠ main), в main появился ?? wt-in/"
    },
    {
      "claim": "(F) no_report/budget_exceeded/уборка --force/запрет слияния без отчёта",
      "attack": "поиск норм; remove --force при живом cwd процесса внутри worktree; locked worktree; повторный add -b",
      "outcome": "claim_confirmed",
      "evidence": "docs/ru/root-runbook.md:29-30 (no_report, budget_exceeded, git worktree remove --force, «частичный коммит без отчёта в основную ветку не вливается», «closed без отчёта запрещён»), docs/ru/call-mechanics.md:115; remove --force при живом cwd внутри worktree → rc=0 (Win32); НО locked worktree → rc=128 (нужно -f -f), повторный add -b → rc=255 (см. R6)"
    },
    {
      "claim": "m2/m3/m5/m7/M11 + поле workspace{branch,worktree,base_commit} в схеме и SGR-шаблонах",
      "attack": "проверка текста; свежая валидация схемы (loadSchemas+checkReport) на отчётах без workspace/без base_commit/со строкой; мутация схемы",
      "outcome": "claim_confirmed",
      "evidence": "m2: docs/ru/call-mechanics.md:122 и docs/ru/root-runbook.md:29 — git diff <round-base>..HEAD --stat; m5: docs/*/process-ready-loop.md шаг [2a]; M11: «инструменты стенда (если поставляются)» agents/ru/fix-runner.md:28; m3: schemas/fix-runner.v1.json:10-18 + agents/{ru,en}/fix-runner.md:40,62; свежая валидация: noWorkspace valid=true, workspace строкой invalid, без base_commit invalid, полный valid"
    },
    {
      "claim": "Верификация ролей r2: обе ready, 0 MAJOR",
      "attack": "чтение JSON-блоков r2-отчётов и подсчёт severity",
      "outcome": "claim_confirmed",
      "evidence": "grep severity=MAJOR → 0 в empiric-r2.md и invariant-r2.md; verdict=ready в обоих"
    },
    {
      "claim": "Guard'ы зелёные: npm test 91/91, check:locales 12/12, biome 0",
      "attack": "прогон на c7f4231 и на копии; затем мутации норм/схемы/шаблона",
      "outcome": "claim_confirmed",
      "evidence": "bun test ./test/ → 91 pass 0 fail; bun tools/locale-check.ts → 12/12 ok; biome check . → 33 файла, 0. Мутации: удаление §7-буллета в RU → 12/12+91 pass; то же в EN → 12/12+91 pass; инверсия EN-нормы → 12/12+91 pass; удаление preflight-правила 12 → 12/12+91 pass; session_move→space_pin (8 файлов) → 12/12+91 pass; удаление properties.workspace из схемы → 12/12+91 pass; контроль: удаление строки workspace из RU-шаблона → 11/12 + 1 fail"
    }
  ],
  "findings": [
    {
      "id": "R1",
      "severity": "MAJOR",
      "location": "docs/{ru,en}/call-mechanics.md:115; docs/{ru,en}/root-runbook.md:29; agents/{ru,en}/orchestrator.md:49",
      "mechanism": "Норма «имена веток из отчётов в shell не подставлять без git check-ref-format --branch (при использовании — только после валидации)» выдаёт валидацию refname за барьер подстановки. check-ref-format проверяет только синтаксис refname, а символы ; & | > # в refname легальны — строка отчёта после «валидации» исполняется как команда. Параллельно единственный ключ сведения git cat-file -t принимает не только SHA, но и любое ревизионное имя (main, fix/<n>): отчёт с commit = «ветка другого фиксера» проходит проверку типа и молча сливает чужую работу. Это ровно риск R2 реестра («молчаливый merge чужой существующей ветки»), помеченный как «open → закрывается правкой D»; правка D его не закрывает.",
      "evidence": "git check-ref-format --branch 'fix/x;id' → rc=0; sh -c 'git merge --no-edit fix/x;id' → 'merge: fix/x - not something we can merge' + 'uid=197609(Owner) gid=197121...' (выполнилась вторая команда). Также rc=0: 'fix/x&&id', 'fix/x|cat', 'fix/x>pwn'. git cat-file -t main → commit; git cat-file -t fix/r1-2 → commit; merge отчёта с commit='fix/r1-2' → 'foreign.txt | 1 +', rc=0 (чужая ветка влита под id отчитавшегося).",
      "fix": "Сведение — только по SHA: валидировать commit как ^[0-9a-f]{7,40}$ и резолвить через git rev-parse --verify --end-of-options '$sha^{commit}'; имена веток — только после ^fix/[A-Za-z0-9][A-Za-z0-9._-]*$ (не check-ref-format); всё подставлять в кавычках и после --; дополнительно проверять git merge-base --is-ancestor <sha> <branch> и что git diff --quiet <base>..<sha> ложно (дельта непуста)."
    },
    {
      "id": "R2",
      "severity": "MINOR",
      "location": "docs/{ru,en}/call-mechanics.md:115; docs/{ru,en}/root-runbook.md:29-30; schemas/fix-runner.v1.json:9",
      "mechanism": "Проверка сведения ограничена типом объекта: cat-file -t = commit проходит и для base_commit, и для уже влитого SHA; merge в этих случаях печатает 'Already up to date' с rc=0 и пустой дельтой. Нормы «дельта base..sha непуста», «SHA ≠ base_commit» и «нет Already up to date» нет; commit:null валиден для closed, workspace не в required — ключ сведения может отсутствовать. Молчаливый no-op неотличим от успешного переноса по предписанным проверкам.",
      "evidence": "git cat-file -t <base> → commit; git merge <base> → 'Already up to date.' rc=0; git rev-parse HEAD не изменился; git diff --stat base..HEAD → пусто. Свежая валидация: {commit:null, results[0].status:'closed'} → valid=true; без workspace → valid=true; commit == base_commit → valid=true.",
      "fix": "Добавить в шаг сведения обязательную проверку непустой дельты и неравенства SHA базе; для closed требовать commit (string, ^[0-9a-f]{7,40}$) и workspace в required либо явную процедуру «нет ключа ⇒ not_closed»."
    },
    {
      "id": "R3",
      "severity": "MINOR",
      "location": "agents/{ru,en}/fix-runner.md:31 (правило 12); docs/{ru,en}/root-runbook.md:29",
      "mechanism": "Preflight фиксера сверяет --show-toplevel с пространством из границ и ветку с основной, но не проверяет, что пространство вне дерева проекта. Если root (по ошибке/враждебно) передал путь внутри проекта, preflight проходит, фиксер пишет внутрь рабочего дерева: появляется дубль файлов и untracked-каталог, ревизия состояния и git add -A искажаются. Норма «вне дерева проекта» адресована только root'у и не имеет исполняемой проверки.",
      "evidence": "git worktree add -b fix/r1-2 ./wt-in <base> → rc=0; внутри: git rev-parse --show-toplevel = .../repo/wt-in (совпало с границей), --abbrev-ref HEAD = fix/r1-2 (≠ main) ⇒ preflight пройден; в основном дереве git status --porcelain → '?? wt-in/', find показывает ./wt-in/a.txt.",
      "fix": "В правило 12 добавить проверку, что канонический путь пространства не является подкаталогом корня проекта (git -C <project> rev-parse --show-toplevel и сравнение префиксов), иначе needs_decision; либо передавать в границах ожидаемый путь и сверять по нему."
    },
    {
      "id": "R4",
      "severity": "MINOR",
      "location": "test/*.test.ts; tools/locale-check.ts; schemas/fix-runner.v1.json",
      "mechanism": "Guard'ы проверяют форму (заголовки/фенсы/кириллица/число строк), а не несущие нормы и не поле workspace. Удаление и инверсия нормы §7 в RU и EN, удаление preflight-правила 12, подмена session_move на несуществующий инструмент, удаление properties.workspace из схемы — всё остаётся зелёным; ловится только удаление строки из шаблона отчёта (счётчик строк).",
      "evidence": "Копия комплекта: удаление §7-буллета (RU) → locale-check 12/12 ok, bun test 91 pass; то же EN → 12/12, 91 pass; инверсия EN-нормы ('Two writers may share the same file set…') → 12/12, 91 pass; удаление правила 12 → 12/12, 91 pass; session_move→space_pin в 8 файлах → 12/12, 91 pass; удаление properties.workspace → 12/12, 91 pass; контроль: удаление 'workspace' из agents/ru/fix-runner.md → 11/12 + 1 fail.",
      "fix": "Табличный тест несущих норм (id нормы → обязательная подстрока в каждом носителе обеих локалей) + тест, что схема fix-runner/v1 отвергает отчёт без workspace.base_commit при закрытых результатах."
    },
    {
      "id": "R5",
      "severity": "MINOR",
      "location": "agents/{ru,en}/fix-runner.md:30 (правило 11) vs :26 (правило 6); agents/{ru,en}/orchestrator.md:49",
      "mechanism": "Правило 11 запрещает «любые мутации refs», а правило 6 требует коммит ('отдельным коммитом fix-<round>'), и orchestrator предписывает git switch -c fix/<round>-<n> (создание ref). Буквальное чтение запрещает штатный путь; формально нормы противоречат друг другу, хотя по смыслу запрет нацелен на чужие refs/stash.",
      "evidence": "agents/ru/fix-runner.md:30 'запрещены git stash, git checkout -b и любые мутации refs (refs/stash общий для всех worktree)'; :26 'Если нужен коммит — отдельным коммитом'; agents/ru/orchestrator.md:49 'worktree_create — только с немедленным git switch -c fix/<round>-<n>'.",
      "fix": "Сузить формулировку: «запрещены мутации чужих refs (refs/stash, refs/heads/* других пространств); коммит в свою ветку и git switch -c в своём worktree разрешены»."
    },
    {
      "id": "R6",
      "severity": "NIT",
      "location": "docs/{ru,en}/call-mechanics.md:114-115; docs/{ru,en}/root-runbook.md:29",
      "mechanism": "Предписанный основной путь не идемпотентен: повторный git worktree add -b fix/<round>-<n> после инцидента падает (ветка уже существует), а git worktree remove --force на залоченном worktree — rc=128 (нужно -f -f). Оба состояния (ветка «занята», locked worktree) в жизненном цикле не описаны.",
      "evidence": "git worktree add -b fix/r1-2 ../wt2retry HEAD → rc=255 'fatal: a branch named fix/r1-2 already exists'; git worktree lock ../wt9; git worktree remove --force ../wt9 → rc=128 'cannot remove a locked working tree; use remove -f -f'.",
      "fix": "Добавить в §5/шаг 6: при повторном запуске — либо resume в том же worktree, либо удалить/переименовать ветку явным решением; для locked — -f -f или unlock; зафиксировать это как часть терминального состояния."
    }
  ],
  "not_verified": [
    {
      "item": "Поведение реальной LLM-сессии fix-runner при следовании правилам (соблюдение preflight, отказ от правок вне набора файлов)",
      "why": "Требует запуска субагента-фиксера в отдельном worktree; вложенные субагенты в этой сессии запрещены, а запуск писал бы в аудируемый репозиторий. Проверялся текст норм и механика git, не поведение агента."
    },
    {
      "item": "Поставка и работоспособность стенда kit-verify/kit-sync",
      "why": "Инструментов в репозитории нет (tools/ содержит только locale-check.ts); норма сформулирована условно «если поставляются», проверять нечего."
    }
  ]
}
```
