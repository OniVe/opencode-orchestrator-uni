# Эмпирический аудит pfx — re-audit (круг 7, узкий: закрытие остатка coverage_gaps)

Ревизия: `ae6b9e4` (aggregate `53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed`, 96 файлов; код не менялся).
Роль: empiric (read-only). Артефакт `pfx-indep` сохранён (по указанию), прочие temp-каталоги удалены; аудируемый репозиторий не менялся (в `git status` только `lab/`-правки root'а).

## Резюме

Все пять пунктов подтверждены: **1 confirmed, 2 confirmed, 3 confirmed, 4 confirmed, 5 confirmed**.

1. **npm-потребитель** — tarball: 39 записей (agents 16, docs 8, schemas 7, lib 3, 5 корневых файлов), `tools/` — 0; `npm i` в чистый проект ставит 11 пакетов за 3 s; в `node_modules/opencode-orchestrator-uni` нет `tools/`; `npm run verify:kit` и `npm run check:locales` → `Module not found`, rc=1; `stand: unavailable` — в 6 носителях (2/2/1/1/1/1) и обоих README, в пакете те же числа.
2. **Другая версия git** — WSL git 2.43.0 повторяет Windows 2.56.0: `worktree add -b` rc=0 (ветка `fix/x`), `cat-file -t` → `commit` rc=0, `merge-base --is-ancestor` rc=0, `git diff --quiet` rc=1 (дельта непуста), merge по SHA rc=0 (+1 файл); `check-ref-format --branch 'fix/x;id'` → rc=0 на обеих версиях.
3. **pfx-indep** — `repo` на базе `9b269be` (master), `wt1` на ветке `fix/indep`, коммит `8e07610` с parent `9b269be` и `probe.txt` (+1); `result.json` = ok:true с toplevel `…/wt1`, branch `fix/indep`, sha `8e07610…`. Root-сессия `ses_e985fb77…` — верхнеуровневая (`parent_id=null`, каталог = аудируемый репозиторий, не субагент); дочерняя fixer-сессия в БД имеет `directory = …/pfx-indep/wt1` → перемещение применилось. Нюанс: прямой вызов `session_move` упал (`No tool named session_move is currently available`), сработала форма через Code Mode; лог обрывается на upstream-ошибке, поэтому успех установлен по БД. Аудируемый репозиторий не тронут.
4. **Gap 6 (stash)** — в 29 pfx-связанных сессиях частей с `git stash` — 0; глобально в окне 2026-09-02…09-18 — 220 сессий, 18 совпадений в 12 сессиях (data_uploader, onesec_esb, report-mcp и др.); единственное `stash pop/push` — `reasoning`-часть build-сессии другого проекта.
5. **Gap 7** — pfx fixer-сессий 10 (заявленные 4 live + 5 раундов = 9, плюс отдельный `indep probe`); у всех `idle_outcome=succeeded`, `time_suspended=null`; отчёты `fix-runner-r1..r5` на месте, все статусы `closed`, статуса `no_report` — 0.

Новое: **P1 (NIT)** — документированная форма `session_move({sessionID, directory})` в standalone root-сессии недоступна напрямую (только через Code Mode); в 4 носителях стоит общая оговорка «если инструмент доступен» без указания Code-Mode формы.

## Ключевые прогоны

| Что | Команда | Результат |
|---|---|---|
| Tarball | `npm pack` + `tar -tzf` | 39 записей, `package/tools/` = 0 |
| Установка | `npm i ../*.tgz` в чистом проекте | `added 11 packages in 3s`, rc=0 |
| Скрипты у потребителя | `npm run verify:kit` / `check:locales` | `Module not found` ×2, rc=1 |
| Оговорки | `grep -c 'stand: unavailable'` | 6 носителей + README, те же числа в пакете |
| git 2.43.0 | WSL-прогон 5 проверок | 0/0/0/1/0 — как на 2.56.0 |
| check-ref-format | `'fix/x;id'` на двух версиях | `fix/x;id`, rc=0 обе |
| pfx-indep | `git log/show/worktree list`, `result.json` | база `9b269be`, ветка `fix/indep`, коммит `8e07610`, +probe.txt, ok:true |
| session_move | sqlite readonly: `session_v2` | родитель — root (`parent_id=null`), дочерняя сессия `directory=…/wt1`, succeeded |
| stash | sqlite readonly по pfx-сессиям и окну | pfx: 0; окно: 18/12; pop/push — 1 reasoning |
| fixer-сессии | sqlite readonly + отчёты | 10 сессий, все succeeded; r1..r5, все closed, no_report = 0 |

```json
{
  "schema": "empiric/v1",
  "verdict": "ready",
  "claims_checked": [
    {
      "claim": "1. npm-потребитель: tarball не содержит tools/; установка в чистый проект проходит",
      "method": "run",
      "command": "npm pack --pack-destination <temp>; tar --force-local -tzf *.tgz; npm i ../*.tgz в чистом temp-проекте",
      "rc": "0",
      "result": "tarball: 39 записей — agents 16, docs 8, schemas 7, lib 3, index.ts, package.json, README.md, README.ru.md, LICENSE; записей package/tools/ — 0 (grep rc=1); npm i → added 11 packages in 3s, rc=0",
      "verdict": "confirmed"
    },
    {
      "claim": "1. В установленном пакете нет tools/, оба скрипта падают Module not found (rc=1)",
      "method": "run",
      "command": "ls node_modules/opencode-orchestrator-uni; npm run verify:kit; npm run check:locales (в каталоге пакета)",
      "rc": "1",
      "result": "состав: LICENSE, README.md, README.ru.md, agents, docs, index.ts, lib, package.json, schemas; tools → No such file or directory (rc=2); verify:kit → error: Module not found tools/kit-verify.ts, rc=1; check:locales → error: Module not found tools/locale-check.ts, rc=1",
      "verdict": "confirmed"
    },
    {
      "claim": "1. Оговорки stand: unavailable присутствуют в 6 носителях и README внутри пакета",
      "method": "run",
      "command": "grep -c stand: unavailable по 8 файлам в установленном пакете и в репозитории",
      "rc": "0",
      "result": "пакет: agents/ru/fix-runner.md=2, agents/en/fix-runner.md=2, docs/ru/call-mechanics.md=1, docs/en/=1, docs/ru/root-runbook.md=1, docs/en/=1, README.md=1, README.ru.md=1; в репозитории те же числа; README пакета содержит строку с check:locales и verify:kit (1)",
      "verdict": "confirmed"
    },
    {
      "claim": "2. WSL git 2.43.0: worktree add -b, cat-file -t, merge-base --is-ancestor, diff --quiet, merge по SHA — как на Windows 2.56.0",
      "method": "run",
      "command": "wsl.exe -e bash -lc (init repo; git worktree add -b fix/x; commit; cat-file -t; merge-base --is-ancestor; git diff --quiet; git merge <sha>)",
      "rc": "0",
      "result": "git 2.43.0: add-b rc=0 (Preparing worktree (new branch fix/x), HEAD на fix/x); cat-file -t → commit rc=0; merge-base --is-ancestor rc=0; git diff --quiet rc=1 (дельта непуста); merge по SHA rc=0 (1 file changed, 1 insertion, create mode 100644 probe.txt)",
      "verdict": "confirmed"
    },
    {
      "claim": "2. check-ref-format --branch fix/x;id → rc=0 на обеих версиях",
      "method": "run",
      "command": "git check-ref-format --branch fix/x;id (win 2.56.0 и WSL 2.43.0)",
      "rc": "0",
      "result": "обе версии: вывод fix/x;id, rc=0 — метасимволы проходят валидацию (как зафиксировано в R1 ранее)",
      "verdict": "confirmed"
    },
    {
      "claim": "2. Сравнение версий: поведение совпадает",
      "method": "compare_base",
      "command": "git --version (win) vs wsl git --version; одна и та же последовательность в обоих репозиториях",
      "rc": "0",
      "result": "win: git version 2.56.0.windows.2; WSL: git version 2.43.0; все пять проверок дали одинаковые коды (0/0/0/1/0) и одинаковые сообщения",
      "verdict": "confirmed"
    },
    {
      "claim": "3. pfx-indep: repo base 9b269be, wt1 branch fix/indep, commit 8e07610 parent 9b269be, probe.txt",
      "method": "run",
      "command": "git -C pfx-indep/repo log -1; git -C pfx-indep/wt1 rev-parse --abbrev-ref HEAD; git log -1 --format=<H parent=P>; git show --stat; git worktree list",
      "rc": "0",
      "result": "repo HEAD=9b269be13987f82c4c8f337642b4e4acd0458a47 (base, ветка master); wt1: branch fix/indep, HEAD=8e07610237f87734b384b36dabcaa3fbc9326a29, parent=9b269be, probe.txt +1; worktree list: repo 9b269be [master], wt1 8e07610 [fix/indep]",
      "verdict": "confirmed"
    },
    {
      "claim": "3. result.json: ok:true с toplevel/branch/sha",
      "method": "run",
      "command": "cat pfx-indep/result.json",
      "rc": "0",
      "result": "ok:true, toplevel C:/Users/Owner/AppData/Local/Temp/opencode/pfx-indep/wt1, branch fix/indep, sha 8e07610237f87734b384b36dabcaa3fbc9326a29, msg fix: indep",
      "verdict": "confirmed"
    },
    {
      "claim": "3. session_move применён root-сессией (не субагентом), сессия реально в wt1",
      "method": "run",
      "command": "sqlite readonly: session_v2 по дочерней сессии и её родителю; чтение /tmp/opencode/oc-indep.out",
      "rc": "0",
      "result": "родитель ses_e985fb77bffeQOfut24zhju6cr: parent_id=null, directory=C:/project/ai/opencode-orchestrator-uni (root-сессия, не субагент), idle_outcome=succeeded; дочерняя ses_e985edd5dffe39QSIYm1AO0ZCr: agent=fix-runner, directory=C:/…/pfx-indep/wt1, idle_outcome=succeeded → перемещение применилось. В логе прямой вызов session_move упал (No tool named session_move is currently available), затем вызов через Code Mode; лог обрывается на Upstream request failed — успех подтверждён состоянием БД, а не логом",
      "verdict": "confirmed"
    },
    {
      "claim": "3. Основной (аудируемый) репозиторий не тронут",
      "method": "run",
      "command": "git status --porcelain в C:/project/ai/opencode-orchestrator-uni",
      "rc": "0",
      "result": "в рабочем дереве только M lab/audit-pfx/reports/summary-pfx.md и M lab/audit-pfx/risks-pfx.md (правки root'а, lab исключён из ревизии); кода и доков изменений нет",
      "verdict": "confirmed"
    },
    {
      "claim": "4. Gap 6: в pfx-сессиях нет git stash",
      "method": "run",
      "command": "sqlite readonly: part WHERE session_id IN (pfx-сессии по directory: opencode-orchestrator-uni, pfx-live, pfx-indep) AND data LIKE %git stash%",
      "rc": "0",
      "result": "pfx-связанных сессий 29 (все роли); частей с git stash — 0; с git stash pop/push — 0",
      "verdict": "confirmed"
    },
    {
      "claim": "4. Gap 6: 18 совпадений в 12 сессиях других проектов (2026-09-02…09-18)",
      "method": "run",
      "command": "sqlite readonly: сессии в окне 2026-09-02..2026-09-19, затем count(part) по каждой с LIKE %git stash%",
      "rc": "0",
      "result": "сессий в окне 220; совпадений 18 в 12 сессиях: data_uploader (1), onesec_esb (10), report-mcp (1) и др.; даты 2026-09-02T08:14 … 2026-09-18T12:40 — совпадает с заявкой",
      "verdict": "confirmed"
    },
    {
      "claim": "4. Gap 6: единственное stash pop/push — reasoning другой сессии",
      "method": "run",
      "command": "sqlite readonly: part WHERE data LIKE %git stash pop% OR %git stash push%; разбор поля type в JSON",
      "rc": "0",
      "result": "1 строка: session ses_f5295cab7ffeGCTWJw9MMK23Ly, type=reasoning, agent=build, проект C:/project/ai/report-mcp (read_report_file/write_report_file через потоки)",
      "verdict": "confirmed"
    },
    {
      "claim": "5. Gap 7: fixer-сессии pfx — 9 (4 live + 5 раундов), 0 прерываний",
      "method": "run",
      "command": "sqlite readonly: session_v2 WHERE agent IN (fix-runner, uni.fix-runner) и directory в pfx-областях",
      "rc": "0",
      "result": "10 pfx-связанных fixer-сессий: 5 раундов (Правки по closing_list pfx A,B,C,D,F; Правки R1/R2/R3/R5/R6 pfx ворота; Стенд kit-verify + свежие схемы gaps 2/3; Правки r4; Правки r5) + 4 live (wt1..wt4) + 1 indep probe; у всех idle_outcome=succeeded, time_suspended=null → 0 прерываний",
      "verdict": "confirmed"
    },
    {
      "claim": "5. Gap 7: все раунды с отчётами, no_report нет",
      "method": "run",
      "command": "ls lab/audit-pfx/reports/fix-runner-r*.md; подсчёт статусов и schema в каждом; поиск статуса no_report",
      "rc": "1",
      "result": "отчёты r1..r5 существуют; в каждом schema=fix-runner/v1 и все статусы closed (10/5/2/7/3); совпадений статуса no_report — 0 (rc=1); 4 live-сессии отражены в live-experiment.md",
      "verdict": "confirmed"
    }
  ],
  "modes_measured": [
    {
      "operation": "объявленные tools-скрипты у потребителя",
      "regimes": [
        "git-чекаут",
        "npm-пакет (npm i из tarball)"
      ],
      "best": "чекаут: kit-verify 4/4 rc=0",
      "worst": "пакет: verify:kit и check:locales → Module not found, rc=1; tools/ отсутствует",
      "budget_claim": null,
      "measured": "tarball 39 записей без tools/; установка 11 пакетов за 3 s; скрипты объявлены в package.json пакета"
    },
    {
      "operation": "git-механика сведения на двух версиях",
      "regimes": [
        "Windows git 2.56.0.windows.2",
        "WSL git 2.43.0"
      ],
      "best": "обе версии: add -b rc=0, cat-file rc=0, ancestor rc=0, diff --quiet rc=1, merge по SHA rc=0",
      "worst": "различий не обнаружено",
      "budget_claim": null,
      "measured": "5 проверок × 2 версии — коды совпали; check-ref-format для fix/x;id rc=0 на обеих"
    }
  ],
  "self_check": [
    {
      "item": 1,
      "title": "Минимальное воспроизведение",
      "status": "applied",
      "note": "npm pack + npm i в чистый проект + запуск скриптов; WSL-репозиторий для git-механики; sqlite-запросы к opencode.db в режиме readonly"
    },
    {
      "item": 2,
      "title": "Замер числом",
      "status": "applied",
      "note": "39 записей tarball (0 tools/); 11 пакетов/3 s; 29 pfx-сессий; 18/12 совпадений stash; 220 сессий в окне; 10 fixer-сессий; 5 отчётов"
    },
    {
      "item": 3,
      "title": "Пересчёт замеров автора",
      "status": "applied",
      "note": "Совпали: отсутствие tools/ в пакете, Module not found rc=1, 18/12 stash, единственный pop/push в reasoning, 4+5 fixer-сессий; уточнения: найдена 10-я сессия (indep probe) и недоступность прямой формы session_move"
    },
    {
      "item": 4,
      "title": "Сравнение с базой",
      "status": "applied",
      "note": "git 2.43 vs 2.56; pfx-indep относительно базы 9b269be; состав пакета относительно репозитория"
    },
    {
      "item": 5,
      "title": "Факты окружения из команд",
      "status": "applied",
      "note": "git 2.56.0.windows.2 и 2.43.0, WSL2 6.6.87.1, npm i 3 s, размер opencode.db 39 977 861 120 байт"
    },
    {
      "item": 6,
      "title": "Первоисточники",
      "status": "applied",
      "note": "схема БД (session_v2/part/message), содержимое tarball, git-объекты pfx-indep, лог oc-indep.out, отчёты fix-runner-r1..r5"
    },
    {
      "item": 7,
      "title": "Прототип в нескольких режимах",
      "status": "applied",
      "note": "потребитель: чекаут vs пакет; git: две версии; доказательство move: лог vs состояние БД"
    },
    {
      "item": 8,
      "title": "Крайние значения",
      "status": "applied",
      "note": "пакет без tools/; fix/x;id в check-ref-format; обрыв лога на upstream-ошибке; окно 2026-09-02..18"
    },
    {
      "item": 9,
      "title": "Оценки без замера",
      "status": "applied",
      "note": "все пять пунктов пересчитаны прогонами; числовых бюджетов в заявках нет"
    },
    {
      "item": 10,
      "title": "«Уже учтено» закрыто везде",
      "status": "applied",
      "note": "stand: unavailable — 6 носителей + README (в пакете те же числа); статус no_report — 0 в отчётах fixer'ов"
    },
    {
      "item": 11,
      "title": "Сверка с эталоном",
      "status": "applied",
      "note": "эталон git-механики — Windows 2.56.0: та же последовательность на 2.43.0 дала те же коды"
    },
    {
      "item": 12,
      "title": "Детерминизм и границы",
      "status": "applied",
      "note": "SQL-выборки детерминированы (окно по времени + directory); повторные guard-прогоны ранее стабильны"
    },
    {
      "item": 13,
      "title": "Паритет входов и счётные крайности",
      "status": "applied",
      "note": "одна git-операция на двух версиях и платформах; две формы вызова session_move (прямая недоступна, Code Mode применилась)"
    },
    {
      "item": 14,
      "title": "Сквозная доставка полей",
      "status": "applied",
      "note": "оговорка npm доезжает до пакета; session_move доезжает до фактического cwd сессии (БД); ограничение прямой формы в доке не отражено — P1"
    },
    {
      "item": 15,
      "title": "Непроверенное не как факт",
      "status": "applied",
      "note": "успех session_move в логе не виден (обрыв) — установлен по БД и помечен как таковой"
    },
    {
      "item": 16,
      "title": "Дисциплина rc",
      "status": "applied",
      "note": "rc: pack 0, tar 0, npm i 0, ls 2, скрипты 1, git-проверки 0/0/0/1/0, grep 1, sqlite 0"
    },
    {
      "item": 17,
      "title": "Дифференциальный фазз",
      "status": "applied",
      "note": "фазз не применим к артефактам; вместо него дифференциал «две версии git» и «чекаут vs пакет»"
    },
    {
      "item": 18,
      "title": "Тесты — объект аудита",
      "status": "applied",
      "note": "эти пункты не покрыты поставляемыми тестами (внешние артефакты); вывод опирается на прогоны, а не на зелёный набор"
    },
    {
      "item": 19,
      "title": "База без git",
      "status": "not_applicable",
      "note": "история доступна; pfx-indep имеет свою базу 9b269be"
    }
  ],
  "findings": [
    {
      "id": "P1",
      "severity": "NIT",
      "location": "agents/*/orchestrator.md:49, docs/*/call-mechanics.md:114, docs/*/root-runbook.md:29, docs/*/instruction-other-session.md:30",
      "mechanism": "Документы называют форму session_move({sessionID, directory}), но в standalone root-сессии прямого инструмента с таким именем нет: вызов падает с No tool named session_move is currently available, и перемещение удаётся только через Code Mode (tools.opencode.session_move). Оговорка «если инструмент доступен» технически покрывает случай, но не подсказывает рабочую форму — root может счесть инструмент недоступным и уйти в fallback cd + абсолютные пути.",
      "evidence": "/tmp/opencode/oc-indep.out: вызов session_move с directory …/wt1 и sessionID ses_e985edd5dffe39QSIYm1AO0ZCr завершился failed — Error: No tool named session_move is currently available; далее шаг execute с tools.opencode.session_move; session_v2: directory дочерней сессии = C:/…/pfx-indep/wt1, idle_outcome=succeeded",
      "fix": "В 4 носителях добавить: если прямого инструмента нет — вызови через Code Mode (tools.opencode.session_move({sessionID, directory}))."
    }
  ],
  "contract_gaps": [
    {
      "item": "Поверхность доступности session_move",
      "where": "docs/*/call-mechanics.md §2/§5 (формы вызова)",
      "why": "не задано, что инструмент может быть доступен только через Code Mode; «если доступен» не различает прямую и Code-Mode формы"
    }
  ],
  "not_verified": [
    {
      "item": "Успех session_move по логу oc-indep.out",
      "why": "лог обрывается на Upstream request failed; успех установлен по состоянию БД (session_v2.directory), а не по логу"
    },
    {
      "item": "Другие версии git/OpenCode и другие ОС",
      "why": "проверены только git 2.56.0 (win) и 2.43.0 (WSL), OpenCode 2.0.26"
    }
  ]
}
```

## Поправка (r5, root)

Ранняя формулировка claim 4 («0 упоминаний `git stash` в 29 pfx-сессиях», запрос по `part`) вакуумна: v2-сессии лежат в `session_message` (`part` для них пуст). Корректно: у 10 fixer-сессий pfx — **0** фактических `stash push/pop/apply`; единственное обращение — `git stash list` (fix-runner r1, read-only); упоминания в аудит-сессиях (empiric/invariant/arbiter) — воспроизведения N4/M7 в temp-каталогах. Claim 5: счёт унифицирован — **10** fixer-сессий (5 раундов + 4 live + 1 indep probe), 0 прерываний (`no_report` 0). Подтверждено метой r5 по `opencode.db`.
