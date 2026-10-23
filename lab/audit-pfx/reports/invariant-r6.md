# Аудит pfx — инвариантщик, круг 6 (re-audit, узкий)

Состояние: ae6b9e4, aggregate 53dd7b96…a8ed (96 файлов), совпал; в дереве только два lab-файла root'а (вне ревизии). Диапазон 2f5c581..ae6b9e4 — ровно 2 файла (+2/−2): README.md, README.ru.md.

**Вердикт: ready.** 0 MAJOR, 0 MINOR (N1/S1 закрыт), 1 NIT (W1, косметика — принять или закрыть следующим проходом). Ранее принятый бэклог (M10, M13, M17, G4, G5, N2, N3) не затронут.

N1/S1 закрыт: оговорка называет команды прямо — «The `check:locales` and `verify:kit` scripts» / «Команды `check:locales` и `verify:kit`»; позиционных ссылок не осталось ни в README, ни в agents/docs (git grep по «last two / две последние» — пусто). Факт сохранён и верен для обеих команд: обе ведут на `bun tools/*.ts` (package.json:47-48), а в пакете `tools/` нет (npm pack --dry-run: 39 файлов, 0 совпадений tools/) — значит в установленном пакете недоступны именно они. ru/en зеркальны по структуре и родительной оговорке.

Регрессий нет: 93/93 тестов (включая страж структуры README ru↔en), typecheck rc=0, kit-verify 4/4, check:locales 12/12, biome 0. C4/нормы не задеты — дифф читает только две строки README; no_report/not_consolidated/hex-гейт на месте, kit-sync — 0.

