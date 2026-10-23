# Мета-аудит pfx (r1, Фаза 6) — релизные ворота 0.3.0

**Вердикт: fail (gate=fail).** Ролевые SGR проходят; блокируют несведённые артефакты ворот — свод (`reports/summary-pfx.md`) и реестр рисков (`risks-pfx.md`).

Кандидат: `7ab0d82` (HEAD, дерево чистое); aggregate `d4032219ae8aa7500ef1d9212176a8df8a7b9498dd907d6b7d8b26684d4a36fc` (95 файлов; исключены `lab`, `eval/results`); база `dfa4ee7`; раунды `291a357` → `c7f4231` → `7ab0d82`.

## 1. Проверено своими прогонами

- `git rev-parse HEAD` → `7ab0d822b71b8ce270002f4da3e359ebe2c407ba`; `git status --porcelain` → пусто; `git diff --stat c7f4231..7ab0d82` → 10 файлов, +18/−16 (совпадает с fix-runner-r2 и redteam-r2).
- `orch_uni_snapshot` с исключениями `lab`, `eval/results` → aggregate `d4032219…36fc`, 95 файлов; путей `lab/*` и `eval/results/*` в выборке — 0. Ревизия кандидата воспроизведена.
- Guard'ы на кандидате: `bun tools/locale-check.ts` → 12/12, rc=0; `bun test ./test/` → 91 pass / 0 fail / 759 expect; `npx biome check .` → 33 файла, rc=0. Это форма/паритет, не доказательство несущих норм — так и отражено (invariant M10, redteam S4, risks R1/R14).
- Hex-гейт: `grep -rl '9a-f]{40}' agents docs` → 8 файлов (4 ru + 4 en); `not_consolidated` — 8 файлов; `check-ref-format`/`rev-parse --verify` объявлены не-барьерами (6 мест). R1 закрыт по тексту — совпадает с redteam-r2.
- `agents/ru/empiric.md:19` и `agents/en/empiric.md:19` всё ещё предписывают `git stash` — N4 empiric-r2 актуален на кандидате. `tools/` содержит только `locale-check.ts` — `stand: unavailable` у fix-runner обоснован.
- `git cat-file -t b0d7704` → commit «probe fix-5…» — «шум» в своде описан верно, на aggregate не влияет.
- SGR: все 9 JSON-блоков валидны (`orch_uni_validate_report`: valid=true, warnings=[]); у empiric `rc` заполнен для всех `method=run|measure|compare_base`; у fix-runner `proof` и `stand` есть у каждого result; `self_check`/`lines_checked`/`claims_checked` заполнены без пропусков.

## 2. Итог по отчётам

| Артефакт | Результат | Основание |
|---|---|---|
| `factcheck-r1` | pass | stale-статус обоснован и разобран в брифе; evidence — команды+вывод |
| `empiric-r1` | pass | 4 MAJOR + 6 MINOR + 1 NIT, evidence по каждому; not_verified названы |
| `empiric-r2` | pass | ready, 0 MAJOR; N1–N4 с замерами; not_verified/contract_gaps названы |
| `invariant-r1` | pass | not_ready, 5 MAJOR; все 9 линий checked; сценарии с counterexample |
| `invariant-r2` | pass | ready, 12/12 held; M10/M12–M17 с замерами; линии checked |
| `fix-runner-r1` | pass | 10 results closed, proof + stand(unavailable с причиной) |
| `fix-runner-r2` | pass | 5 results closed, proof FAIL→PASS, stand обоснован |
| `redteam-r1` | pass | not_ready, R1 MAJOR; closing_list=["R1"]; крафтовые входы |
| `redteam-r2` | pass | ready, closing_list=[]; R1 закрыт атакой; S1–S5 с evidence |
| `summary-pfx.md` | **fail** | см. п. 3.1–3.4 |
| `risks-pfx.md` | **fail** | см. п. 3.5–3.6 |

Пункты контракта меты: п.5 (JSON) — 9/9 SGR `valid=true`; п.6 — в своде есть `verdict`+`verifier_role` для каждого MAJOR (A–G, R1) и раздел refuted; п.7 — `rc` у empiric и `proof` у fix-runner предъявлены; п.9 — `stand` есть/обоснован. Провал — п.1/4 (свод: N4 подменён, числа) и п.8 (SGR арбитра отсутствует).

## 3. Несоответствия (адресно)

**3.1. Свод стр. 69 + реестр R8 (стр. 14): MINOR empiric N4 потерян, подменён другим дефектом.**
Empiric-r2 N4 — «запрет ref-мутаций только у fix-runner; `agents/*/empiric.md:19` предписывает `git stash`; замер: stash из main виден в чужом worktree, `pop` применяет чужие изменения» (empiric-r2.md, finding N4). В своде под «N4/M13» описан invariant M13 (стража «общий файл с другим писателем» без входных данных) — другой дефект; R8 реестра повторяет текст M13. Заголовок свода при этом утверждает «Новые MINOR после r2 (в реестр рисков…)» (стр. 64). Итог: MINOR empiric N4 не имеет ни правки, ни `accepted-risk`; invariant-r2 относит его к out_of_scope/NIT (M7), т.е. есть неразрешённое расхождение severity. Ship-условие «риски приняты» не выполнено.

