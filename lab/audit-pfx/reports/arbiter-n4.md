# Арбитр N4 — `git stash` в промпте эмпирика (спор MINOR vs out_of_scope/NIT)

Кандидат: `7ab0d82`; aggregate `d4032219ae8aa7500ef1d9212176a8df8a7b9498dd907d6b7d8b26684d4a36fc`. Разобран только пункт N4.

## Резюме

1. **Вердикт: confirmed**, severity стороны A (empiric-r2) — **MINOR**. Классификация стороны B (invariant-r2: `out_of_scope`/NIT) **опровергнута**: `out_of_scope` — не severity и не способ распорядиться находкой, а B проверяла другую локацию (`fix-runner.md:30`), механизм N4 не опровергая.
2. **Призмы:** `reproducibility` + `contract` (вердикт), `falsification` (калибровка severity: сузила окно, но не сняла дефект).
3. **Воспроизведено** (git 2.56.0.windows.2, temp-репо, все шаги `rc=0`): `refs/stash` общий для worktree — `git stash push` в main → `git stash list` в worktree даёт тот же `stash@{0}: On master: main-owned`; `git stash pop` в worktree применил чужое изменение (`modified: f.txt`, содержимое `MAIN-CHANGE`) и снял ref (`Dropped refs/stash@{0} (219e0833…)`).
4. **Контракт (решающая призма):** `agents/{ru,en}/empiric.md:19` предписывает `git stash`, а `agents/{ru,en}/empiric.md:82` того же файла запрещает менять репозиторий («Ничего не менять в аудируемом репозитории: только чтение и git-объекты»). `agents/{ru,en}/fix-runner.md:30` запрещает `git stash` ровно с обоснованием «refs/stash общий для всех worktree». Одно и то же свойство git в одном комплекте даёт **запрет одной роли и предписание другой** — внутреннее противоречие поставляемого артефакта (не вкусовщина: строка 19 противоречит строке 82 у себя же).
5. **Фальсификация:** буквальный сценарий A («параллельные роли портят друг другу состояние» через чужой `pop` в чужом worktree) из предписанных шагов не следует — фиксеру `pop` запрещён, роль-«поппер» в процессе не назначена; окно узкое. Поэтому не MAJOR. Но ущерб достижим и без кросс-worktree `pop`: (а) `git stash push` убирает из дерева **чужие** незакоммиченные правки (замер: до push `owner-edit`, после — `v1`, `git status` пуст), (б) при двух `push` подряд `pop` снимает верхнюю запись (`stash@{0}: empiric-before`, `stash@{1}: root-microfix` → после `pop` в дереве `EMPIRIC-SCRATCH`), т.е. `pop` не адресуется автору записи.
6. **Почему B не права:** invariant-r2 закрыла M7 **для fix-runner** (правило 11) — это другая локация; `empiric.md:19` она лишь пометила. `out_of_scope` по `docs/ru/root-runbook.md:29` — поле отчёта фиксера («замечено вне списка») → «включить в следующий список „к закрытию“ или эскалировать», это не severity и не закрытие. Записи `accepted-risk` по N4 в `lab/audit-pfx/risks-pfx.md` нет (grep `N4|stash|R16` пуст) — MINOR не принят владельцем, как и фиксирует мета.
7. **Итог для ship-условия:** N4 остаётся MINOR и требует либо правки (в обоих файлах заменить `git stash` на `git stash create`/`git show`/`git diff`/отдельную копию — тот же приём уже предписан фиксеру; 1 строка ×2), либо явного `accepted-risk` владельцем. Спор сведён в пользу A.

