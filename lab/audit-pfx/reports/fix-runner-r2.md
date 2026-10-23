# fix-runner pfx r2 — hardening входа сведения (R1 + связанные R2/R3/R5/R6)

Раунд: `pfx-r2` (аудит pfx, релизные ворота; кандидат `c7f4231`; closing_list ред-тима = R1).
Пространство: основной чекаут `C:\project\ai\opencode-orchestrator-uni` (main), одиночный запуск — объект `workspace` в отчёте опущен.
Коммит: `7ab0d82` (10 файлов, +18/−16). Не запушен.
Механика git воспроизводилась в крафтовом репозитории `%TEMP%\opencode\fix-r2\repo` (аудируемый репозиторий не мутировался).
Стенд `kit-verify`/`kit-sync` в поставке отсутствует (`tools/` содержит только `locale-check.ts`) ⇒ `stand: unavailable`.

## Что сделано по пунктам

| id | статус | суть |
|---|---|---|
| R1 | **closed** | во всех 8 носителях нормы сведения: `commit` — только полный hex SHA (`^[0-9a-f]{40}$` до git-команд); `check-ref-format`/`rev-parse --verify` объявлены не-барьерами; SHA — отдельным аргументом в кавычках; имена веток для сведения не используются (строгий шаблон `^fix/[A-Za-z0-9][A-Za-z0-9._-]*$`); семантические проверки `cat-file -t` / `merge-base --is-ancestor` / `diff --quiet` (ложно) / `sha != base` |
| R2 | **closed** | критерий «пустая дельта / `Already up to date` ⇒ `not_consolidated`, не `closed`»; «нет `commit`/`workspace` в отчёте ⇒ `not_closed`» — прозой в шаге сведения и в шаге re-audit (схема не менялась) |
| R3 | **closed** | правило 12 фиксера: канонический путь пространства не подкаталог корня проекта (`git -C <project> rev-parse --show-toplevel` + сравнение префиксов) ⇒ `needs_decision`; в шаге 6 root'а — та же проверка на его стороне |
| R5 | **closed** | запрет refs сужен до **чужих** (`refs/stash`, `refs/heads/*` других пространств); коммит в свою ветку и `git switch -c` в своём worktree разрешены |
| R6 | **closed** | повторный запуск после инцидента: resume в том же worktree либо явное удаление/переименование ветки решением root'а; `locked` worktree — `unlock` либо `remove -f -f` |

Изменённые файлы (ru/en зеркальны, frontmatter не тронут):

- `docs/{ru,en}/call-mechanics.md:115` — норма сведения (R1, R2); `:200` (§5) — R6;
- `docs/{ru,en}/root-runbook.md:29` — сведение + путь пространства + retry/locked (R1, R2, R3, R6); `:30` — precondition `not_closed` (R2);
- `agents/{ru,en}/orchestrator.md:49` — норма сведения (R1);
- `docs/{ru,en}/instruction-other-session.md:30,:52` — норма сведения (R1, R2);
- `agents/{ru,en}/fix-runner.md:30` (правило 11) — R5; `:31` (правило 12) — R3.

## Доказательства (команда → вывод)

Крафтовый репозиторий (до правок, механизм дефекта):

```
git check-ref-format --branch 'fix/x;id'        → rc=0, вывод: fix/x;id
git cat-file -t fix/foreign                     → commit (rc=0)
git merge --no-edit fix/foreign                 → Fast-forward … foreign.txt | 1 +
                                                  create mode 100644 foreign.txt   (rc=0)
git cat-file -t <base>; git diff --quiet <base> <base>
                                                → commit; diff --quiet rc=0 (пустая дельта)
git worktree add -b fix/r3-wt ./wt-in HEAD      → rc=0; toplevel=…/repo/wt-in (совпал),
                                                  HEAD=fix/r3-wt (≠ main) ⇒ старый preflight пройден;
                                                  в основном дереве: ?? wt-in/
git worktree add -b fix/r3-wt ../wt-retry HEAD  → rc=255, a branch named 'fix/r3-wt' already exists
git worktree lock wt-in; git worktree remove --force wt-in
                                                → rc=128, cannot remove a locked working tree
```

После правок (норма-страж `norm-check.sh`, 47 проверок; PASS только при наличии жёстких норм и отсутствии старой формулировки):

```
bash …/fix-r2/norm-check.sh .                   → ALL PASS, rc=0
bash …/fix-r2/norm-check.sh <baseline c7f4231>  → 45 FAIL, rc=1
                                                  (в т.ч. все 8 R1 hex gate, 8 R2 not_consolidated,
                                                   4 R3, 6 R5, 8 R6)
```

Механизм нового барьера (тот же крафтовый репозиторий):

