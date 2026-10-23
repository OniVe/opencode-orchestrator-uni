# Аудит pfx — инвариантщик, круг 5 (re-audit)

Состояние: 2f5c581, aggregate 872a2fb4…b630c (96 файлов), совпал; в дереве только два lab-файла root'а (вне ревизии). Мои прогоны: npm test 93/93, typecheck rc=0, kit-verify 4/4, check:locales 12/12, biome 0.

**Вердикт: not_ready.** 0 MAJOR; 1 MINOR (N1) и 2 NIT. Закрывающий минимум — N1 (одна фраза в двух README); N2/N3 — принять/бэклог.

G1 закрыт: скобка восстановлена целиком (построчный счёт скобок 3/3 и 3/3 в call-mechanics, 22/22 и 24/24 в root-runbook), условие «только если стенд явно включён в границы вызова» снова внутри скобки и привязано к «в раундах по другим проектам», оговорка npm вынесена отдельным предложением после закрывающей скобки; ru/en зеркальны по позиции и смыслу.
G2 закрыт: строка E_SCHEMA_IO добавлена в обе таблицы под заголовком «orch_uni_validate_report», поля названы верно (directory/file — ровно то, что отдаёт failure() в lib/tools.ts:405-415), порядок совпадает с описанием инструмента; ширина новой строки 90 = ширине шапки/разделителя (не поехала; единственная строка 95 — предсуществующая E_INPUT).
G3 закрыт по содержанию: «npm-пакет не поставляет tools/» — истина (npm pack --dry-run: 39 файлов, tools/ 0), формулировка согласована с 6 md-носителями. НО указатель неверен → N1.

N1 (MINOR, новое): в обоих README оговорка начинается «The last two commands / Две последние команды», а последние две команды в блоке — npm run lint и npm run lint:fix; затронуты же check:locales и verify:kit (4-я и 5-я из 7). То есть предупреждение адресовано не тем командам: lint/lint:fix объявлены требующими чекаута (неверно), а tools-команды остаются без предупреждения — ровно та, ради которой писалось.
N2–N3 (NIT): в поставляемом package.json остаются verify:kit/check:locales, ведущие на непоставляемые файлы (ENOENT в npm — теперь хотя бы документировано); таблица кодов README — ручное перечисление без guard'а, привязанного к исполнителю/типу (ValidationCode не содержит E_SCHEMA_IO/E_ABORTED, т.к. это коды инструмента) — дрейф уже был один раз.

C4 и нормы не задеты: дифф трогает только фразу про стенд (4 md) и два README; no_report/not_consolidated/hex-гейт на месте (root-runbook:29-30, оба языка), kit-sync — 0 совпадений, публикация/fix-до-вердикта — на месте.