```json
{
  "schema": "arbiter/v1",
  "verdict": "resolved",
  "disputes": [
    {
      "id": "N4",
      "item": "empiric-r2: agents/{ru,en}/empiric.md:19 предписывает `git stash` для «замера до», refs/stash общий для всех worktree — MINOR. invariant-r2: M7 закрыт для fix-runner, empiric.md:19 отнесён к out_of_scope/NIT.",
      "verdict": "confirmed",
      "prism": ["contract", "reproducibility", "falsification"],
      "severity": "MINOR",
      "method": "Временный git-репозиторий (mktemp вне проекта; аудируемый репозиторий не менялся): git init + git worktree add; stash в main → git stash list и git stash pop в worktree; отдельные прогоны: stash поверх чужой незакоммиченной правки в том же дереве; два stash push подряд с pop. Плюс цитатная сверка: agents/ru/empiric.md:19 и :82, agents/en/empiric.md:19 и :82, agents/{ru,en}/fix-runner.md:30, docs/ru/root-runbook.md:29; grep 'stash' по agents/ (всего 4 вхождения: empiric.md:19 ru/en, fix-runner.md:30 ru/en); grep 'N4|stash|R16' по lab/audit-pfx/risks-pfx.md (пусто).",
      "evidence": "1) Кросс-worktree: `git stash push -q -m main-owned` в main → rc_stash_push_main=0; `git stash list` в main и в worktree → `stash@{0}: On master: main-owned` (одинаково); `git stash pop` в worktree → rc_pop_wt=0, `modified: f.txt`, `Dropped refs/stash@{0} (219e0833d4148357a9afd64cccf938ef92569db6)`, содержимое worktree f.txt = `MAIN-CHANGE`; после этого `git stash list` в main пуст (rc=0). 2) Чужие незакоммиченные правки: `printf 'owner-edit' > doc.md` → `git stash push -q -m baseline-before` → rc=0, в дереве `doc.md`=`v1`, `git status --porcelain` пуст (правка ушла из дерева); `git stash pop -q` → rc=0, `doc.md`=`owner-edit`. 3) Два push подряд: rc_push1=0 (root-microfix), rc_push2=0 (empiric-before) → `stash@{0}: …empiric-before`, `stash@{1}: …root-microfix`; `git stash pop` → rc=0, в дереве `EMPIRIC-SCRATCH`, осталось `stash@{0}: …root-microfix` (pop не адресуется автору записи). 4) Цитаты: agents/ru/empiric.md:19 \"4. Сравни с базой: git stash / git worktree / git show / отдельная копия — те же команды до и после.\"; agents/en/empiric.md:19 — зеркально; agents/ru/empiric.md:82 \"Ничего не менять в аудируемом репозитории: только чтение и git-объекты.\"; agents/ru/fix-runner.md:30 \"запрещены `git stash` и мутации **чужих** refs (`refs/stash` …)\". 5) docs/ru/root-runbook.md:29: \"поле `out_of_scope` (замечено вне списка) → включить в следующий список «к закрытию» или эскалировать\" — поле отчёта, не severity. 6) Черновик rejection стороны B: invariant-r2.md:7 \"M7 — закрыт для fix-runner (правило 11), empiric.md:19 остаётся (out_of_scope, NIT-рекомендация)\" — механизм не опровергнут, изменена только локализация/статус."
    }
  ],
  "not_verified": [
    {
      "item": "Фактическое срабатывание N4 в истории прогона pfx (кто-то реально сделал stash при чужой незакоммиченной правке или чужой pop)",
      "why": "Механизм воспроизведён на модели, но событие в живых сессиях контура арбитру недоступно (логи сессий/состояние деревьев на момент раунда не сохранены); срабатывание не заявляется — дефект подтверждён на уровне воспроизводимого механизма и контракта, не на уровне факта инцидента."
    },
    {
      "item": "Поведение на других версиях git и не-git реализациях",
      "why": "Проверено только на git 2.56.0.windows.2; свойство общих refs/stash документировано git-worktree, но иные версии не прогонялись."
    },
    {
      "item": "Синхронизация промптов в глобальном/проектном каталогах агентов и снимок config-guard",
      "why": "Вне рамок пункта N4: проверялось только содержимое файлов комплекта на кандидате 7ab0d82."
    }
  ]
}
```
