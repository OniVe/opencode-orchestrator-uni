# Свод аудита pfx

Ревизия состояния: commit `291a357` (main, дерево чистое на момент прогонов); aggregate `c407932d5e95a6e3ef9c49d953658cb9c61f6d6753354a083e876cf24d40f797` (95 файлов; исключены `lab`, `eval/results`). База диффа: `dfa4ee7`.

## Вердикты ролей (r1)

| Роль | Вердикт | MAJOR | MINOR | Отчёт |
|---|---|---|---|---|
| factcheck | stale (см. решение root) | — | — | `reports/factcheck-r1.md` |
| empiric | **not_ready** | 4 (M1–M4) | 6 MINOR (m1–m6) + 1 NIT (m7) | `reports/empiric-r1.md` |
| invariant | **not_ready** | 5 (M1–M5) | 6 (M6–M11) | `reports/invariant-r1.md` |

Решение root по factcheck: задача не устарела и не «уже сделана» (HEAD `291a357` не запушен, 0.3.0 не выпущен). Stale-пункты: (а) локальные теги — исправлено `git fetch --tags`; (б) C1/C6 — предмет аудита. Правка брифа — в `case-pfx.md`.

## Объединённые MAJOR-пункты — итог верификации/арбитража

| # | Класс | Находки ролей | Статус |
|---|---|---|---|
| A | Расхождение объёма запрета «одни файлы»: `orchestrator:48` — конъюнкция, `call-mechanics:113` — дизъюнкция; §7 молчит; 6/10 файлов молчат | empiric M3, invariant M1 | **confirmed** — взаимная воспроизведённость (обе роли, собственные прогоны) |
| B | «Непересекающиеся списки» ≠ непересекающиеся файлы; пересечение по файлам не проверяется; merge молчаливый | empiric M4, invariant M2 | **confirmed** — взаимная воспроизведённость |
| C | Нет способа посадить фиксера в worktree: у `subagent` нет параметра каталога, cwd наследуется, `session_move` в ките не упомянут | empiric M2, invariant M3 | **confirmed** — взаимная воспроизведённость |
| D | `worktree_create` → detached HEAD: ветки нет, `git merge <name>` невозможен, коммит после remove недостижим (окно — до `gc`, не гарантия) | empiric M1 | **confirmed** — верификатор invariant (независимое воспроизведение; ревизия не сдвинута) |
| E | Строки отчёта → git-команда (инъекция); merge по имени — no-op; worktree внутри проекта ломает ревизию | invariant M4 (+M9) | **partial → не подтверждена** (fail-closed). Уточнения верификатора empiric: инъекция — только при незакавыченной подстановке (в кавычках rc=1); literal-evidence «несуществующая ветка → Already up to date» опровергнут (rc=1); подтверждены механизм молчаливого слияния чужой существующей ветки и эффект worktree внутри дерева проекта. Учтено в правках D/F |
| F | Жизненный цикл прерванного фиксера/уборочная: нет терминального состояния; worktree не удаляется без `--force`, prune не берёт, ветка занята; частичный коммит может fast-forward в main | invariant M5; empiric m6 | **confirmed MAJOR** — арбитр (severity invariant): изменение ввело worktree-писателей и перенос коммитов, не закрыв жизненный цикл; цена пропуска — merge непроверенного коммита в main |
| G | Guard'ы не несут смысл норм (снятие/инверсия запрета — зелёно) | empiric M4; invariant M10 | **confirmed MINOR** — арбитр: guard'ы заявляют только форму/паритет, ослабления нет; смысловой guard — бэклог (`risks-pfx.md` R1) |

**closing_list (правки до релиза): A, B, C, D, F.**
Принятые риски/бэклог: см. `risks-pfx.md`.

## Refuted / уточнённое

- E (как заявлена) — partial, в правки не идёт; literal-evidence («несуществующая ветка → Already up to date») опровергнут; инъекция ограничена незакавыченной подстановкой; worktree-в-проекте — только при пути внутри дерева.
- G (MAJOR эмпирика) — арбитр опроверг MAJOR: несуществующий id пространства комплекта ловится (`orch_uni_ghost` → 2 fail); не ловится только чужое пространство (`worktree_create`).

