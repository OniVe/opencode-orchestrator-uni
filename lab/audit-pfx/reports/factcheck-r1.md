# Факт-чек (pre-pass) — аудит pfx: параллельные fix-runner в worktree

Дата: 2026-10-23. Роль: факт-чекер (read-only). Бриф: `lab/audit-pfx/case-pfx.md`.
Состояние: `C:\project\ai\opencode-orchestrator-uni`, ветка `main`, HEAD `291a357`, рабочее дерево чистое.

## Резюме

Ядро брифа подтверждено: HEAD/база/диапазон/состав 10 файлов совпадают; ревизия воспроизводится байт-в-байт
(`snapshot(path=".", exclude=["lab","eval/results"])` → 95 файлов, aggregate `c407932d…`); guard'ы зелёные
(locales 12/12, test 91/91, biome rc=0); старое правило «писатели строго последовательно» в репозитории не осталось.
Четыре поправки к премисам:

1. **C1 «формулировки согласованы» — опровергнуто на пункте «одни и те же файлы»**: `agents/{ru,en}/orchestrator.md:48`
   запрещает двух писателей по одним файлам только **в одном** пространстве, а `docs/{ru,en}/call-mechanics.md:113` —
   безусловно («Два фиксера в одном пространстве **или по одним файлам** — запрещено»). Это ровно краевой случай C6.
2. **Локальные git-теги устарели**: локально только `v0.0.0`, `v0.1.0`; `v0.2.0`/`v0.2.1` есть на origin
   (`git ls-remote --tags`) — «локальная история полная» верно для коммитов, но не для тегов.
3. **Версия**: цель 0.3.0 корректна (registry: 0.1.0, 0.2.0, 0.2.1; `v0.2.1` = база `dfa4ee7`; feat → minor),
   но `package.json` локально содержит `0.1.0` — не использовать как признак версии (её ведёт semantic-release в CI).
4. **HEAD не запушен**: `origin/main` = `dfa4ee7`; изменение проверено только локальными прогонами, CI на 291a357 не работал.

Плюс: `lab/audit-pfx/risks-pfx.md` пуст → условие gate «coverage_gaps приняты владельцем» пока не выполнено.

