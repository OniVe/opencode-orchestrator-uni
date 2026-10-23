# Живой эксперимент: параллельные fix-runner в изолированных worktree

Дата: 2026-10-23. Цель — закрыть gaps 1 (окно посадки `session_move`), 4 (реальная LLM-сессия fix-runner) и частично 5 (N>3) аудита pfx. Объект — тестовый клон репозитория (не аудируемый чекаут).

## Полигон

- Клон: `%TEMP%/opencode/pfx-live/repo`, HEAD `7b980c90cfd3a5a50b2bcae88e539fcd73b3adfa` (base).
- Worktree вне дерева проекта: `../wt1..wt4`, ветки `fix/live-1..4`, база у всех — `7b980c9`.
- Задачи: каждый фиксер создаёт ровно один файл `probe-N.txt` (`probe N`), коммитит `fix: probe N`; preflight до правок (toplevel = его worktree, ветка = его ветка, не main/detached, HEAD = base).

## Сессии и посадка

| # | sessionID | session_move | preflight (факт) |
|---|---|---|---|
| 1 | `ses_e989873d3ffel4mCT1DoY3Yvhr` | ok → `.../pfx-live/wt1` | `pwd=/tmp/opencode/pfx-live/wt1`; toplevel = `C:/.../wt1`; branch `fix/live-1` |
| 2 | `ses_e989873d2ffe17AlkM3AWymX1p` | ok → `.../wt2` | toplevel = `C:/.../wt2`; branch `fix/live-2` |
| 3 | `ses_e989873bfffezCC7yVO6ZnBN8T` | ok → `.../wt3` | `pwd=/tmp/opencode/pfx-live/wt3`; toplevel = `C:/.../wt3`; branch `fix/live-3` |
| 4 | `ses_e989873bfffdtyaYyoZF47DHn4` | ok → `.../wt4` | `pwd=/tmp/opencode/pfx-live/wt4`; toplevel = `C:/.../wt4`; branch `fix/live-4` |

Все четыре сессии — дочерние (root → fix-runner), `session_move({sessionID, directory})` принят; preflight прошёл с первого раза (фиксеры имели паузу 15 c на посадку).

## Коммиты (по отчётам fix-runner)

| # | commit (40-hex) | файл | родитель | проверки |
|---|---|---|---|---|
| 1 | `a5ad80a21c4ba0acc954b2aeba66c972bd1e160f` | `probe-1.txt` | `7b980c9` | `git show --stat` — 1 файл, 1 вставка; `status` чист |
| 2 | `3b94c912a472aeb2c876ebf67168b8296fba0c7b` | `probe-2.txt` | `7b980c9` | то же; commit только `probe-2.txt` |
| 3 | `577f33fe69fffb3602517d925a6ae2ee392527b9` | `probe-3.txt` | `7b980c9` | то же |
| 4 | `8c6504422c1bde487a9add21a2f4898063dc87c7` | `probe-4.txt` | `7b980c9` | то же; JSON провалидирован `orch_uni_validate_report` → valid |

Отчёты содержат `workspace{branch, worktree, base_commit}` и полный hex SHA; `out_of_scope` пуст (у #1 — замечание среды: `aether file_write` падает `E_UNKNOWN ... C:\.aether_tmp_10840`; файл создан `write`).

## Сведение по SHA (root, тестовый клон)

Для каждого SHA до merge: `cat-file -t` = `commit`; `merge-base --is-ancestor <base> <sha>` = да; `git diff --quiet <base> <sha>` = ложно (дельта непуста); `sha != base` — да.

| шаг | pre | post | merge rc | дельта |
|---|---|---|---|---|
| 1 | `7b980c9` | `a5ad80a` | 0 | `probe-1.txt | 1 +` |
| 2 | `a5ad80a` | `0fc4dae` | 0 | `probe-2.txt | 1 +` |
| 3 | `0fc4dae` | `30cae80` | 0 | `probe-3.txt | 1 +` |
| 4 | `30cae80` | `39a1466` | 0 | `probe-4.txt | 1 +` |

Итог: `git status --porcelain` пусто; в дереве `probe-1..4.txt` с ожидаемым содержимым; история — 3 merge-коммита (probe-2/3/4) плюс fast-forward первого SHA (`a5ad80a` на main). Ни один фиксер не тронул чужой файл; пересечения наборов файлов не было; чужие worktree/refs не мутировались. (Поправка r3: ранее в отчёте было сказано «4 merge-коммита» — фактически 3 merge + 1 fast-forward.)

## Выводы по gaps

- **Gap 1 (окно `session_move`)** — **закрыт**: 4/4 дочерние сессии перемещены, preflight подтвердил cwd до первых правок.
- **Gap 4 (реальная LLM-сессия fix-runner)** — **закрыт**: 4 реальные сессии соблюли preflight, границы файлов, запрет stash/refs, отчитались полным SHA и `workspace`.
- **Gap 5 (N>3)** — **частично закрыт**: N=4 проверено (непересечение, посадка, сведение); другие версии git/OpenCode не проверялись.
- **Gap 6/7** (фактическое срабатывание N4-stash; частота прерываний F) — остаются: нет исторических логов/статистики.