**3.2. Свод: числа/статусы не совпадают с отчётами.**
Стр. 10: «empiric … MINOR 7 (m1–m7)» — в empiric-r1 m7 = **NIT** (6 MINOR + 1 NIT). Стр. 106: S5 (в redteam-r2 — **NIT**) включён в раздел «Новые MINOR». Стр. 71: «M15–M17 (NIT): „любые мутации refs“ буквально запрещает коммит» — при этом стр. 99 фиксирует R5: в `7ab0d82` «запрет только чужих refs; коммит в свою ветку/`git switch -c` разрешены», т.е. M15 закрыт; R10 реестра (стр. 16) держит M15 открытым. Свод противоречит сам себе и отчёту redteam-r2.

**3.3. Реестр: статусы R2/R4/R5 (стр. 8, 10, 11) устарели.**
`open → закрывается правкой D / переформулировкой / правилом` — при фактах: R2 (merge по имени) закрыт hex-гейтом (8 файлов, redteam-r2; остаток no-op — это R7/R12, не R2); R4/M11 — «если поставляются» в `agents/ru/fix-runner.md:28` и `agents/en/fix-runner.md:28` (закрыто в `c7f4231`, подтверждено redteam-r1 и invariant-r2); R5/M9 — «вне дерева проекта» в 8 вхождениях RU (и 8 EN), M9 закрыт (invariant-r2). Реестр не сведён с отчётами.

**3.4. Арбитраж/верификация без сохранённого SGR.**
Свод приписывает арбитру F=MAJOR (стр. 24), G=MINOR (стр. 25), E=partial (стр. 40); invariant-r2/empiric-r2 ссылаются на «арбитр». В `reports/` нет ни одного SGR `arbiter/v1` (с `disputes[].prism`), нет и отдельных SGR верификаторов D/R1. Пункт 8 (призма) проверить нечем; статусы арбитража — ссылка на роль, а не команда+вывод. По `call-mechanics.md` §5 при недоступности арбитра решение root'а фиксируется как риск и эскалируется владельцу — записи нет. Содержательно D/R1 подтверждены (redteam-r1, invariant-r2, unreachable-коммит b0d7704), т.е. это дефект артефактов, а не выводов.

**3.5. Реестр R8: id «N4/M13» не соответствует содержанию** (описан только M13; см. 3.1). Строка с сутью empiric N4 (stash/refs) отсутствует — MINOR не принят владельцем.

**3.6. Реестр R10: M15 числится открытым**, хотя закрыт R5 в `7ab0d82` (см. 3.2); запись не сведена.

## 4. Наблюдения (вне вердикта, на ship не влияют)

- `fix-runner-r2`: `commit: "7ab0d82"` (7 hex) и отсутствие `workspace` (solo) — по норме, которую он же закрывал (`^[0-9a-f]{40}$`; «нет commit или workspace ⇒ not_closed», call-mechanics:115), его собственный отчёт не прошёл бы precondition. На механику R1 не влияет (фикс в HEAD подтверждён), но норма и артефакт несогласованы: нужно исключение solo-режима в тексте либо полный SHA/workspace в отчёте. Правка текста — вне мандата меты.
- `invariant-r2`: I12 «held» при открытых M12/M14 — формулировка инварианта шире фактической проверяемости (валидатор в текущей сессии принимает отчёт без `workspace.base_commit`). На вердикт не влияет: оба остатка записаны как MINOR (R7/R9).
- Верификатор D оставил в объектной БД аудируемого репо unreachable-коммит `b0d7704` — формально мутация git-метаданных вне temp-каталога; на дерево/aggregate не влияет (ревизия совпала), учтено в «шуме» свода.

## 5. Ship-условие (явно)

