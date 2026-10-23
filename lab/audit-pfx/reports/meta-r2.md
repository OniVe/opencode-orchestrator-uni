# Мета-аудит pfx (r2, Фаза 6) — релизные ворота 0.3.0

**Вердикт: pass (gate=pass).** Все 16 артефактов проходят: 9 ролевых SGR, 2 арбитра, 3 верификации, свод и реестр. MAJOR закрыты/верифицированы, `closing_list` пуст. Ship — после записи владельца о принятии `coverage_gaps`.

Кандидат: `7ab0d82` (HEAD, дерево чистое); aggregate `d4032219ae8aa7500ef1d9212176a8df8a7b9498dd907d6b7d8b26684d4a36fc` (95 файлов; исключены `lab`, `eval/results`); база `dfa4ee7`; раунды `291a357` → `c7f4231` → `7ab0d82`. Ревизия не сдвинулась с r1.

## 1. Перепроверка замечаний r1 (1–4)

1. **Свод — исправлено.** Таблица r1: empiric = 4 MAJOR + 6 MINOR (m1–m6) + 1 NIT (m7) — совпадает с empiric-r1. Раздел называется «Новые MINOR/NIT», S5 в нём (в redteam-r2 — NIT, R15 — NIT). M15 помечен закрытым правкой R5 в `7ab0d82` (свод и R10); N4 выделен отдельной строкой от M13. Проверено: `agents/ru/fix-runner.md:30` — «запрещены … мутации **чужих** refs; коммит в свою ветку … разрешены»; `agents/ru/empiric.md:19` — stash (N4), M13 — отдельная стража.
2. **Реестр — исправлено.** R2 = **closed** (`7ab0d82` hex-гейт), R4 = **closed** (`c7f4231` «если поставляются», `agents/{ru,en}/fix-runner.md:28`), R5 = **closed** (правило «вне дерева проекта», 8 вхождений RU/EN). R8 = M13; R10: M15 closed, M16–M17 accepted; R16 = N4 accepted-risk с митигацией и бэклогом. Открытых `open` в таблице нет.
3. **Артефакты — добавлены и валидны.** `arbiter-fg.md` и `arbiter-n4.md` — `arbiter/v1` `valid=true`; в каждом `disputes` есть `prism` из enum: F [reproducibility, contract], G [falsification, contract], N4 [contract, reproducibility, falsification]. `verify-D/E/R1` — формат `{id, verifier_role, verdict, evidence}` (отдельной verifier-схемы в комплекте нет), JSON парсится, в evidence — команды и фактические выводы. Независимость проверена по `session_v2`: verify-D = `ses_e991c9e82ffeE4urareo0f2SPD`, agent **invariant**; verify-E и R1 = `ses_e991c9e83ffeZsPVqsOYAM60AL`, agent **empiric**; арбитры F/G = `ses_e9913c5c7ffeEwfNMA1YzxzVLS` и N4 = `ses_e98d8fec3ffeaU7T7SQzJmWMij`, оба agent **arbiter**; все — дочерние root `ses_ebdc0cba6ffdJ3HR1qBEb50kSr`, т.е. верификаторы — сессии противоположной роли (resume), не авторы находок. Фейковый id даёт `E_INTERNAL` — проверка различает существование.
4. **N4 — разрешено.** `arbiter-n4.md`: `confirmed`, severity **MINOR**, prism contract/reproducibility/falsification; возражение invariant (out_of_scope/NIT) опровергнуто (empiric.md:19 противоречит empiric.md:82; out_of_scope — поле отчёта фиксера, не severity). В реестре — R16 `accepted-risk` (владелец), митигация и бэклог записаны.

## 2. Что перепроверено своими прогонами (r2)

- `git rev-parse HEAD` → `7ab0d822b71b8ce270002f4da3e359ebe2c407ba`; `git status --porcelain` пуст; `git diff --stat c7f4231..7ab0d82` → 10 файлов, +18/−16.
- `orch_uni_snapshot` (исключены `lab`, `eval/results`) → `d4032219…36fc`, 95 файлов; новых путей нет.
- Guard'ы на кандидате: `bun tools/locale-check.ts` → 12/12, rc=0; `bun test ./test/` → 91 pass / 0 fail / 759 expect; `npx biome check .` → 33 файла, rc=0. Как доказательство несущих норм не используются (invariant M10, redteam S4, R1/R14).
- Закрытия: `grep -rl '9a-f]{40}' agents docs` → 8 файлов (4 ru + 4 en); `grep -rn 'stash' agents/` → 4 строки (empiric:19 ru/en, fix-runner:30 ru/en); `grep -rn 'outside the project tree'` → 8; `agents/en/fix-runner.md:28` — «if shipped».
- `arbiter-fg` метод/evidence сверены с git: `git show 291a357:schemas/fix-runner.v1.json` → status enum без «отчёта нет»; `git show 291a357:docs/ru/root-runbook.md:29` → только needs_decision/not_closed/out_of_scope; `git cat-file -t b0d7704` → commit (верификатор D, unreachable; aggregate не изменился).
- 9 ролевых SGR — `orch_uni_validate_report` `valid=true`, warnings=[]; arbiter-fg/n4 — `valid=true`; verify-* JSON — parse ok.
- Из 4 `coverage_gaps` redteam-r2 пункт «`worktree_create` не вызывался» **снят** `verify-D`: инструмент вызван, detached HEAD/потеря коммита воспроизведены, путь вне проекта.

## 3. Итог по артефактам

