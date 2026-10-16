import { describe, expect, test } from "bun:test"
import { splitCsvLine } from "./split-csv-line.ts"

describe("splitCsvLine", () => {
  test("splits simple fields", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"])
  })

  test("single field", () => {
    expect(splitCsvLine("a")).toEqual(["a"])
  })

  test("empty line gives one empty field", () => {
    expect(splitCsvLine("")).toEqual([""])
  })

  test("strips surrounding quotes", () => {
    expect(splitCsvLine('"a b",c')).toEqual(["a b", "c"])
  })

  test("unescapes doubled quotes", () => {
    expect(splitCsvLine('"a""b",c')).toEqual(['a"b', "c"])
  })

  test("quoted empty field", () => {
    expect(splitCsvLine('""')).toEqual([""])
  })

  test("returns a fresh array every call", () => {
    const first = splitCsvLine("a,b")
    const second = splitCsvLine("a,b")
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })

  test("handles large simple lines", () => {
    const line = Array.from({ length: 5000 }, (_, i) => `v${i}`).join(",")
    const start = performance.now()
    const out = splitCsvLine(line)
    const elapsed = performance.now() - start
    expect(out.length).toBe(5000)
    expect(out[0]).toBe("v0")
    expect(elapsed).toBeLessThan(30_000)
  })
})