```
printf '%s' 'fix/x;id'     | grep -Eq '^[0-9a-f]{40}$'  → REJECT
printf '%s' 'fix/foreign'  | grep -Eq '^[0-9a-f]{40}$'  → REJECT
printf '%s' <40-hex sha>   | grep -Eq '^[0-9a-f]{40}$'  → ACCEPT
git check-ref-format --branch 'fix/x;id'                → rc=0   (не барьер)
git rev-parse --verify 'fix/foreign^{commit}'           → sha, rc=0 (не барьер)
git diff --quiet <base> <base>                          → rc=0 ⇒ not_consolidated (норма)
```

Стандартные проверки (после правок): `bun tools/locale-check.ts` → 12/12 ok (после каждого файла); `npm test` → 91 pass / 0 fail; `npx biome check .` → 33 файла, rc=0.

Отклонения/оговорки:
- в `agents/{ru,en}/fix-runner.md` нормы сведения нет (`grep` = 0) — правка R1 к нему неприменима; правила 11/12 фиксера правились по R3/R5 (явное решение владельца на правку кита в этом вызове; frontmatter не изменялся);
- схема `schemas/fix-runner.v1.json` по R2 **не** менялась: условную обязательность (`closed` ⇒ `commit`+`workspace`) сабсет не выражает, норма зафиксирована прозой (так и предписано списком).

