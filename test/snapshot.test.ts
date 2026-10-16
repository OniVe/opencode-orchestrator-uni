/**
 * Unit tests for the deterministic state snapshot: aggregate formula,
 * exclusions, limits, abort handling and the typed failure codes.
 *
 * Every case works on a throwaway directory under the system temp dir.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEFAULT_EXCLUDE,
  aggregateLines,
  aggregateOf,
  isExcluded,
  isSnapshotFailure,
  snapshotTree,
  type SnapshotFile,
} from "../lib/snapshot"

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "audit-snapshot-"))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content, "utf8")
  }
  return root
}

function filesOf(outcome: Awaited<ReturnType<typeof snapshotTree>>): SnapshotFile[] {
  if (isSnapshotFailure(outcome)) throw new Error(`unexpected failure: ${outcome.code} ${outcome.message}`)
  return [...outcome.files]
}

/** Independent recomputation of the aggregate formula. */
function expectedAggregate(files: readonly SnapshotFile[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => `${file.path}\0${file.sha256}\n`)
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex")
}

describe("aggregate", () => {
  test("is the sha256 of sorted `relpath\\0sha256\\n` lines", () => {
    const files: SnapshotFile[] = [
      { path: "b.txt", sha256: "bb", bytes: 1 },
      { path: "a.txt", sha256: "aa", bytes: 1 },
    ]
    expect(aggregateLines(files)).toBe("a.txt\0aa\nb.txt\0bb\n")
    expect(aggregateOf(files)).toBe(expectedAggregate(files))
  })

  test("is order independent", () => {
    const one: SnapshotFile[] = [
      { path: "b", sha256: "2", bytes: 1 },
      { path: "a", sha256: "1", bytes: 1 },
    ]
    expect(aggregateOf(one)).toBe(aggregateOf([...one].reverse()))
  })

  test("of an empty tree is the sha256 of the empty string", () => {
    expect(aggregateOf([])).toBe(createHash("sha256").update("", "utf8").digest("hex"))
  })
})

describe("isExcluded", () => {
  test("matches a segment anywhere, the whole path and a relative prefix", () => {
    expect(isExcluded("node_modules/pkg/index.js", ["node_modules"])).toBe(true)
    expect(isExcluded("a/b", ["a/b"])).toBe(true)
    expect(isExcluded("lab/tmp/x.txt", ["lab/tmp"])).toBe(true)
    expect(isExcluded("lab/other/x.txt", ["lab/tmp"])).toBe(false)
    expect(isExcluded("src/index.ts", ["node_modules", ".git"])).toBe(false)
    expect(isExcluded("x/node_modules", ["./node_modules/"])).toBe(true)
    expect(isExcluded("anything", [""])).toBe(false)
  })

  test("defaults exclude node_modules, .git and .ae", () => {
    expect([...DEFAULT_EXCLUDE]).toEqual(["node_modules", ".git", ".ae"])
  })
})

describe("snapshotTree", () => {
  test("hashes every regular file with `/` separators and sorted paths", async () => {
    const root = await makeTree({ "b/b.txt": "bb", "a.txt": "a", "a/nested/c.txt": "ccc" })
    try {
      const outcome = await snapshotTree({ root })
      const files = filesOf(outcome)
      expect(files.map((file) => file.path)).toEqual(["a.txt", "a/nested/c.txt", "b/b.txt"])
      expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)
      expect(files[0]!.bytes).toBe(1)
      expect(files[1]!.bytes).toBe(3)
      if (!isSnapshotFailure(outcome)) {
        expect(outcome.aggregate).toBe(expectedAggregate(files))
        expect(outcome.root).toBe(root)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("is deterministic and changes when content or a path changes", async () => {
    const root = await makeTree({ "a.txt": "one", "b.txt": "two" })
    try {
      const first = await snapshotTree({ root })
      const second = await snapshotTree({ root })
      if (isSnapshotFailure(first) || isSnapshotFailure(second)) throw new Error("unexpected failure")
      expect(second.aggregate).toBe(first.aggregate)

      await writeFile(path.join(root, "a.txt"), "one!", "utf8")
      const changed = await snapshotTree({ root })
      if (isSnapshotFailure(changed)) throw new Error("unexpected failure")
      expect(changed.aggregate).not.toBe(first.aggregate)

      await writeFile(path.join(root, "a.txt"), "one", "utf8")
      await writeFile(path.join(root, "renamed.txt"), "two", "utf8")
      await rm(path.join(root, "b.txt"))
      const renamed = await snapshotTree({ root })
      if (isSnapshotFailure(renamed)) throw new Error("unexpected failure")
      expect(renamed.aggregate).not.toBe(first.aggregate)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("excludes defaults and custom entries", async () => {
    const root = await makeTree({
      "src/index.ts": "x",
      "node_modules/pkg/index.js": "y",
      ".git/config": "z",
      ".ae/audit.json": "w",
      "lab/tmp/scratch.txt": "s",
      "lab/keep.txt": "k",
    })
    try {
      const excluded = filesOf(await snapshotTree({ root }))
      expect(excluded.map((file) => file.path)).toEqual(["lab/keep.txt", "lab/tmp/scratch.txt", "src/index.ts"])
      const replaced = filesOf(await snapshotTree({ root, exclude: ["node_modules", "lab/tmp", "src"] }))
      expect(replaced.map((file) => file.path)).toEqual([".ae/audit.json", ".git/config", "lab/keep.txt"])
      const merged = filesOf(await snapshotTree({ root, exclude: [...DEFAULT_EXCLUDE, "lab/tmp", "src"] }))
      expect(merged.map((file) => file.path)).toEqual(["lab/keep.txt"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("E_NOT_FOUND for a missing path and for a file", async () => {
    const missing = await snapshotTree({ root: path.join(tmpdir(), "audit-snapshot-does-not-exist") })
    expect(isSnapshotFailure(missing) && missing.code).toBe("E_NOT_FOUND")

    const root = await makeTree({ "a.txt": "a" })
    try {
      const file = await snapshotTree({ root: path.join(root, "a.txt") })
      expect(isSnapshotFailure(file) && file.code).toBe("E_NOT_FOUND")
      expect(isSnapshotFailure(file) && file.message).toContain("not a directory")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("E_LIMIT_FILES and E_LIMIT_BYTES fail the whole snapshot", async () => {
    const root = await makeTree({ "a.txt": "a", "b.txt": "bb" })
    try {
      const tooMany = await snapshotTree({ root, limits: { maxFiles: 1, maxFileBytes: 1024 } })
      expect(isSnapshotFailure(tooMany) && tooMany.code).toBe("E_LIMIT_FILES")
      expect(isSnapshotFailure(tooMany) && tooMany.message).toContain("more than 1 files")

      const tooBig = await snapshotTree({ root, limits: { maxFiles: 10, maxFileBytes: 1 } })
      expect(isSnapshotFailure(tooBig) && tooBig.code).toBe("E_LIMIT_BYTES")
      expect(isSnapshotFailure(tooBig) && tooBig.message).toContain("limit is 1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("E_ABORTED when the signal is already aborted", async () => {
    const root = await makeTree({ "a.txt": "a" })
    try {
      const controller = new AbortController()
      controller.abort()
      const outcome = await snapshotTree({ root, signal: controller.signal })
      expect(isSnapshotFailure(outcome) && outcome.code).toBe("E_ABORTED")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