## Верификация MAJOR (Фаза 3.5) — итог

- A, B, C — взаимная (обе роли) — засчитана.
- D — `confirmed` (invariant; уточнение про окно до `gc`).
- E — `partial` (empiric) → не подтверждена (fail-closed), см. выше.
- F, G — арбитр: F MAJOR, G MINOR.

## Шум аудита

- Временные артефакты ролей убраны. Остался один инертный недостижимый объект `b0d7704` (коммит верификатора D в своём worktree; tarгетно не удаляется, исторические недостижимые объекты там были и раньше) — не влияет.
- `%TEMP%\opencode\pfx-wt\probe-repo` — handle харнесса после `session_move`, вне репозитория; не влияет.
- Guard-наборы (12/12, 91/91) зелёные при опровергнутом C1 — учтено в G.

## Правки (Фаза 5) — статус

- Запущены по closing_list A, B, C, D, F (+ связанные MINOR: m1, m2, m3, m4, m5, m6, m7, M6, M7, M9, M11).
- Исполнитель: fix-runner (правки кита — предмет задачи по явному решению владельца).

## Re-audit r2 (после правок `c7f4231`)

Ревизия: commit `c7f4231`, aggregate `07552a62edd1e3f622c7d0ac5a3a89cb2d31e19e560505723114e5ab7b166a7f` (95 файлов).

| Роль | Вердикт r2 | Закрыто | Осталось |
|---|---|---|---|
| empiric | **ready** | M1–M4, m1–m7, M11; регрессий нет | новые MINOR: N1–N4 |
| invariant | **ready** | M1, M2, M3, M5, M6, M7 (механизм для fix-runner), M8, M9, M11; M4 — частично (инъекция/имя/путь закрыты) | MINOR: M10 (R1), M12–M14; NIT: M15–M17 |

**0 MAJOR у обеих ролей.** Правки: коммит `c7f4231` (13 файлов, +69/−46; `npm test` 91/91, `check:locales` 12/12, biome 0; отчёт fix-runner: `reports/fix-runner-r1.md`).

## Новые MINOR/NIT после r2 (в реестр рисков, не блокируют)