```json
{
  "schema": "fix-runner/v1",
  "round": "pfx-r2",
  "commit": "7ab0d82",
  "results": [
    {
      "id": "R1",
      "status": "closed",
      "change": "docs/{ru,en}/call-mechanics.md:115, docs/{ru,en}/root-runbook.md:29, agents/{ru,en}/orchestrator.md:49, docs/{ru,en}/instruction-other-session.md:30,:52 — сведение только по полному hex SHA (^[0-9a-f]{40}$ до git-команд), check-ref-format и rev-parse --verify объявлены не-барьерами, SHA отдельным аргументом в кавычках, имена веток для сведения не используются (строгий шаблон ^fix/[A-Za-z0-9][A-Za-z0-9._-]*$), семантические проверки cat-file -t / merge-base --is-ancestor / diff --quiet (ложно) / sha != base",
      "before": "git check-ref-format --branch 'fix/x;id' → rc=0, вывод fix/x;id; git cat-file -t fix/foreign → commit; git merge --no-edit fix/foreign → Fast-forward foreign.txt | 1 +, rc=0 (чужая ветка влита); grep -c 'shell не подставлять без' docs/ru/call-mechanics.md → 1",
      "after": "printf '%s' 'fix/x;id' | grep -Eq '^[0-9a-f]{40}$' → REJECT; … 'fix/foreign' → REJECT; … 40-hex → ACCEPT; git check-ref-format --branch 'fix/x;id' → rc=0; git rev-parse --verify 'fix/foreign^{commit}' → sha, rc=0; grep -c 'shell не подставлять без' → 0; norm-check.sh . → ALL PASS rc=0",
      "proof": "bash %TEMP%/opencode/fix-r2/norm-check.sh <baseline c7f4231> → 45 FAIL rc=1 (8 из них — R1 hex gate во всех носителях) / bash …/norm-check.sh . → ALL PASS rc=0",
      "stand": "unavailable: стенд kit-verify/kit-sync в комплекте не поставляется (tools/ содержит только locale-check.ts)",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 91 pass / 0 fail; npx biome check . → rc=0",
      "note": "в agents/{ru,en}/fix-runner.md норма сведения отсутствует (grep=0) — правка к нему не применима; process-ready-loop.md вне класса (см. out_of_scope)"
    },
    {
      "id": "R2",
      "status": "closed",
      "change": "docs/{ru,en}/call-mechanics.md:115 и docs/{ru,en}/root-runbook.md:29 — пустая дельта / Already up to date ⇒ not_consolidated, не closed; docs/{ru,en}/root-runbook.md:30 — нет ключа commit или workspace ⇒ not_closed (precondition root'а, прозой)",
      "before": "git cat-file -t <base> → commit; git merge <base> → Already up to date, rc=0; git diff --quiet <base> <base> → rc=0 (пустая дельта); grep -c not_consolidated по 8 носителям → 0",
      "after": "норма: diff --quiet должно быть ложно, sha != base, пустая дельта ⇒ not_consolidated; grep -c not_consolidated → 1 в каждом из 8 носителей; root-runbook: нет ключа commit или workspace ⇒ not_closed",
      "proof": "norm-check.sh <baseline> → 8 FAIL 'R2 not_consolidated' rc=1 / norm-check.sh . → 8 PASS rc=0",
      "stand": "unavailable: стенд не поставляется",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 91 pass / 0 fail",
      "note": "схема fix-runner.v1.json не менялась: условную обязательность (closed ⇒ commit+workspace) сабсет не выражает — норма зафиксирована прозой, как предписано списком"
    },
    {
      "id": "R3",
      "status": "closed",
      "change": "agents/{ru,en}/fix-runner.md:31 (правило 12) — канонический путь пространства не должен быть подкаталогом корня проекта (git -C <project> rev-parse --show-toplevel + сравнение префиксов путей), нарушение ⇒ needs_decision без правок; docs/{ru,en}/root-runbook.md:29 — та же проверка префиксов на стороне root'а",
      "before": "git worktree add -b fix/r3-wt ./wt-in HEAD → rc=0; git -C wt-in rev-parse --show-toplevel → …/repo/wt-in (совпал с границей); --abbrev-ref HEAD → fix/r3-wt (≠ main) ⇒ старый preflight пройден; git status в основном дереве → ?? wt-in/",
      "after": "предписано сравнение префиксов; механизм: case \"$W/\" in \"$R\"/*) → inside: YES ⇒ needs_decision (проверено в крафтовом репо)",
      "proof": "norm-check.sh <baseline> → 4 FAIL (R3 preflight RU/EN, root prefix RU/EN) rc=1 / norm-check.sh . → 4 PASS rc=0",
      "stand": "unavailable: стенд не поставляется",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 91 pass / 0 fail",
      "note": "правка кита (agents/fix-runner.md) выполнена по явному решению владельца в этом вызове; frontmatter не тронут"
    },
    {
      "id": "R5",
      "status": "closed",
      "change": "agents/{ru,en}/fix-runner.md:30 (правило 11) — запрещены git stash и мутации чужих refs (refs/stash, refs/heads/* других пространств); коммит в свою ветку fix/<round>-<n> и git switch -c в своём worktree разрешены (git checkout -b не использовать)",
      "before": "grep 'любые мутации refs' agents/ru/fix-runner.md → 1 (буквально запрещает штатный коммит из правила 6); grep 'any ref mutations' agents/en/fix-runner.md → 1",
      "after": "grep 'мутации **чужих** refs' → 1; grep 'git switch -c` в своём worktree — разрешены' → 1; grep -c 'любые мутации refs' → 0; en: mutations of **others'** refs",
      "proof": "norm-check.sh <baseline> → 6 FAIL (R5: blanket ban RU/EN присутствует, narrowed/allowed отсутствуют) rc=1 / norm-check.sh . → 6 PASS rc=0",
      "stand": "unavailable: стенд не поставляется",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 91 pass / 0 fail",
      "note": "противоречие правила 11 с правилом 6 (коммит отдельным коммитом) снято; запрет git stash сохранён"
    },
    {
      "id": "R6",
      "status": "closed",
      "change": "docs/{ru,en}/call-mechanics.md:200 (§5) и docs/{ru,en}/root-runbook.md:29 — повторный запуск после инцидента: resume в том же worktree либо явное удаление/переименование ветки решением root'а; locked worktree — git worktree unlock либо git worktree remove -f -f",
      "before": "git worktree add -b fix/r3-wt ../wt-retry HEAD → rc=255, fatal: a branch named 'fix/r3-wt' already exists; git worktree lock wt-in; git worktree remove --force wt-in → rc=128, cannot remove a locked working tree; grep -c 'worktree unlock' по 4 носителям → 0",
      "after": "git worktree unlock wt-in → rc=0; git worktree remove -f -f wt-in → rc=0; норма присутствует в 4 носителях (unlock + remove -f -f)",
      "proof": "norm-check.sh <baseline> → 8 FAIL (R6 unlock/remove -f -f в 4 файлах) rc=1 / norm-check.sh . → 8 PASS rc=0",
      "stand": "unavailable: стенд не поставляется",
      "tests": "bun tools/locale-check.ts → 12/12 ok; npm test → 91 pass / 0 fail",
      "note": "зафиксировано как часть терминального состояния (no_report/инцидент)"
    }
  ],
  "out_of_scope": [
    {
      "note": "docs/{ru,en}/process-ready-loop.md:25,44 — «сведение веток по commit SHA» без hex-нормы",
      "why_suspicious": "файл не несёт нормы refname (класс R1 его не покрывает), но формулировка о сведении может быть усилена тем же шаблоном в следующем раунде — иначе два документа описывают сведение по-разному"
    },
    {
      "note": "R4 (guard-тесты несущих норм) не входил в список этого вызова; мутации норм/схемы по-прежнему не ловятся npm test",
      "why_suspicious": "мой norm-check.sh — внешний harness в %TEMP%, не часть комплекта; без теста в test/ регресс нормы снова пройдёт зелёным"
    },
    {
      "note": "schemas/fix-runner.v1.json: workspace не в required, commit:null валиден для closed",
      "why_suspicious": "живой orch_uni_validate_report принимает такой отчёт; условная обязательность в схеме не выражена — закрыто только прозой (R2), структурного барьера нет"
    }
  ]
}
```