W1 (NIT): `stand: unavailable` — состояние поля отчёта fix-runner, а не вывод `check:locales`; в скобке после «they are unavailable» это читается как общий статус обеих команд. Смысл не искажён, но категория смешана — предложено «…they are unavailable; use your own reproducible checks (the fixer's `stand` field then reads `stand: unavailable: <why>`)».

```json
{
  "schema": "invariant/v1",
  "verdict": "ready",
  "closure": {
    "closed_by_this_change": [
      "N1/S1 (адресация оговорки: названы команды, позиционных ссылок нет, ru=en, факт сохранён)"
    ],
    "closed_in_earlier_rounds": [
      "G1, G2, G3 (r5)",
      "F1, F3, F4, F5, F6, F7 (r4)",
      "F2 (r4, решением «документировать»)"
    ],
    "still_open_accepted": [
      "M10 (MINOR, бэклог по арбитру)",
      "M13 (MINOR, принят в r2)",
      "M17 (NIT, принят в r2)",
      "G4/G5 (NIT, r4)",
      "N2/N3 (NIT, r5)"
    ],
    "new_in_r6": [
      "W1 (NIT, косметика)"
    ]
  },
  "invariants": [
    {
      "id": "I1",
      "statement": "Один писатель на checkout; фиксер проверяет изоляцию до первой правки (preflight).",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I2",
      "statement": "Нет двух фиксеров на пересекающихся файлах; непересечение считается по путям и классу до запуска.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I3",
      "statement": "Безусловная норма о писателях едина во всех носителях, включая §7.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I4",
      "statement": "Параллельный фиксер не мутирует чужие refs/stash; свой коммит и switch -c разрешены.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I5",
      "statement": "Прерванный фиксер переводит состояние в терминальное (no_report, ветка не сливается, worktree убирается осознанно).",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I6",
      "statement": "closed и доказательство приёмки — на сведённом состоянии; пустая дельта ⇒ not_consolidated.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I7",
      "statement": "Вердикт привязан к воспроизводимой ревизии; worktree вне дерева проекта не влияет на снапшот.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I8",
      "statement": "Данные из отчёта не становятся git-командой без валидации (40-hex, cat-file/ancestor/delta).",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I9",
      "statement": "Механизм изоляции исполним: ветка, посадка, зависимости, запрет параллели при недоступности.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I10",
      "statement": "C4 не ослаблены: до вердикта не править, запрет push, публикация после ship+владельца, MAJOR-верификация, re-audit=resume.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I11",
      "statement": "Структурно-языковая целостность: заголовки/фенсы, EN без кириллицы, enum-токены, пары локалей, ключевые термины.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I12",
      "statement": "Валидатор применяет текущие схемы, не даёт ложного valid=true; отказы схем структурны.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I13",
      "statement": "Стенд исполним, rc-семантика определена, в объект не пишет, вывод детерминирован.",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I14",
      "statement": "Стенд проверяет заявленное (типы tools/**, наборы локалей в обе стороны).",
      "verdict": "held",
      "counterexample": null
    },
    {
      "id": "I15",
      "statement": "Утверждения документации о поставляемом артефакте истинны и адресованы тем командам/файлам, к которым относятся.",
      "verdict": "held",
      "counterexample": null
    }
  ],
  "lines_checked": [
    {
      "line": "ОТМЕНА/ТАЙМАУТЫ",
      "status": "checked",
      "note": "Дифф — две строки прозы в README, исполняемых путей и точек ожидания не добавлено. Ранее принятые G5 (нет таймаута child-шагов стенда) и контрактные пробелы не менялись."
    },
    {
      "line": "СОГЛАСОВАННОСТЬ ПРОИЗВОДНЫХ ДАННЫХ",
      "status": "checked",
      "note": "Утверждение README сверено с артефактом по обеим командам: package.json:47 check:locales → bun tools/locale-check.ts, :48 verify:kit → bun tools/kit-verify.ts; npm pack --dry-run → 39 файлов, tools/ 0 совпадений. Формулировка согласована с 6 md-носителями (fix-runner:9, call-mechanics:126, root-runbook:29 × ru/en): там «в npm-пакете tools/ нет → stand: unavailable», здесь — то же для двух команд."
    },
    {
      "line": "МОНОТОННОСТЬ МЕТОК",
      "status": "checked",
      "note": "Агрегат до/после прогонов один и тот же (53dd7b96…); дерево не менялось (только lab-файлы root'а)."
    },
    {
      "line": "ВРАЖДЕБНЫЙ ВВОД",
      "status": "checked",
      "note": "Изменения — текст; новых входов/команд нет. Проверено отсутствие сломанной разметки: строка — обычный абзац, кавычки/скобки сбалансированы, пустые строки вокруг фенса на месте."
    },
    {
      "line": "ПОЛНОТА КЛАССА",
      "status": "checked",
      "note": "Перебраны оба файла диффа и все места, где раньше была позиционная ссылка: git grep по «last two commands / две последние команды / последние две» по README.md, README.ru.md, agents, docs — 0 совпадений. Обе локали назвали обе команды."
    },
    {
      "line": "КОНТРАКТЫ «НЕИЗВЕСТНО»",
      "status": "checked",
      "note": "Оговорка не вводит новых состояний; `stand: unavailable` остаётся документированным значением поля fix-runner (шаблон отчёта). Смешение категории (поле отчёта vs статус команды) отмечено как W1 — NIT."
    },
    {
      "line": "ЖИЗНЕННЫЙ ЦИКЛ ПРОЦЕССА",
      "status": "checked",
      "note": "Правки только в README; kit-verify/lib/тесты не менялись с r4 — поведение то же (4/4 rc=0, следов в дереве нет)."
    },
    {
      "line": "ТОЧНОСТЬ ДЕТЕКТОРОВ",
      "status": "checked",
      "note": "Адресность прозы guard'ами не проверяется (M10-класс, принят): 12/12 и 93/93 зелёные и до, и после — закрытие N1 подтверждено чтением и сверкой с package.json/npm pack, а не guard'ом. Регрессий структуры нет: страж README ru↔en (уровни заголовков/фенсы) входит в 93/93."
    },
    {
      "line": "ИЗВЕСТНЫЕ ФАКТЫ / УЖЕ УЧТЕНО",
      "status": "checked",
      "note": "Заявления r6 проверены: дифф ровно 2 файла (+2/−2); 93/93 тестов, typecheck rc=0, kit-verify 4/4, локали 12/12, biome 0; позиционных ссылок не осталось; факт про пакет подтверждён npm pack. Ничего не принято на веру из сводки root'а."
    }
  ],
  "findings": [
    {
      "id": "W1",
      "severity": "NIT",
      "location": "README.md:310; README.ru.md:317",
      "scenario": "T1 предложение: «…so in an installed package they are unavailable (`stand: unavailable` plus your own reproducible checks)»; T2 `stand: unavailable` — значение поля `stand` в отчёте fix-runner/v1 (шаблон: «baseline … → after … | unavailable: <почему>»), т.е. состояние отчёта, а не вывод `check:locales`; T3 в скобке оно приписано обеим командам сразу.",
      "consequence": "Смысл не искажён (обе команды в пакете недоступны, нужен чекаут), но категория смешана: читатель может ожидать поля `stand` от `check:locales`. Косметика уровня NIT, на поведение и на гейт не влияет.",
      "fix": "Развести: «…they are unavailable; use your own reproducible checks (the fixer's report then carries `stand: unavailable: <why>`)» / «…они недоступны; используйте собственные воспроизводимые проверки (в отчёте фиксера это `stand: unavailable: <почему>`)». Либо оставить как есть и принять NIT записью в реестр."
    }
  ],
  "contract_gaps": [
    {
      "item": "rc=2 перегружен: usage-ошибка и «нет пар/сирот»",
      "where": "tools/kit-verify.ts (main/runProjectStand)",
      "why": "Вызывающий не отличает «нечего проверять» от «неверные аргументы»; для --proj это разные решения."
    },
    {
      "item": "Состав поля stand",
      "where": "agents/*/fix-runner.md:47; docs/*/call-mechanics.md:126",
      "why": "Формат «baseline <rc/итог> → after <rc/итог> | unavailable» не задаёт, что фиксируется и как сравнивается (W1 — следствие: поле цитируется вне контекста отчёта)."
    },
    {
      "item": "Политика симлинков в проверке локалей",
      "where": "tools/kit-verify.ts, tools/locale-check.ts, test/support/locales.ts (markdownFiles)",
      "why": "Не задано, считается ли симлинк файлом локали; молчаливый пропуск даёт ложные сироты (G4) и потенциально невидимые пары."
    },
    {
      "item": "Тайминг session_move для фонового фиксера",
      "where": "docs/*/call-mechanics.md:114; docs/*/root-runbook.md:29",
      "why": "Переезд применяется «в конце текущего хода», а фиксер запускается background; окно страхует preflight, но порядок «переезд до первой правки» спецификацией не гарантирован."
    }
  ],
  "not_verified": [
    {
      "item": "Симлинк-доки (G4) и POSIX-ветка спавна",
      "why": "Симлинки в этой среде не создаются (EPERM), POSIX-спавн не проверить на Windows — выводы по коду, без прогона."
    },
    {
      "item": "session_move 4/4 и «4 реальные LLM-сессии»",
      "why": "С моего уровня субагенты недоступны (depth limit 1); git-часть эксперимента воспроизведена в r3."
    },
    {
      "item": "Фактический тарбол CI-релизом",
      "why": "Проверен npm pack --dry-run; пайплайн semantic-release/CI не запускал."
    }
  ]
}
```
