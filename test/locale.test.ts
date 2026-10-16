/**
 * Locale resolution: tag parsing and candidate picking are pure functions —
 * the OS/env-dependent part is confined to the candidate list built in
 * `index.ts`, so these tests stay deterministic on every machine and CI.
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_LOCALE, parseLocaleTag, pickLocale } from "../index"

describe("locale resolution", () => {
  test("parseLocaleTag normalizes real-world tags", () => {
    expect(parseLocaleTag("ru")).toBe("ru")
    expect(parseLocaleTag("ru-RU")).toBe("ru")
    expect(parseLocaleTag("RU")).toBe("ru")
    expect(parseLocaleTag("en_US.UTF-8")).toBe("en")
    expect(parseLocaleTag("  ru  ")).toBe("ru")
  })

  test("parseLocaleTag rejects unsupported or malformed values", () => {
    expect(parseLocaleTag("fr")).toBeUndefined()
    expect(parseLocaleTag("C.UTF-8")).toBeUndefined()
    expect(parseLocaleTag("de-DE")).toBeUndefined()
    expect(parseLocaleTag(42)).toBeUndefined()
    expect(parseLocaleTag(undefined)).toBeUndefined()
    expect(parseLocaleTag("")).toBeUndefined()
  })

  test("pickLocale takes the first supported candidate", () => {
    expect(pickLocale(["fr-FR", "ru-RU", "en"])).toBe("ru")
    expect(pickLocale(["de", "en-GB"])).toBe("en")
    expect(pickLocale(["ru"])).toBe("ru")
  })

  test("pickLocale falls back to the default locale", () => {
    expect(pickLocale([])).toBe(DEFAULT_LOCALE)
    expect(pickLocale(["fr", "C"])).toBe(DEFAULT_LOCALE)
  })
})