**SHIP ⟺ `meta.gate`=pass ∧ `closing_list` пуст/закрыт ∧ `coverage_gaps` приняты владельцем (запись в `risks-pfx.md`; принятие фиксируется root'ом после вердикта).**

Сейчас `gate=fail` ⇒ ship запрещён. `closing_list = []` — копия redteam-r2 (пуст); блокируют не находки ред-тима, а несводимость свода/реестра: после их правки нужна повторная мета. Даже при pass потребуется запись владельца о принятии 4 `coverage_gaps` redteam-r2 и моих ниже; в `risks-pfx.md` такой записи пока нет (ожидаемое действие root'а после вердикта, не дефект отчётов).

## 6. Что не проверял (coverage)

- Арбитраж F/G/E и верификация D/R1: отдельных SGR в `reports/` нет — независимость/призму принимал по цитатам свода и перекрёстному подтверждению redteam-r1/r2 и invariant-r2.
- Живой `orch_uni_validate_report` после перезапуска плагина: все 9 SGR провалидированы текущим (кэшированным) инстансом; свежесть схем после рестарта (M14/R9) не подтверждена.
- Поведение `worktree_create` созданием не перепроверял — мутация git-метаданных аудируемого репо; принимаю воспроизведение empiric-r1/redteam-r1.
- Реальную LLM-сессию fix-runner (соблюдение preflight/hex-гейта в поведении) не запускал: вложенные субагенты запрещены, запуск писал бы в аудируемый репо.

```json
{
  "schema": "meta/v1",
  "verdict": "fail",
  "gate": "fail",
  "closing_list": [],
  "coverage_gaps": [
    "Арбитраж F/G/E и верификация D/R1: в reports/ нет отдельных SGR (arbiter/v1 с disputes[].prism и verifier-отчётов) — независимость и призму принимал по цитатам свода и перекрёстному подтверждению redteam-r1/r2, invariant-r2.",
    "Живой orch_uni_validate_report после перезапуска плагина не проверял: все 9 SGR валидированы текущим (кэшированным) инстансом; свежесть схем после рестарта (M14/R9) не подтверждена.",
    "Поведение worktree_create (detached HEAD) не перепроверял созданием — это мутация git-метаданных аудируемого репозитория; принимаю воспроизведение empiric-r1/redteam-r1.",
    "Реальную LLM-сессию fix-runner (соблюдение preflight и hex-гейта в поведении) не запускал: вложенные субагенты запрещены, запуск писал бы в аудируемый репозиторий."
  ],
  "reports": [
    {"report": "lab/audit-pfx/reports/factcheck-r1.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/empiric-r1.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/empiric-r2.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/invariant-r1.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/invariant-r2.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/fix-runner-r1.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/fix-runner-r2.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/redteam-r1.md", "result": "pass", "violations": []},
    {"report": "lab/audit-pfx/reports/redteam-r2.md", "result": "pass", "violations": []},
    {
      "report": "lab/audit-pfx/reports/summary-pfx.md",
      "result": "fail",
      "violations": [
        {"kind": "incomplete_selfcheck", "detail": "Стр. 69: под id N4/M13 описан invariant M13, а MINOR empiric-r2 N4 (agents/*/empiric.md:19 предписывает git stash; замер: stash из main виден в чужом worktree, pop применяет чужие изменения) в своде отсутствует; заголовок стр. 64 заявляет «в реестр рисков», но в risks-pfx.md записи о stash нет. MINOR не принят как accepted-risk и не исправлен; severity-расхождение с invariant (out_of_scope/NIT) не разрешено."},
        {"kind": "incomplete_selfcheck", "detail": "Стр. 10: «empiric … MINOR 7 (m1–m7)», но в empiric-r1 m7 = NIT. Стр. 106: S5 (NIT в redteam-r2) включён в раздел «Новые MINOR». Стр. 71 держит M15 открытым, тогда как стр. 99 фиксирует закрытие R5 в 7ab0d82 (запрет только чужих refs; коммит в свою ветку разрешён); risks R10 также считает M15 открытым."},
        {"kind": "missing_evidence", "detail": "Статусы арбитража F=MAJOR (стр. 24), G=MINOR (стр. 25), E=partial (стр. 40) и верификация D/R1 приписаны арбитру/верификатору, но в reports/ нет ни одного SGR arbiter/v1 (disputes[].prism), нет и SGR верификаторов; evidence в своде — ссылка на роль, не команда+фактический вывод. Пункт 8 (призма арбитра) проверить нечем; по call-mechanics §5 при недоступности арбитра решение root'а должно фиксироваться как риск/эскалация — записи нет."}
      ]
    },
    {
      "report": "lab/audit-pfx/risks-pfx.md",
      "result": "fail",
      "violations": [
        {"kind": "other", "detail": "Статусы R2 (стр. 8), R4 (стр. 10), R5 (стр. 11) — «open → закрывается правкой D / переформулировкой / правилом» — противоречат отчётам: R2 (merge по имени) закрыт hex-гейтом ^[0-9a-f]{40}$ (8 файлов, redteam-r2); R4/M11 закрыт «если поставляются» в agents/{ru,en}/fix-runner.md:28 (c7f4231, подтверждён redteam-r1/invariant-r2); R5/M9 закрыт правилом «вне дерева проекта» (8 вхождений RU/EN, invariant-r2). Реестр не сведён с отчётами."},
        {"kind": "incomplete_selfcheck", "detail": "R8 (стр. 14) имеет id «N4/M13», но описывает только invariant M13 (стража «общий файл с другим писателем» без входных данных); суть empiric-r2 N4 (git stash в agents/*/empiric.md:19, кросс-worktree перенос) отсутствует — MINOR остаётся без accepted-risk."},
        {"kind": "other", "detail": "R10 (стр. 16) числит M15 открытым (NIT), хотя M15 закрыт правкой R5 в 7ab0d82 (redteam-r2, стр. 99 свода); запись не сведена с текущим состоянием кандидата."}
      ]
    }
  ]
}
```
