# Самопроверка матчера (исторические отчёты)

Ключ: `cases/csv-split-line/manifest.json` (K1/MAJOR, K2/MAJOR, K3/MINOR, K4/MINOR).
Источники: `dev-notes/fixtures/csv-baseline-empiric.md`, `dev-notes/fixtures/csv-baseline-invariant.md`
(baseline-прогон того же кейса на `deepseek/deepseek-flash`, сессии `ses_ec55a05dcffe…` / `ses_ec55a05dbffe…`).

Ожидание: матчер должен вытащить оба MAJOR (K1, K2) у обеих ролей — это калибровка сигнатур
(исторические отчёты — эталон стиля живых ролей).

## audit-empiric
| роль | отчёт валиден | найдено | не найдено | recall | кандидатов |
| --- | --- | --- | --- | --- | --- |
| audit-empiric | нет (E_PARSE) | K1, K2, K4 | K3 | 0.75 (MAJOR 1) | 0 |
| audit-invariant | нет (E_INVALID) | K1, K2, K3, K4 | — | 1 (MAJOR 1) | 0 |


```
{
  "valid": false,
  "code": "E_PARSE",
  "warnings": [],
  "matched": [
    "K1",
    "K2",
    "K4"
  ],
  "missed": [
    "K3"
  ],
  "recall": 0.75,
  "recallMajor": 1,
  "detail": [
    {
      "id": "K1",
      "severity": "MAJOR",
      "matched": true,
      "hits": [
        [
          "a\\s*,\\s*b"
        ],
        [
          "line\\.split"
        ]
      ]
    },
    {
      "id": "K2",
      "severity": "MAJOR",
      "matched": true,
      "hits": [
        [
          "throw"
        ],
        [
          "ab[\"'\\\\]*cd",
          "a[\"'\\\\]*x",
          "unclosed"
        ]
      ]
    },
    {
      "id": "K3",
      "severity": "MINOR",
      "matched": false,
      "hits": [
        [],
        [
          "while"
        ]
      ]
    },
    {
      "id": "K4",
      "severity": "MINOR",
      "matched": true,
      "hits": [
        [
          "тест",
          "сетк"
        ],
        [
          "порог",
          "запас",
          "перф",
          "30.?000",
          "tothrow"
        ]
      ]
    }
  ]
}
```

## audit-invariant

```
{
  "valid": false,
  "code": "E_INVALID",
  "warnings": [],
  "matched": [
    "K1",
    "K2",
    "K3",
    "K4"
  ],
  "missed": [],
  "recall": 1,
  "recallMajor": 1,
  "detail": [
    {
      "id": "K1",
      "severity": "MAJOR",
      "matched": true,
      "hits": [
        [
          "a\\s*,\\s*b"
        ],
        [
          "split\\s*\\(\\s*[\"'`]?,[\"'`]*\\s*\\)",
          "line\\.split"
        ]
      ]
    },
    {
      "id": "K2",
      "severity": "MAJOR",
      "matched": true,
      "hits": [
        [
          "throw",
          "исключени"
        ],
        [
          "ab[\"'\\\\]*cd",
          "a[\"'\\\\]*x"
        ]
      ]
    },
    {
      "id": "K3",
      "severity": "MINOR",
      "matched": true,
      "hits": [
        [
          "квадратич"
        ],
        [
          "while",
          "replace"
        ]
      ]
    },
    {
      "id": "K4",
      "severity": "MINOR",
      "matched": true,
      "hits": [
        [
          "тест",
          "сетк"
        ],
        [
          "порог",
          "перф",
          "tothrow",
          "не покрыва"
        ]
      ]
    }
  ]
}
```
