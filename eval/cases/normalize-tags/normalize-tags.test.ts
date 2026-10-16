import { describe, expect, test } from "bun:test"
import { normalizeTags } from "./normalize-tags.ts"

describe("normalizeTags", () => {
  test("trims and lowercases", () => {
    expect(normalizeTags([" B ", "a", "C"])).toEqual(["a", "b", "c"])
  })

  test("removes duplicates", () => {
    expect(normalizeTags(["x", "x", " y"])).toEqual(["x", "y"])
  })

  test("sorts ascending", () => {
    expect(normalizeTags(["z", "m", "a"])).toEqual(["a", "m", "z"])
  })

  test("returns a new array", () => {
    const input = ["b", "a"]
    const out = normalizeTags(input)
    expect(out).not.toBe(input)
    expect(input).toEqual(["b", "a"])
  })

  test("handles large lists", () => {
    const items = Array.from({ length: 2000 }, (_, i) => `tag${i}`)
    const start = performance.now()
    const out = normalizeTags(items)
    const elapsed = performance.now() - start
    expect(out.length).toBe(2000)
    expect(elapsed).toBeLessThan(30_000)
  })
})