- N1/M10: schema↔template и нормы прозы не защищены тестами (удаление `workspace` из схемы или нормы §7 — зелено) — R1-бэклог.
- N2/M12: `workspace` не в `required` (условную обязательность сабсет не выражает); `commit: null` валиден для `closed`; семантическая проверка ключа сведения (SHA ≠ base, непустая дельта) не предписана — возможен молчаливый no-op.
- N3/M12: нет жёсткого критерия «пустая дельта ⇒ не сведено»; повторный merge SHA → `Already up to date` rc=0.
- M13 (invariant): стража «общий файл с другим писателем» без входных данных (наборы соседей фиксеру не передаются).
- N4 (empiric, MINOR): `agents/*/empiric.md:19` предписывает `git stash`; `refs/stash` общий для worktree — stash из main виден в чужом worktree, `pop` снимает чужую запись. Арбитр (`arbiter-n4.md`): **confirmed, MINOR**; записано как accepted-risk **R16** (митигация: окно узкое, fix-runner'у stash запрещён; бэклог — заменить на `git stash create`/дифф).
- M14: живой `orch_uni_validate_report` валидирует схемы, загруженные при старте плагина (кэш): после правки схемы нужен перезапуск плагина; в текущей сессии валидатор принимает отчёт без `workspace.base_commit`.
- M15 (NIT) — **закрыт** правкой R5 в `7ab0d82` (запрет только чужих refs; коммит в свою ветку разрешён); M16–M17 (NIT): §4 не расширен реестром фиксеров (worktree/ветка/base SHA/status); порядок `closed` в шаге 6 — приняты (R10).

## Релизные ворота

- Фаза 8 (ред-тим) — запущена на замороженном кандидате `c7f4231`.
- Далее: Фаза 6 (мета) по отчётам + свод; ship ⟺ `meta.gate`=pass ∧ closing_list пуст/закрыт ∧ coverage_gaps приняты владельцем.

## Релизные ворота — ред-тим r1 (Фаза 8): **not_ready**

- Отчёт: `reports/redteam-r1.md` (валидирован). `closing_list = ["R1"]`.
- **R1 (MAJOR, блокирует):** норма «имена веток из отчётов в shell не подставлять без `git check-ref-format --branch`» выдаёт валидацию refname за барьер подстановки: `check-ref-format` пропускает `; & | > #` (`rc=0` для `fix/x;id`), после чего `sh -c 'git merge --no-edit fix/x;id'` исполняет вторую команду (`uid=197609(Owner)`). Параллельно единственный ключ сведения `git cat-file -t` принимает не только SHA, но и имена (`main`, `fix/<n>`): отчёт с `commit = "fix/r1-2"` прошёл проверку типа и `git merge` принёс чужой `foreign.txt` (rc=0). Это ровно риск R2 реестра, помеченный «закрывается правкой D» — **не закрыт**.
- R2 (MINOR): нет критерия «непустая дельта / SHA ≠ base»; `commit: null` валиден для `closed`; `workspace` не в `required`.
- R3 (MINOR): preflight не проверяет, что пространство **вне** дерева проекта (путь внутри проходит preflight).
- R4 (MINOR): guard'ы не несут смысла норм (мутации §7/preflight/session_move/`properties.workspace` — зелено).
- R5 (NIT): «любые мутации refs» буквально запрещает коммит в свою ветку.
- R6 (NIT): повторный `worktree add -b` (ветка занята) и `remove --force` на locked worktree (`-f -f`) не описаны.
- coverage_gaps: окно посадки background-фиксера (depth limit 1); `worktree_create` не вызывался (мутация); живой валидатор после рестарта плагина; стенд kit-verify отсутствует.
- **Следующий шаг:** верификация R1 (Фаза 3.5, противоположная роль) → правки (R1; R2/R3/R5/R6 — в том же пакете как связанные) → resume ред-тима → мета.

## Верификация R1 (Фаза 3.5): **confirmed**

- Верификатор: empiric (resume; независимое воспроизведение). Обе части: (а) `check-ref-format --branch` пропускает `; & | > # $()` — некавыченная подстановка исполняет команду; (б) `cat-file -t` возвращает `commit` для имён (`main`, `fix/r1-2`, `HEAD`), отчёт с `commit="fix/r1-2"` молча вливает чужую ветку.
- Уточнение верификатора: `git rev-parse --verify '<x>^{commit}'` тоже резолвит имена — барьером не является; отсекает только строгая проверка `^[0-9a-f]{40}$`.
- Правки запущены: R1 (MAJOR) + R2/R3/R5/R6 (связанные).

## Правки r2 (ворота): commit `7ab0d82`

- Ревизия: commit `7ab0d82`, aggregate `d4032219ae8aa7500ef1d9212176a8df8a7b9498dd907d6b7d8b26684d4a36fc` (95 файлов). Диапазон `c7f4231..7ab0d82`: 10 файлов, +18/−16.
- Закрыто fix-runner'ом (отчёт `reports/fix-runner-r2.md`): **R1** — сведение строго по полному hex SHA `^[0-9a-f]{40}$` до git-команд; `check-ref-format` и `rev-parse --verify` объявлены не-барьерами; SHA — отдельным аргументом в кавычках; имена веток для сведения не используются; семантика `cat-file -t` / `merge-base --is-ancestor` / `diff --quiet` (ложно) / `sha != base`. **R2** — пустая дельта / `Already up to date` ⇒ `not_consolidated`; нет commit/workspace ⇒ `not_closed`. **R3** — preflight: пространство не подкаталог корня проекта (root + fix-runner). **R5** — запрет только чужих refs; коммит в свою ветку/`git switch -c` разрешены. **R6** — resume в том же worktree либо удаление/переименование ветки; locked → `unlock` / `remove -f -f`.
- Guard'ы: `check:locales` 12/12, `npm test` 91/91, biome 0; собственный norm-check (47 проверок) PASS на дереве / 45 FAIL на `c7f4231`.
- Не входило: R4 (смысловой guard) — MINOR/бэклог R1.

## Ред-тим r2 (Фаза 8, повтор): **ready**

- Отчёт `reports/redteam-r2.md` (валидирован). `closing_list = []`. R1 подтверждён закрытым: hex-гейт `^[0-9a-f]{40}$` (имена/инъекции/короткий SHA/uppercase → REJECT), `check-ref-format`/`rev-parse --verify` объявлены не-барьерами, `not_consolidated`/`not_closed`, префикс-проверка пути, refs сужены, жизненный цикл (занятая ветка/locked).
- Новые MINOR/NIT (не блокируют): **S1** — SHA не привязан к фикшеру/вершине ветки (первый из двух коммитов и SHA чужого фиксера проходят все четыре проверки); **S2** — no-op детектится английской строкой `Already up to date`, `merge --quiet` сигнала не даёт, формулировка «(пустая дельта)» неверна (дельта `base..sha` непуста и после слияния); **S3** — префикс-проверка без канонизации путей (`\`, MSYS `/c/`) не ловит worktree внутри проекта; **S4** — guard'ы мутационно слепы (тот же класс, бэклог R1); **S5** — `not_consolidated` не в перечне §4/реестре статусов.
- coverage_gaps (4): окно посадки background-фиксера; `worktree_create` не вызывался (мутация); живой валидатор после рестарта плагина; стенд kit-verify/kit-sync отсутствует.
- Следующий шаг: мета (Фаза 6) → при pass — ship-решение (принятие владельцем coverage_gaps и MINOR-рисков).

## Артефакты ворот (reports/)

- `arbiter-fg.md` — арбитраж F/G (`arbiter/v1`: F MAJOR, G MINOR).
- `arbiter-n4.md` — арбитраж N4 (`arbiter/v1`: confirmed, MINOR).
- `verify-D.md` — верификация D (invariant: confirmed).
- `verify-E.md` — верификация E (empiric: partial).
- `verify-R1.md` — верификация R1 (empiric: confirmed).

## Мета (Фаза 6): r1 — gate=fail, r2 — **gate=pass**

- `meta-r1` (`reports/meta-r1.md`): 9 ролевых SGR — pass; fail — свод/реестр не сведены с отчётами (N4, подсчёты m7/S5, M15/R2/R4/R5) и в `reports/` не было арбитр/верификатор-артефактов.
- Исправлено: артефакты сохранены; свод и реестр сведены; N4 → арбитраж → MINOR → R16 (accepted-risk).
- `meta-r2` (`reports/meta-r2.md`, valid=true): **gate=pass**, `closing_list = []`. 7 `coverage_gaps` — на принятие владельцем (список — в `risks-pfx.md`).
- Non-blocking замечания меты: исторические метки m7/R5; «R16 нет» в `arbiter-n4.md` (на момент арбитража); формулировка R3; `fix-runner-r2` solo (короткий SHA/без `workspace`) — R17; I12 при M12/M14; sessionID не в шапках артефактов.
- **Ship не открыт:** владелец не принял 7 `coverage_gaps` (2026-10-23) — статус `pending-owner`; публикация запрещена. Локально: `7ab0d82` (3 коммита, `origin/main` = `dfa4ee7`).

## Закрытие coverage_gaps (кандидат `476e9bd`)

- Ревизия: commit `476e9bd`, aggregate `2290e3a95eb138202cabb8701b7b7f3a484cff60725d0e75ed4895805d6913e3` (96 файлов; `lab`, `eval/results` исключены). Диапазон `7ab0d82..476e9bd` (11 файлов, +232/−13); `7b980c9` — только lab (исключён из ревизии).
- **G1 closed** — живой эксперимент: 4 дочерние сессии fix-runner, `session_move` 4/4, preflight подтвердил cwd до правок (`reports/live-experiment.md`).
- **G2 closed** — `lib/tools.ts`: схемы перечитываются на каждом `validate_report`; тест `schema freshness` (rollback → FAIL, после → PASS); живая проба: `workspace_missing_base` → `invalid`, `workspace` строкой → `invalid`, полный объект → `valid`.
- **G3 closed** — `tools/kit-verify.ts` (4/4 ok; `--proj` 12/12; rc=1/2 на негативных), script `verify:kit`; `kit-sync` удалён из 6 md-носителей (`reports/fix-runner-r3.md`).
- **G4 closed** — 4 реальные LLM-сессии fix-runner: preflight, границы файлов, запрет stash/refs, полный SHA + `workspace`.
- **G5 partial** — N=4 проверено; другие версии git/OpenCode — нет.
- **G6/G7 open** — фактическое срабатывание N4 и частота прерываний F: нет исторических логов/статистики.
- Out-of-scope fix-runner-r3: устаревший комментарий `test/support/locales.ts:3`; `tsconfig.include` без `tools/**`; README без `verify:kit` — на ревью пары.
- Следующий шаг: re-audit дельты (пара r3) → ред-тим → мета; затем принятие владельцем остатка gaps (5–7).

### Re-audit r3 (пара): расхождение вердиктов → арбитр

- **empiric**: `ready` — G2/G3 подтверждены собственными прогонами; новые MINOR/NIT: T1 (tsconfig/tools + TS2353), T2 (стенд не в npm-пакете), T3 (комментарий), T4 (README), T5 (битая схема → сырое исключение), T6 (отчёт эксперимента: 3 merge + 1 ff — поправлено).
- **invariant**: `not_ready` — 0 MAJOR; closing minimum **F2/F3**, рекомендация **F1**; NIT F4–F7 (`--proj` не ловит EN-сирот; недетерминированный вывод; комментарий; README). Инварианты I13/I15/I16 — violated; C4/I1–I12 — held. session_move-часть эксперимента им не воспроизводима (depth limit) — `not_verified`; git-часть воспроизведена.
- **Расхождение**: ready vs not_ready при 0 MAJOR → **арбитр** (F1/F2/F3: блокируют ли ship). Отчёт: `reports/arbiter-r3.md`.
- Остаток gaps (5–7) — на принятие владельцем после разрешения спора и правок.

### Арбитраж r3: F1/F2/F3 — MINOR, ship не блокируют

- `arbiter-r3.md` (valid): F1 — MINOR (contract+falsification; R18), F2 — MINOR (contract+falsification; R19) + сузить G3: «для git-чекаута, не для npm-потребителя», F3 — MINOR (reproducibility+contract; R20). Все — в риски-бэклог; doctrine: MINOR закрыть или явно принять.
- Решение root: **F1/F3/F4/F5/F6/F7 — правки** (дешёвые, в новом коде); **F2 — принять** + сузить доки (R19); затем re-audit r4 → ред-тим → мета.
- Запущен fix-runner r4 (F1: структурный отказ `E_SCHEMA_IO` + тест; F3: снять `shell`, `tools/**` в include; F4: EN-сироты; F5: детерминизм; F6: комментарий; F7: README; F2: доки).

### Правки r4: коммит `816cffa`

- Ревизия: commit `816cffa18069e105b8a2f753aafd29ffbc5b6550`, aggregate `87d0bdb4161410460ccce92a1ec5a438415b6cfaf3b61cbe2303c3d40eb6e33a` (96 файлов). Дельта `476e9bd..816cffa`: 14 файлов, +188/−42.
- F1 — `E_SCHEMA_IO` (поля directory/file) + тест на битый JSON/отсутствующий каталог; отчётные коды целы.
- F3 — мёртвая опция `shell` снята (Windows `.cmd` через `ComSpec /c`), `tools/**/*.ts` в `tsconfig.include`; `tsc --noEmit` rc=0 уже с `tools/`.
- F4 — двустороннее сравнение наборов: EN-сирота → FAIL rc=1 (в `kit-verify --proj` и self-check `locale-check`).
- F5 — вывод детерминирован (секунды убраны); F6 — комментарий; F7 — README (`check:locales`, `verify:kit`, 93 теста).
- F2 — принято (R19): в 6 носителях явно сказано, что стенд — для git-чекаута; npm-пакет не поставляет `tools/` → `stand: unavailable`.
- Guard'ы: `npm test` 93/93, `check:locales` 12/12, biome 0, tsc 0 (с tools), `kit-verify` 4/4; `--proj` 12/12, с сиротой rc=1.
- Out-of-scope r4: таблица кодов в README без `E_SCHEMA_IO`; rc=2 перегружен (usage vs «нет пар/сирот»); симлинк-файлы молча выпадают; нет таймаута у child — на ревью пары.
- Следующий шаг: re-audit r4 (пара) → ред-тим → мета.

### Re-audit r4 (пара): R1/G1 — cross-verified

- **empiric**: `ready` (R1/R2 MINOR, R3–R5 NIT; F1/F3/F4/F5/F7 подтверждены; поправка: «откат include → TS2353» не воспроизводится — ошибка устранена в коде, include доказан мутацией типа).
- **invariant**: `not_ready` — 0 MAJOR; closing minimum **G1**; NIT G2–G5; I13–I16 held.
- **R1/G1** (разрыв нормативной фразы в `docs/{ru,en}/{call-mechanics,root-runbook}`) независимо воспроизведён обеими ролями → **cross-verified**; R2/G2 (README-таблица кодов без `E_SCHEMA_IO`) — подтверждён обеими (MINOR/NIT).
- Решение root: **G1/R1 + R2/G2 + G3 (README-оговорка npm) — правки r5**; **G4/R4 (симлинки), G5/R5 (таймаут), R3 (rc=2) — приняты NIT** (R22–R24).
- Запущен fix-runner r5.

### Правки r5: коммит `2f5c581`

- Ревизия: commit `2f5c5817f9ffff68d43cab2e8bfde6b2db1a4709`, aggregate `872a2fb473fcfe50ec74a7af3f4b246f117064566af76d830868cd74bf2b630c` (96 файлов). Дельта `816cffa..2f5c581`: 6 файлов, +10/−4.
- **G1/R1** — оговорка npm/`stand: unavailable` вынесена отдельным предложением после скобки в 4 носителях; условие «только если стенд явно включён в границы» осталось внутри скобки; repro-критерий 4→0.
- **R2/G2** — `E_SCHEMA_IO` добавлен в таблицы кодов `README.md`/`README.ru.md` (поля `directory`/`file`, порядок enum).
- **G3** — в README ru/en добавлена оговорка: `verify:kit`/`check:locales` требуют git-чекаута, в npm-пакете `tools/` нет → `stand: unavailable`.
- Guard'ы: 93/93, 12/12, biome 0, tsc 0, kit-verify 4/4.
- Out-of-scope r5: package.json (поставляется) объявляет `verify:kit`/`check:locales` → в npm-пакете ENOENT (документация предупреждает); generic-перечисление кодов в README не расширено — на ревью пары.
- Следующий шаг: re-audit r5 (пара) → ред-тим → мета.

### Правки r6 (root micro): `ae6b9e4`

- `README.md`/`README.ru.md`: оговорка теперь называет команды — «`check:locales` и `verify:kit` требуют git-чекаута» (вместо позиционного «две последние») — **N1/S1 closed**. Re-audit r5: обе роли независимо воспроизвели N1/S1 (cross-verified); G1/G2/G3 подтверждены (скобка целая, `E_SCHEMA_IO` с полями, оговорка фактически верна).
- Приняты NIT: **N2/S2** (dev-скрипты в npm-пакете → ENOENT; документировано) — R25; **N3/S3** (generic-перечисление кодов без guard'а) — R26.
- Guard'ы: 12/12, 93/93, biome 0, tsc 0, kit-verify 4/4.
- Ревизия: commit `ae6b9e4`, aggregate `53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed` (96 файлов).
- Следующий шаг: re-audit r6 (пара, узкий) → ред-тим → мета.

### Re-audit r6 (пара): оба ready

- **empiric**: `ready` — N1/S1 закрыт; референт подтверждён запуском в npm-пакете (оба скрипта `Module not found`); регрессий нет; находок нет.
- **invariant**: `ready` — N1/S1 закрыт (позиционных ссылок 0, ru/en зеркальны), регрессий нет; NIT **W1** (`stand: unavailable` — поле отчёта, а в README-скобке читается как статус команд; смысл не искажён) — принято **R28**.
- Ревизия: commit `ae6b9e4`, aggregate `53dd7b96ec4c2bba1eeaa6e2f630706633f7d8e2290c80af4b69b917d708a8ed` (96 файлов).
- Следующий шаг: ред-тим r3 (дельта `7ab0d82..ae6b9e4`) → мета r3.

### Ред-тим r3 (ворота): **ready**

- `reports/redteam-r3.md` (valid): `verdict = ready`, `closing_list = []`. Воспроизведены: свежесть схем + `E_SCHEMA_IO` (живой инструмент отвергает `workspace` без `base_commit`; откат кэша валит 2 теста), `kit-verify` (kit 4/4, `--proj` good/orphan/missing/empty/usage, byte-identical), docs↔артефакт (`verify:kit`, 6 носителей, `kit-sync` 0, npm-оговорка), git-часть live-эксперимента, регрессии 93/93, 12/12, biome 0, tsc 0, kit-verify 4/4; hex-гейт/`not_consolidated` не ослаблены.
- Новые NIT/MINOR: **T1** (диагностика `--proj` для пути-файла: «no pairs» вместо «not a directory»), **T2** (дубликаты `id` схем молча перезаписываются — единственная порча реестра без `E_SCHEMA_IO`), **T3** (MINOR: схема допускает `commit: null`/короткий/uppercase для `closed`; привязка SHA к ветке — только прозой) — приняты **R29–R31** (бэклог).
- coverage_gaps ред-тима: session-часть live-experiment (depth limit); npm install не исполнялся; other versions; `worktree_create` не вызывался; частота/N4 — пересекаются с gaps 5–7 + npm-потребитель.
- Следующий шаг: мета r3.

### Закрытие остатка gaps (2026-10-23, root evidence)

- **npm-потребитель — closed**: реальный `npm pack` + `npm i` в чистый проект (11 пакетов): в установленном пакете нет `tools/`; `npm run verify:kit` и `check:locales` → `Module not found` (rc=1); оговорки `stand: unavailable` в 6 носителях и README присутствуют в поставке.
- **Другая версия git (gap 5) — closed**: WSL git **2.43.0**: `worktree add -b`, `cat-file -t <sha>`, `merge-base --is-ancestor`, `diff --quiet`, merge по SHA (rc=0), `check-ref-format --branch 'fix/x;id'` → rc=0 (пропускает `;`) — совпало с 2.56.0.
- **Session-часть — closed (независимая воспроизводимость)**: отдельная root-сессия через `opencode run --standalone` (не субагент) создала полигон, подняла fix-runner (`ses_e985edd5…`), пересадила `session_move` в `wt1`; фиксер прошёл preflight (toplevel/branch) и закоммитил `8e07610` (`probe.txt`, parent `9b269be`). Основной репозиторий не тронут.
- **Gap 6 — closed (fixer-scoped)**: в `session_message` у fix-runner-сессий pfx **0** фактических `stash push/pop/apply`; единственное обращение — `git stash list` (read-only, fix-runner r1). Упоминания в аудит-сессиях (empiric/invariant/arbiter) — воспроизведения N4/M7 в temp-каталогах. Ранняя формулировка «0 упоминаний в pfx-сессиях» (по `part`) была вакуумной — исправлено по `session_message`.
- **Gap 7 — измерено**: 10 fixer-сессий pfx (5 раундов правок + 4 live + 1 indep probe), 0 прерываний (у всех отчёты; `no_report` нет). Внешняя частота не заявляется.
- **Остаток**: другие версии OpenCode (плагин V2; в среде 2.0.26) — не тестировались; ограничение для принятия владельцем.

### Re-audit r7 (закрытие остатка): все confirmed

- **empiric**: `ready`. (1) npm-потребитель: tarball 39 записей без `tools/`, `npm i` 11 пакетов, скрипты `Module not found` rc=1, оговорки в пакете; (2) WSL git 2.43.0 совпал с 2.56.0 на 5 проверках (`check-ref-format` пропускает `;`); (3) pfx-indep: root-сессия `parent_id=null` (не субагент), дочерняя fixer-сессия `directory=…/wt1`, коммит `8e07610`; (4) у fix-runner — **0** `stash push/pop/apply`, единственное обращение — `git stash list` (r1, read-only); упоминания в аудит-сессиях — temp-воспроизведения N4/M7; (5) 10 pfx fixer-сессий — все `succeeded`, `no_report` 0.
- Новое **P1 (NIT)**: в standalone root-сессии прямой `session_move` недоступен (`No tool named session_move`), работает форма Code Mode `tools.opencode.session_move`; в 4 носителях — только «если инструмент доступен» → принято **R32** (бэклог).
- Остаток: другие версии OpenCode (V2; 2.0.26) — не тестировались.

### Мета r3: **gate=pass**

- `reports/meta-r3.md` (valid): `gate = pass`, `closing_list = []`; 13 новых SGR — valid; открытых MAJOR нет; R18–R31 сведены (closed: R18/R20/R21/R27; accepted-risk: R19, R22–R26, R28–R31). Guard'ы (93/93, 12/12, biome 0, tsc 0, kit-verify 4/4, `--proj` 12/12) перепроверены метой лично.
- **G1/G4**: закрытие принято на уровне root-доказательств — 4 реальные сессии fix-runner найдены в `session_v2`/`session_message` (каталоги wt1–wt4, preflight-команды/выводы, отчёты с `workspace`/40-hex); git-часть независимо сверена redteam-r3. Независимая воспроизводимость session-части отсутствует (depth limit) — residual gap.
- Reconciliation: coverage_gaps #4 «`worktree_create` не вызывался» в `redteam-r3.md` устарел — `verify-D` вызвал инструмент и воспроизвёл detached HEAD; live-experiment выполнен на базе `7b980c9` (preflight/session_move в дельте не менялись).
- Ship: `gate=pass` ∧ `closing_list` пуст; требуется принятие владельцем coverage_gaps (5–7, npm-потребитель, session-часть) и принятых рисков (R19, R22–R26, R28–R31).
- **Мета r5** (`reports/meta-r5.md`, valid): **gate=pass**, `closing_list = []`; gap 6 (fixer-scoped) и gap 7 (10 сессий) подтверждены по `opencode.db`; единственный оставшийся coverage gap — «другие версии OpenCode» (V2; 2.0.26), на принятие владельцем.
- Локально: HEAD `c8b66b2` (lab-only), код `ae6b9e4`; `origin/main` = `dfa4ee7`; публикация запрещена до принятия и подтверждения.
- **Владелец принял остаток и подтвердил публикацию 0.3.0 (2026-10-23)** — ship открыт.

### Релиз v0.3.0 (2026-10-23)

- Push `dfa4ee7..038eaca`; **CI — success**; **Release — success**: tag `v0.3.0` = `038eaca`, GitHub Release опубликован, notes-ref `semantic-release-v0.3.0` на origin. Release notes: 1 feature + 5 fixes.
- `@semantic-release/npm`: «Published opencode-orchestrator-uni@0.3.0 to dist-tag @latest»; реестр отдаёт версию с лагом (проверка повторяется).
- **Commitlint:** historical failure на `7b980c9` (`body-max-line-length`: строка тела >100). История после релиза не переписывается; forward-fix — новый коммит с чистым сообщением (workflow линтует только диапазон пуша).