```json
{
  "schema": "factcheck/v1",
  "verdict": "stale",
  "claims": [
    {
      "claim": "HEAD = 291a357, дерево чистое",
      "status": "actual",
      "evidence": "git rev-parse HEAD → 291a357e8e9ab0ecd67a13380dfedf6951fa924b; git status --porcelain=v1 → 0 строк; git rev-parse --abbrev-ref HEAD → main",
      "source": "git"
    },
    {
      "claim": "База dfa4ee7, диапазон dfa4ee7..291a357",
      "status": "actual",
      "evidence": "git log --oneline -2 → '291a357 feat: allow parallel fix-runners…' / 'dfa4ee7 fix: polish the English translations…'; dfa4ee7 = родитель HEAD",
      "source": "git"
    },
    {
      "claim": "Изменение затрагивает ровно 10 файлов: agents/{ru,en}/{orchestrator,fix-runner}.md, docs/{ru,en}/{call-mechanics,root-runbook,instruction-other-session}.md",
      "status": "actual",
      "evidence": "git diff --name-status dfa4ee7..291a357 → 10 строк M, перечень совпадает 1:1; git diff --stat → '10 files changed, 20 insertions(+), 14 deletions(-)'",
      "source": "git"
    },
    {
      "claim": "Ревизия состояния: aggregate c407932d5e95a6e3ef9c49d953658cb9c61f6d6753354a083e876cf24d40f797, 95 файлов, исключены lab и eval/results",
      "status": "actual",
      "evidence": "orch_uni.snapshot(path='.', exclude=['lab','eval/results']) → files: 95, aggregate: c407932d5e95a6e3ef9c49d953658cb9c61f6d6753354a083e876cf24d40f797 (полное совпадение); в выборке 0 путей lab/* и eval/results/*",
      "source": "git"
    },
    {
      "claim": "Upstream issue/PR к изменению нет",
      "status": "actual",
      "evidence": "gh pr list --state all --limit 5 → пусто; gh issue list --state all --limit 5 → пусто (gh авторизован; api.github.com отдаёт 403 rate limit, использован gh CLI); git ls-remote --heads origin → refs/heads/main = dfa4ee7 (изменение не запушено, PR физически не мог появиться)",
      "source": "github"
    },
    {
      "claim": "Релизный гейт — версия 0.3.0",
      "status": "actual",
      "evidence": "npm view opencode-orchestrator-uni versions → ['0.1.0','0.2.0','0.2.1'], dist-tags latest=0.2.1; git ls-remote --tags → v0.2.0=181c406 (feat), v0.2.1=dfa4ee7 (fix); release.config.cjs: feat→minor, breaking→minor (<1.0.0) ⇒ feat 291a357 поверх 0.2.1 = 0.3.0. Внимание: package.json локально = 0.1.0 (версию ведёт semantic-release в CI)",
      "source": "git"
    },
    {
      "claim": "Git-история локальная, полная",
      "status": "stale",
      "evidence": "Коммиты полные: .git/shallow отсутствует, git rev-list --count HEAD = 16, цепочка до v0.0.0. Но теги: локально git tag --list → v0.0.0, v0.1.0; на origin есть v0.2.0 (181c406) и v0.2.1 (dfa4ee7) — не подтянуты. Для версионных выводов брать ls-remote/registry, а не локальные теги",
      "source": "git"
    },
    {
      "claim": "C1: правило «писатель один на рабочее пространство» и порядок параллельных fix-runner зафиксированы во всех 10 файлах обеих локалей",
      "status": "actual",
      "evidence": "grep -ci worktree по 10 файлам → orchestrator ru/en: 1/1, fix-runner ru/en: 1/1, call-mechanics ru/en: 2/2, root-runbook ru/en: 2/2, instruction-other-session ru/en: 1/1 — все ≥1",
      "source": "docs"
    },
    {
      "claim": "C1: формулировки согласованы между собой",
      "status": "refuted",
      "evidence": "agents/ru/orchestrator.md:48 'Не запускай двух писателей по одним и тем же файлам в одном пространстве' (запрет привязан к пространству) vs docs/ru/call-mechanics.md:113 'Два фиксера в одном пространстве или по одним файлам — запрещено' (безусловный запрет). EN-зеркала те же: agents/en/orchestrator.md:48 'in the same workspace' vs docs/en/call-mechanics.md:113 'in one workspace or on the same files'. root-runbook и instruction-other-session про одни файлы молчат",
      "source": "docs"
    },
    {
      "claim": "C2: старое правило «писатели строго последовательно / единственный писатель в каждый момент» не осталось в противоречащих местах",
      "status": "actual",
      "evidence": "grep -rni 'строго последовательн|единственный писател|писател.{0,20}(последовательн|один)|one writer|single writer|strictly sequential' по *.md (без lab/node_modules) → только новые формулировки (orchestrator:18/48/50, call-mechanics:220). Ролевые 'единственный пишущий субагент' (agents/ru/fix-runner.md frontmatter и стр.9) и README.md:37 'Writer: applies the fix list' — про роль, допустимы по брифу",
      "source": "code"
    },
    {
      "claim": "C3: механика изоляции описана полно (worktree+ветка на фиксера, непересекающиеся списки, сведение root'ом с конфликтами и проверками, запрет двух фиксеров в одном пространстве)",
      "status": "actual",
      "evidence": "agents/{ru,en}/orchestrator.md:49 (worktree_create, иначе git worktree add; ветка; непересекающиеся списки; сведение merge/перенос/диффы + разрешение пересечений и конфликтов + проверки на сведённом состоянии) и docs/{ru,en}/call-mechanics.md:113 (то же + 'Два фиксера в одном пространстве… запрещено'); docs/{ru,en}/root-runbook.md шаг 6 и список вызовов (сведение + проверки); краткая форма — instruction-other-session (worktree + непересекающиеся списки + сведение, без ветки и проверок)",
      "source": "docs"
    },
    {
      "claim": "C4: инварианты процесса не нарушены (правки после фиксации вердикта, fix-runner не пушит, публикация только после ship и решения владельца, MAJOR-верификация, re-audit = resume тех же сессий)",
      "status": "actual",
      "evidence": "docs/ru/call-mechanics.md:197 (сбой→resume), :158 (SHIP ⟺ meta.gate=pass ∧ closing_list пуст ∧ coverage_gaps приняты владельцем); §7 'до вердикта — не править'; docs/ru/root-runbook.md шаг 4 (перекрёстная верификация MAJOR, fail-closed), шаг 5 (вердикт до правок), шаг 7 (re-audit = resume, sessionID обязателен); agents/ru/fix-runner.md:24 'Ничего не публиковать (не пушить, не создавать PR)'. Диффом эти строки только дополнены, не удалены (20 insertions / 14 deletions — все 14 в 6 строках правил о писателях и параллельности)",
      "source": "docs"
    },
    {
      "claim": "C5: guard'ы зелёные — check:locales 12/12, npm test 91/91, biome 0; структура md цела, EN без кириллицы",
      "status": "actual",
      "evidence": "npm run check:locales → '12/12 ok', rc=0; npm test → '91 pass, 0 fail, 759 expect() calls, 8 files', rc=0; npx biome check . → 'Checked 33 files… No fixes applied', rc=0; perl-скан кириллицы в 5 EN-файлах → 0; число строк '^#|^```' совпадает с dfa4ee7 во всех 10 файлах (42/42, 9/9, 5/5, 0/0)",
      "source": "code"
    },
    {
      "claim": "C6: краевые случаи описаны или осознанно не покрыты (одни файлы при непересекающихся списках, отсутствие worktree_create, прерванный фиксер, конфликт при сведении, out_of_scope)",
      "status": "stale",
      "evidence": "Покрыты: отсутствие worktree_create — 'иначе git worktree add' (orchestrator:49, call-mechanics:113); конфликт при сведении — 'разрешает пересечения и конфликты' (там же); out_of_scope — root-runbook шаг 6, fix-runner п.1 и п.10. НЕ покрыто: (а) одни файлы — противоречиво (orchestrator допускает в разных пространствах, call-mechanics запрещает безусловно); (б) прерванный/упавший фиксер — только общее 'resume с продолжения' (call-mechanics:197), судьба его worktree/ветки при сведении не описана; (в) контракт переноса не закрыт: fix-runner коммитит 'если нужен коммит', т.е. возможен незакоммиченный worktree — как root его переносит, не сказано",
      "source": "docs"
    },
    {
      "claim": "Gate-условия релиза зафиксированы в реестре рисков (coverage_gaps приняты владельцем)",
      "status": "stale",
      "evidence": "lab/audit-pfx/risks-pfx.md содержит только заголовок и пустую таблицу (0 строк данных) — принятых рисков и coverage_gaps нет; условие SHIP из call-mechanics:158 пока не выполнено",
      "source": "docs"
    }
  ],
  "promises": [
    {
      "promise": "Коммит 291a357: 'Verified: check:locales 12/12, npm test 91/91, biome check 0'",
      "origin": "CHANGELOG",
      "status": "implemented",
      "evidence": "Воспроизведено на HEAD: locales 12/12 (rc=0), test 91 pass/0 fail (rc=0), biome rc=0; дерево после прогонов чистое (git status → 0)",
      "source": "code"
    },
    {
      "promise": "Коммит 291a357: правило 'писатель один на пространство, параллельные fix-runner только в отдельных worktree с непересекающимися списками' внесено в промпты orchestrator и fix-runner, call-mechanics, root-runbook, instruction-other-session — ru и en",
      "origin": "CHANGELOG",
      "status": "implemented",
      "evidence": "git diff dfa4ee7..291a357 → все 10 заявленных файлов изменены; 'worktree' присутствует в каждом (см. claim C1)",
      "source": "git"
    },
    {
      "promise": "Коммит 291a357: ограничение fix-runner при параллельном запуске — не выходить из своего worktree, не трогать основную ветку и чужие worktree, сообщать ветку/worktree и способ переноса",
      "origin": "CHANGELOG",
      "status": "implemented",
      "evidence": "agents/ru/fix-runner.md:57 и agents/en/fix-runner.md:57 — добавленная строка с этими требованиями; п.5 'не пушить / не создавать PR' сохранён (стр.24)",
      "source": "docs"
    },
    {
      "promise": "Коммит 291a357: root сводит результаты — merge/перенос веток или диффов, разрешение пересечений и конфликтов, прогон проверок на сведённом состоянии, затем фиксация итога",
      "origin": "CHANGELOG",
      "status": "partial",
      "evidence": "Полностью в agents/{ru,en}/orchestrator.md:49 и docs/{ru,en}/call-mechanics.md:113; частично в docs/{ru,en}/root-runbook.md (шаг 6 и 'каждому отдельный worktree/ветка'); в docs/{ru,en}/instruction-other-session.md сжато до '…с последующим сведением' — ветка на фиксера и проверки на сведённом состоянии не упомянуты",
      "source": "docs"
    },
    {
      "promise": "release.config.cjs: до 1.0.0 feat → minor (pre-1.0 политика)",
      "origin": "doc",
      "status": "implemented",
      "evidence": "Теги: v0.1.0=62422f5, v0.2.0=181c406 (feat: ship the kit in ru and en), v0.2.1=dfa4ee7 (fix) — фактическая история соответствует правилу; следующий feat = 0.3.0",
      "source": "git"
    }
  ]
}
```

## Замечания для аудиторов (контекст, не находки)

- Диапазон аудита локальный и не запушен: `origin/main` = `dfa4ee7`. Внешних issue/PR нет (проверено `gh`), т.е. «обещания из issue» в этой задаче отсутствуют — сверять только с текстом коммита и доками.
- Ревизию воспроизводить ровно как `snapshot(path=".", exclude=["lab","eval/results"])`; отчёт лежит в `lab/`, поэтому хэш не сдвигается.
- Версия: ориентир — registry `0.2.1` + `feat` ⇒ `0.3.0`; `package.json` = `0.1.0` не показатель (semantic-release пишет версию в CI).
- `meta.gate` / `closing_list` вне репозитория; в `risks-pfx.md` записей нет.

ФАКТ-ЧЕК (для аудиторов, ≤15 строк):
- Состояние совпадает с брифом: main @ 291a357, дерево чистое, база dfa4ee7, 10 файлов ровно те.
- Ревизия воспроизведена: 95 файлов, aggregate c407932d…f797 (snapshot с exclude lab, eval/results).
- Guard'ы зелёные на HEAD: locales 12/12, test 91/91 (8 файлов), biome rc=0 (33 файла); EN без кириллицы, разметка md не поехала.
- Цель релиза 0.3.0 подтверждена: registry latest 0.2.1, v0.2.1=dfa4ee7, feat ⇒ minor.
- Поправка 1: package.json = 0.1.0 — не признак версии (semantic-release в CI).
- Поправка 2: локальные теги устарели (v0.2.0/v0.2.1 только на origin) — версию сверять по ls-remote/registry.
- Поправка 3: HEAD не запушен (origin/main = dfa4ee7) ⇒ CI на 291a357 не работал; зелёные guard'ы только локальные.
- C1 «зафиксировано во всех 10 файлах» — да; «формулировки согласованы» — НЕТ (см. следующую строку), это материал C6, не шум.
- Расхождение: orchestrator:48 запрещает двух писателей по одним файлам лишь «в одном пространстве», call-mechanics:113 — безусловно («или по одним файлам»). EN-зеркала идентичны по смыслу.
- C2 чисто: старых «строго последовательно / single writer» нет; «единственный пишущий субагент» — ролевое, допустимо.
- C3 полно в orchestrator/call-mechanics/root-runbook; в instruction-other-session сжато (нет ветки на фиксера и проверок на сведённом состоянии).
- C4 инварианты на месте: вердикт до правок, fix-runner не пушит, SHIP-условие, MAJOR-верификация, re-audit=resume.
- C6 пробелы: судьба worktree/ветки прерванного фиксера не описана; контракт «коммит vs дифф» не закрыт (fix-runner коммитит «если нужен»).
- risks-pfx.md пуст ⇒ coverage_gaps владельцем не приняты; SHIP-условие call-mechanics:158 пока не выполнено.
