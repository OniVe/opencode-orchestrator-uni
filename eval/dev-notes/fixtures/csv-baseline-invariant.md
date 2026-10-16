# SGR: audit-invariant — model-bundle baseline

Сессия: `ses_ec55a05dbffeJ2Jx0ewr04IMBr`. Ревизия: sha256 4/4 совпали с ref/case-hashes.txt.

```json
{
  "schema": "audit-invariant/v1",
  "verdict": "not_ready",
  "invariants": [
    {"id": "I1", "statement": "невалидный ввод → Error", "verdict": "violated", "counterexample": "'\"a', '\"a\"x', 'ab\"cd' → значения без исключения; grep throw = 0"},
    {"id": "I2", "statement": "запятая в кавычках не разделитель", "verdict": "violated", "counterexample": "'\"a,b\",c' → ['\"a','b\"','c'] (split до кавычек, :3)"},
    {"id": "I3", "statement": "\"\" → одна кавычка", "verdict": "held"},
    {"id": "I4", "statement": "базовые случаи таблицы", "verdict": "held"},
    {"id": "I5", "statement": "результат без обрамляющих кавычек", "verdict": "violated", "counterexample": "'\"a,b\",c' → значения с кавычками"},
    {"id": "I6", "statement": "завершается на любом конечном входе", "verdict": "held"},
    {"id": "I7", "statement": "нет скрытой квадратичности на враждебном входе", "verdict": "violated", "counterexample": "k=8000→19.8 мс, 16000→67, 32000→217, 64000→728, 128000→2867 мс (×3.2–3.9/удвоение)"},
    {"id": "I8", "statement": "чистота/новый массив/без мутаций", "verdict": "held"}
  ],
  "findings": [
    {"id": "M1", "severity": "MAJOR", "location": "split-csv-line.ts:2-13", "mechanism": "нет ни одного throw — канала невалидности нет.", "evidence": "'\"a','\"a\"x','ab\"cd' → значения (rc=0); grep=0", "fix": "автомат с состоянием INVALID"},
    {"id": "M2", "severity": "MAJOR", "location": "split-csv-line.ts:3", "mechanism": "line.split(',') до учёта кавычек — рвёт поля с запятой в кавычках.", "evidence": "'\"a,b\",c' → ['\"a','b\"','c'] (rc=0)", "fix": "один проход: запятая — разделитель только вне кавычек"},
    {"id": "M3", "severity": "MINOR", "location": "split-csv-line.ts:5-7", "mechanism": "послойное снятие кавычек while-циклом: '\"\"\"\"'→[''] (ожидание ['\"']); '\"\"a\"\"'→['a'] (невалидно по spec).", "evidence": "probe (rc=0)", "fix": "ровно одна внешняя пара; '\"\"' декодируется только внутри парных кавычек"},
    {"id": "M4", "severity": "MINOR", "location": "split-csv-line.ts:8-10", "mechanism": "цикл replace пересоздаёт строку O(len) каждый раз → O(k²); синхронно, неотменяемо.", "evidence": "k=8000..128000 → 19.8..2867 мс (rc=0); 1 МБ ≈ десятки секунд (экстраполяция)", "fix": "декодировать одним проходом O(n)"},
    {"id": "M5", "severity": "MAJOR", "location": "split-csv-line.test.ts:1-45", "mechanism": "сетка: 0 error-кейсов, 0 кейсов запятой-в-кавычках → '8 pass' при 4/10 провалов spec.", "evidence": "bun test 8/0 (rc=0)", "fix": "toThrow-кейсы + '\"a,b\",c' + '\"\"\"\"'"},
    {"id": "M6", "severity": "MINOR", "location": "split-csv-line.test.ts:36-44", "mechanism": "перф-порог ×45052 от факта, нагрузка без кавычек — escape-путь не детектируется.", "evidence": "0.67 мс (rc=0)", "fix": "реалистичный порог + кавычечная нагрузка"},
    {"id": "M7", "severity": "NIT", "location": "split-csv-line.test.ts:29-34", "mechanism": "тест 'fresh array' тривиален (split().map() всегда новый массив), контракт не покрывает.", "evidence": "(rc=0)", "fix": "удалить/заменить"}
  ],
  "contract_gaps": [
    {"item": "тип/сообщение Error", "where": "spec.md:13", "why": "задан только 'бросить Error'"},
    {"item": "завершающая запятая 'a,'", "where": "spec.md:7-15", "why": "не определено; impl и эталон дают ['a',''] — допущение"},
    {"item": "пробелы вокруг полей/кавычек", "where": "spec.md", "why": "тримминг не задан"},
    {"item": "переводы строк", "where": "spec.md:3", "why": "'одна строка' не формализована"},
    {"item": "правила 10×11 на '\"\"\"\"' и '\"\"a\"\"'", "where": "spec.md:10-11", "why": "не выписано явно"},
    {"item": "'\"' (одна кавычка)", "where": "spec.md:12-14", "why": "разбирается только выводом из правила 12"},
    {"item": "границы входа/стоимость", "where": "spec.md:16", "why": "перф не нормирован, размер не ограничен"}
  ],
  "not_verified": [
    {"item": "дифф к базе", "why": "git недоступен"},
    {"item": "1 МБ+ escape-входы", "why": "экстраполяция тренда"},
    {"item": "авторское намерение по неоднозначным кейсам", "why": "spec молчит"}
  ]
}
```

Ключевое: исчерпывающий перебор 121 входа {a,\","} до длины 4 → **78 расхождений** (71 «значение
вместо Error», 7 value-mismatch); квадратичность замерена; сетка слепа; каталог кейса не изменён.
