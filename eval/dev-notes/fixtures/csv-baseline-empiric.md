# SGR: empiric — model-bundle baseline

Сессия: `ses_ec55a05dcffe9s461meihsEj4u`. Ревизия: sha256 4/4 совпали с ref/case-hashes.txt.

```json
{
  "schema": "empiric/v1",
  "verdict": "not_ready",
  "claims_checked": [
    {"claim": "Файлы/хэши кейса", "method": "compare_base", "rc": "0", "result": "HASHES_MATCH_4/4", "verdict": "confirmed"},
    {"claim": "bun 1.4.2; git недоступен", "method": "run", "rc": "0/128", "result": "1.4.2; fatal: not a git repository", "verdict": "confirmed"},
    {"claim": "README: все тесты проходят", "method": "run", "rc": "0", "result": "8 pass / 0 fail", "verdict": "confirmed"},
    {"claim": "README: полное соответствие spec", "method": "run", "rc": "0", "result": "4/10 строк таблицы spec.md провалены; фузз 20000 входов → 8925 расхождений (44.6%)", "verdict": "refuted"},
    {"claim": "нет throw (статика)", "method": "run", "rc": "1", "result": "grep throw = 0", "verdict": "confirmed"},
    {"claim": "нет error-кейсов в тестах", "method": "run", "rc": "1", "result": "toThrow=0", "verdict": "confirmed"},
    {"claim": "сетка ловит пропущенную обработку ошибок", "method": "run", "rc": "0", "result": "мутант M3' (корректная валидация) ВЫЖИЛ: 8 pass / 0 fail", "verdict": "refuted"},
    {"claim": "перф-ассерт осмыслен", "method": "measure", "rc": "0", "result": "факт 0.211–0.882 мс, запас ×120870/×34000 — не детектор", "verdict": "refuted"}
  ],
  "modes_measured": [
    {"operation": "splitCsvLine, 5000 полей", "regimes": ["простые поля", "кавычечные \"a\"\"b\""], "best": "0.211 мс", "worst": "0.882 мс", "budget_claim": "тест: <30 000 мс", "measured": "запас ×120870" }
  ],
  "findings": [
    {"id": "M1", "severity": "MAJOR", "location": "split-csv-line.ts:2-13; spec.md:13", "mechanism": "нет ни одного throw: невалидные формы молча возвращаются как значения (0/10 throw).", "evidence": "grep=0; probe: invalid 10, threw=0 (rc=0); фузз 8173/20000 «не бросил Error»", "fix": "посимвольный разбор с состояниями; Error на mid-field quote / tail / unclosed"},
    {"id": "M2", "severity": "MAJOR", "location": "split-csv-line.ts:3; spec.md:9,28", "mechanism": "безусловный line.split(\",\") — запятая внутри кавычек режет поле.", "evidence": "\"a,b\",c → [\"\\\"a\",\"b\\\"\",\"c\"] (want [\"a,b\",\"c\"]) rc=0; фузз 777/20000 «значения различаются»", "fix": "поток с состоянием inQuotes"},
    {"id": "M3", "severity": "MAJOR", "location": "split-csv-line.test.ts:1-45; README.md:5-6", "mechanism": "сетка без error-кейсов и без запятой-в-кавычках; зелёный прогон ничего не подтверждает.", "evidence": "toThrow=0; мутант M3' выжил (8/0, rc=0)", "fix": "toThrow-кейсы (\"a, \"a\"x, ab\"cd, \, a\", \"ab) + \"a,b\",c + a,\"b,c\",d"},
    {"id": "M4", "severity": "MINOR", "location": "split-csv-line.test.ts:36-44", "mechanism": "перф-порог ×120000 от факта; спека перф не требует — ложная защищённость.", "evidence": "0.211/0.882 мс (rc=0)", "fix": "убрать или порог ~50 мс + кавычечный режим"},
    {"id": "M5", "severity": "NIT", "location": "split-csv-line.ts:5-7", "mechanism": "послойное снятие кавычек while-циклом — расширение семантики за пределы spec.", "evidence": "«\"\"\"» вне контракта (rc=0)", "fix": "однократное снятие обрамления"}
  ],
  "contract_gaps": [
    {"item": "хвостовой/сдвоенный разделитель (a,, a,,b) не задан", "where": "spec.md:7,18-31", "why": "golden-тесты зафиксировать нечего"},
    {"item": "тип/сообщение ошибки не задан", "where": "spec.md:13", "why": "сверка только через toThrow()"},
    {"item": "CR/LF/пробелы/юникод не заданы", "where": "spec.md", "why": "границы строки не определены"}
  ],
  "not_verified": [
    {"item": "ref/reference-defects.md", "why": "запрещён брифом — не читал"},
    {"item": "внешний эталон (RFC 4180)", "why": "не заявлен спекой; ref — реконструкция"},
    {"item": "потребители функции", "why": "изолированный кейс"}
  ]
}
```

Ключевое: фузз 20000 → 8925 расхождений; выбраковка через мутацию (M3' выжил) — сетка слепа;
`contract_gaps` заполнены; каталог кейса не изменён (sha256 повторно сверены 4/4).