```json
{
  "schema": "invariant/v1",
  "verdict": "not_ready",
  "closure": {
    "closed_by_this_change": [
      "G1 (скобка/условие/отдельное предложение, ru=en)",
      "G2 (E_SCHEMA_IO в таблицах, поля и порядок верны)",
      "G3 по содержанию (npm без tools/ — проверено; формулировки согласованы)"
    ],
    "closed_in_earlier_rounds": [
      "F1, F3, F4, F5, F6, F7 (r4)",
      "F2 (r4, решением «документировать») — остаток N2"
    ],
    "still_open_accepted": [
      "M10 (MINOR, бэклог по арбитру)",
      "M13 (MINOR, принят в r2)",
      "M17 (NIT, принят в r2)",
      "G4/G5 (NIT, r4)"
    ],
    "new_in_r5": [
      "N1",
      "N2",
      "N3"
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
      "statement": "Валидатор применяет текущие схемы и не даёт ложного valid=true; отказы схем структурны.",
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
      "verdict": "violated",
      "counterexample": "N1: T1 README.md:307-315 — блок команд заканчивается npm run lint / npm run lint:fix; T2 добавленная оговорка говорит 'The last two commands need a git checkout of the kit — the npm package ships no tools/ directory…', т.е. указывает на lint/lint:fix, тогда как tools-команды — npm run check:locales и npm run verify:kit (4-я и 5-я из 7); T3 RU-зеркало: 'Две последние команды требуют git-чекаута…'; T4 факт (npm pack --dry-run: 39 файлов, tools/ 0) относится именно к check:locales/verify:kit."
    }
  ],
  "lines_checked": [
    {
      "line": "ОТМЕНА/ТАЙМАУТЫ",
      "status": "checked",
      "note": "Дифф — только проза (4 md + 2 README), новых точек ожидания нет. Ранее отмеченный G5 (нет таймаута у child-шагов kit-verify) не менялся и остаётся принятым NIT из r4."
    },
    {
      "line": "СОГЛАСОВАННОСТЬ ПРОИЗВОДНЫХ ДАННЫХ",
      "status": "checked",
      "note": "Документация ↔ артефакт: утверждение «npm-пакет без tools/» проверено (npm pack --dry-run: total files 39, tools/ 0) и совпадает с 6 md-носителями; таблица кодов ↔ реализация: E_SCHEMA_IO с полями directory/file совпадает с failure(..., {directory, file}) в lib/tools.ts:405-415. Расхождение — только адресация оговорки (N1)."
    },
    {
      "line": "МОНОТОННОСТЬ МЕТОК",
      "status": "checked",
      "note": "Агрегат состояния до/после всех прогонов один и тот же (872a2fb4…), рабочее дерево не менялось (только lab-файлы root'а). Версии/ревизии диффом не двигались."
    },
    {
      "line": "ВРАЖДЕБНЫЙ ВВОД",
      "status": "checked",
      "note": "Дифф не добавляет исполняемых путей; изменения — текст. Проверено, что в нормативный текст не попали управляющие символы/незакрытые конструкции: построчный счёт скобок на изменённых строках 3/3 (call-mechanics ru/en) и 22/22, 24/24 (root-runbook ru/en)."
    },
    {
      "line": "ПОЛНОТА КЛАССА",
      "status": "checked",
      "note": "Перебраны все 6 файлов диффа: call-mechanics ru/en, root-runbook ru/en (одна и та же фраза, зеркально), README ru/en (строка таблицы + оговорка). В 6 md-носителях формулировка про npm едина (fix-runner:9, call-mechanics:126, root-runbook:29 × ru/en); в README — та же мысль, но с неверным указателем (N1)."
    },
    {
      "line": "КОНТРАКТЫ «НЕИЗВЕСТНО»",
      "status": "checked",
      "note": "Таблица кодов под заголовком «orch_uni_validate_report» теперь покрывает все коды этого инструмента: E_INPUT/E_NO_JSON/E_PARSE/E_UNKNOWN_SCHEMA/E_SCHEMA_MISMATCH/E_INVALID/E_SCHEMA_IO/E_ABORTED — сверено с failure() в исполнителе и с union ValidationCode (плюс два инструментальных кода). Полный набор не выражен одним типом — N3."
    },
    {
      "line": "ЖИЗНЕННЫЙ ЦИКЛ ПРОЦЕССА",
      "status": "checked",
      "note": "Правки — только документация; kit-verify/lib не менялись с r4, поведение уборки/child-процессов то же (4/4 rc=0, следов в дереве нет)."
    },
    {
      "line": "ТОЧНОСТЬ ДЕТЕКТОРОВ",
      "status": "checked",
      "note": "Guard'ы по-прежнему не видят смысла/адресации прозы: 12/12 локалей и 93/93 тестов зелёные при неверном указателе N1 — это ожидаемый M10-класс (принятый бэклог). Новая строка таблицы не покрыта ни одним тестом (N3): дрейф кодов ловится только ревью."
    },
    {
      "line": "ИЗВЕСТНЫЕ ФАКТЫ / УЖЕ УЧТЕНО",
      "status": "checked",
      "note": "Заявления r5 проверены прогонами: 93/93 тестов, typecheck rc=0, kit-verify 4/4, локали 12/12, biome 0; npm pack --dry-run — 39 файлов и 0 совпадений tools/. Счётчик «93 tests» в README совпадает с фактом. Формулировки ru/en сверены построчно."
    }
  ],
  "findings": [
    {
      "id": "N1",
      "severity": "MINOR",
      "location": "README.md:307-315 (оговорка после блока команд); README.ru.md:314-322 (та же оговорка)",
      "scenario": "T1 в блоке разработки 7 команд, последние две — npm run lint и npm run lint:fix; T2 добавленная оговорка: «The last two commands need a git checkout of the kit — the npm package ships no tools/ directory…» (RU: «Две последние команды требуют git-чекаута комплекта…»); T3 команды, к которым относится факт (в пакете нет tools/), — npm run check:locales и npm run verify:kit, они 4-я и 5-я; T4 проверка факта: npm pack --dry-run → 39 файлов, tools/ 0 совпадений.",
      "consequence": "Предупреждение адресовано не тем командам: lint/lint:fix объявлены требующими чекаута (неверно — они не зависят от tools/), а check:locales/verify:kit остаются без предупреждения, хотя именно они в установленном пакете дают ENOENT. Оговорка, которой закрывали G3, не защищает целевой сценарий; в обеих локалях.",
      "fix": "Назвать команды явно: «`npm run check:locales` и `npm run verify:kit` требуют git-чекаута комплекта — в npm-пакете каталога `tools/` нет…» (EN: «The `check:locales` and `verify:kit` scripts need a git checkout …»). Заодно выровнять комментарии двух новых строк блока по общей колонке."
    },
    {
      "id": "N2",
      "severity": "NIT",
      "location": "package.json (поставляется в пакете): scripts.check:locales, scripts.verify:kit",
      "scenario": "T1 npm pack --dry-run: 39 файлов, tools/ отсутствует; T2 package.json входит в пакет и объявляет обе команды; T3 пользователь установленного пакета запускает npm run verify:kit → ENOENT; T4 в 6 md-носителях и (с ошибкой адресации, N1) в README есть предупреждение.",
      "consequence": "Остаточное расхождение артефакт↔документация: скрипты в поставке ведут на отсутствующие файлы. Теперь это хотя бы описано, поэтому NIT, а не MINOR; но сама команда всё равно падает невнятно (ENOENT модуля bun).",
      "fix": "Либо исключить tools-скрипты из публикуемого package.json (оставив в репозитории), либо добавить в них явную проверку наличия файла с сообщением «нужен git-чекаут комплекта», либо поставлять tools/."
    },
    {
      "id": "N3",
      "severity": "NIT",
      "location": "README.md:83-92; README.ru.md:84-93 (таблица кодов); lib/report-schema.ts (ValidationCode)",
      "scenario": "T1 таблица кодов — ручное перечисление; T2 union ValidationCode содержит 6 кодов отчётного уровня, а инструмент возвращает ещё E_SCHEMA_IO и E_ABORTED; T3 ни один тест не сверяет таблицу README с исполнителем (grep по test/: коды проверяются в поведении, README не читается); T4 дрейф уже реализовался один раз — E_SCHEMA_IO появился в коде в r3, а в таблице только в r5.",
      "consequence": "Витрина контракта (таблица кодов) может снова разойтись с реализацией, и это не поймает ни guard, ни мета — только ревью.",
      "fix": "Один источник: экспортировать полный набор кодов инструмента одним union (например ValidateReportCode = ValidationCode | 'E_SCHEMA_IO' | 'E_ABORTED') и добавить тест «каждый код из union встречается в таблицах README (ru/en)», либо генерировать строки таблицы из union."
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
      "why": "Формат «baseline <rc/итог> → after <rc/итог> | unavailable» не задаёт, что фиксируется и как сравнивается."
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