| Артефакт | Результат | Основание |
|---|---|---|
| 9 ролевых SGR (factcheck, empiric r1/r2, invariant r1/r2, fix-runner r1/r2, redteam r1/r2) | pass | схемы valid; evidence, rc, proof/stand, self-check/lines заполнены |
| arbiter-fg, arbiter-n4 | pass | `arbiter/v1` valid; disputes с verdict/prism/method/evidence/not_verified |
| verify-D, verify-E, verify-R1 | pass | `{id, verifier_role, verdict, evidence}`; команды+выводы; независимость сессий проверена |
| summary-pfx.md | pass | статусы всех MAJOR (A–G, R1) + refuted; числа r1/r2/r3 сходятся; r3 = `7ab0d82`/`d4032219…` |
| risks-pfx.md | pass | R2/R4/R5 closed; R8=M13; R10 M15 closed/M16–M17 accepted; R16=N4 accepted-risk |

## 4. Редакционные замечания (не блокируют gate)

- В исторических разделах свода остались две метки severity: m7 в списке «связанные MINOR» (стр. 50) и redteam-r1 R5 помечен «NIT» (стр. 85), хотя в отчётах m7 = NIT, R5 = MINOR. Оба пункта закрыты; на текущие статусы/числа не влияет — поправить при публикации свода с результатом r2.
- `arbiter-n4.md`, п. 6: «записи R16 нет» — это состояние на момент арбитража; в реестре R16 уже есть. Добавить пометку «на момент арбитража» при желании.
- R3: «accepted-risk (до правки D/F)» — статус accepted-risk корректен, скобка историческая; можно переформулировать.
- `fix-runner-r2`: `commit: "7ab0d82"` (7 hex) и `workspace` опущен (solo). По буквальной норме call-mechanics:115 «нет commit или workspace ⇒ not_closed» и hex-гейту отчёт не прошёл бы precondition; для solo-запуска (без сведения) это не применялось, механика проверена на HEAD. Рекомендация: исключить solo в тексте нормы либо записать как R17/бэклог; на gate не влияет.
- `invariant-r2`: I12 «held» при открытых M12/M14 — формулировка шире фактической проверяемости (живой валидатор принимает отчёт без `workspace.base_commit`); оба остатка записаны как MINOR (R7/R9).
- sessionID верификаторов/арбитров переданы отдельно и проверены по БД, но не входят в сами артефакты; для воспроизводимости стоит добавить их в шапки verify/arbiter.
- `b0d7704` — unreachable-коммит верификатора D; на дерево/aggregate не влияет (ревизия совпала), учтён в «шуме» свода.

## 5. Ship-условие (явно)

**SHIP ⟺ `meta.gate`=pass ∧ `closing_list` пуст/закрыт ∧ `coverage_gaps` приняты владельцем (запись в `risks-pfx.md`; принятие фиксируется root'ом после вердикта).**

Сейчас: `gate=pass`, `closing_list=[]` (копия redteam-r2), 7 `coverage_gaps` ниже. Пока записи владельца о принятии нет, ship 0.3.0 не открыт. Из 4 gaps redteam-r2 пункт `worktree_create` снят `verify-D`; остальные 3 + 4 из `not_verified` ролей/арбитра — ниже.

## 6. Coverage gaps для принятия владельцем

1. Окно посадки background-фиксера через `session_move` (depth limit 1) — компенсация preflight fail-closed.
2. Живой `orch_uni_validate_report` после перезапуска плагина (M14/R9).
3. Стенд `kit-verify`/`kit-sync` в поставке отсутствует (`stand: unavailable` обоснован).
4. Реальная LLM-сессия `fix-runner` (поведение preflight/hex-гейта).
5. N>3 фиксера и другие версии git/OpenCode.
6. N4: механизм подтверждён, факт срабатывания в истории pfx не наблюдался (R16).
7. F: частота прерываний фиксеров не измерена (F закрыт правкой).

```json
{
  "schema": "meta/v1",
  "verdict": "pass",
  "gate": "pass",
  "closing_list": [],
  "coverage_gaps": [
    "Окно посадки background-фиксера через session_move не воспроизведено (subagent depth limit 1; собственная сессия не перемещалась); компенсация — preflight fix-runner'а fail-closed.",
    "Живой orch_uni_validate_report после перезапуска плагина не проверялся: текущий инстанс держит схемы из кэша старта (M14/R9); до рестарта валидатор может принять отчёт без workspace.base_commit.",
    "Стенд kit-verify/kit-sync в поставке отсутствует; stand: unavailable у fix-runner обоснован, но закрытие опирается на собственные проверки ролей, не на штатный стенд.",
    "Реальная LLM-сессия fix-runner (соблюдение preflight/hex-гейта в поведении) не запускалась: вложенные субагенты запрещены, запуск писал бы в аудируемый репозиторий.",
    "Поведение при N>3 параллельных фиксерах и в других версиях git/OpenCode не проверялось (замеры на 2 ветках и текущей версии git).",
    "N4: подтверждён механизм (stash/refs), но фактическое срабатывание в истории прогона pfx не наблюдалось (логи сессий/состояния деревьев не сохранены); принято как R16.",
    "F: частота прерываний фиксеров не измерена (вероятность залипания оценена по документированному штатному пути, не замером); F закрыт правкой, частота остаётся неизвестной."
  ],
  "reports": [
    {
      "report": "lab/audit-pfx/reports/factcheck-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/empiric-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/invariant-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/fix-runner-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/redteam-r1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/redteam-r2.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/arbiter-fg.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/arbiter-n4.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/verify-D.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/verify-E.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/verify-R1.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/reports/summary-pfx.md",
      "result": "pass",
      "violations": []
    },
    {
      "report": "lab/audit-pfx/risks-pfx.md",
      "result": "pass",
      "violations": []
    }
  ]
}
```
