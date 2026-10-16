import { describe, expect, test } from "bun:test"
import { parseDuration } from "./parse-duration"

/**
 * Таблица из spec.md + кейсы находок раунда 1.
 * Валидные входы: значение, невалидные: Error (не значение).
 */
const VALID: Array<[string, number]> = [
  ["1h30m", 5_400_000],
  ["90s", 90_000],
  ["500ms", 500],
  ["1.5h", 5_400_000],
  ["30m1h", 5_400_000],
  ["2h", 7_200_000],
]

const INVALID: string[] = [
  // spec.md, раздел «Невалидный ввод»
  "",
  "1h30",
  "-1s",
  "1x2s",
  "1s!",
  "5d",
  "1e309h",
  // S1: частичные совпадения (мусор вокруг/внутри пар)
  "x1s",
  "1min",
  ".5h",
  // S4: пробельные варианты (пробел, nbsp, перевод строки внутри входа)
  "1 h",
  "1\u00a0h",
  "1h\n30m",
  // S2: переполнение до бесконечности
  "9".repeat(400) + "h",
  "9".repeat(400) + "h9".repeat(1) + "h",
]

describe("parseDuration: таблица spec.md", () => {
  for (const [input, expected] of VALID) {
    test(`valid ${JSON.stringify(input)} → ${expected}`, () => {
      expect(parseDuration(input)).toBe(expected)
    })
  }

  test("все валидные входы дают конечное число", () => {
    for (const [input] of VALID) expect(Number.isFinite(parseDuration(input))).toBe(true)
  })

  for (const input of INVALID) {
    const label = input.length > 24 ? `${JSON.stringify(input.slice(0, 24))}…(len ${input.length})` : JSON.stringify(input)
    test(`invalid ${label} → Error`, () => {
      expect(() => parseDuration(input)).toThrow(Error)
    })
  }

  test("overflow: результат не может быть Infinity", () => {
    expect(() => parseDuration("1".repeat(400) + "h")).toThrow(Error)
  })
})

describe("parseDuration: линейный разбор (S3)", () => {
  test("n=80k цифр без единицы — Error за < 1 c", () => {
    const t0 = performance.now()
    expect(() => parseDuration("1".repeat(80_000))).toThrow(Error)
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(1_000)
  })

  test("n=200k цифр без единицы — Error за < 1 c", () => {
    const t0 = performance.now()
    expect(() => parseDuration("1".repeat(200_000))).toThrow(Error)
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(1_000)
  })

  test("n=200k цифр + 'h' — быстро, не Infinity (Error по переполнению)", () => {
    const t0 = performance.now()
    expect(() => parseDuration("1".repeat(200_000) + "h")).toThrow(Error)
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(1_000)
  })
})
