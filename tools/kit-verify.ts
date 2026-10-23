#!/usr/bin/env bun
/**
 * tools/kit-verify.ts — the kit's verification stand.
 *
 * Usage:
 *   bun tools/kit-verify.ts                # the kit: locales, tests, lint, types
 *   bun tools/kit-verify.ts --proj <dir>   # a project copy: agents/docs ru↔en parity
 *
 * Default mode runs the kit's standard check set (locale parity, `bun test`,
 * `biome check`, `tsc --noEmit`), prints one `PASS/FAIL <step> (rc=N, Xs)` line
 * per step and `kit-verify: N/M ok`; the exit code is 1 when any step fails.
 * Project mode compares every `agents|docs/{ru,en}/*.md` pair under `<dir>` with
 * the same contract as `tools/locale-check.ts` (the `pairIssues` helper), does
 * not run the kit's tests, and exits 2 when `<dir>` has no pairs.
 *
 * Local binaries only (`node_modules/.bin`), no network.
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { pairIssues } from "../test/support/locales"

const KIT_ROOT = fileURLToPath(new URL("..", import.meta.url))

const USAGE = [
  "usage: bun tools/kit-verify.ts              # the kit's standard checks",
  "       bun tools/kit-verify.ts --proj <dir> # agents/docs locale parity of a project copy",
].join("\n")

interface StepOutcome {
  readonly name: string
  readonly rc: number
  readonly seconds: number
  readonly output: string
}

const WINDOWS = process.platform === "win32"

/** Path of a local CLI shim under `node_modules/.bin` (relative to the kit root, never a network install). */
function localBinary(name: string): string {
  return path.join("node_modules", ".bin", WINDOWS ? `${name}.cmd` : name)
}

/** `.cmd` shims need a shell on Windows; everything else is spawned directly. */
function needsShell(command: readonly string[]): boolean {
  return WINDOWS && (command[0]?.endsWith(".cmd") ?? false)
}

async function runStep(name: string, command: readonly string[]): Promise<StepOutcome> {
  const started = performance.now()
  const child = Bun.spawn([...command], {
    cwd: KIT_ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    shell: needsShell(command),
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const rc = await child.exited
  return { name, rc, seconds: (performance.now() - started) / 1000, output: `${stdout}${stderr}` }
}

function printStep(outcome: StepOutcome): void {
  const status = outcome.rc === 0 ? "PASS" : "FAIL"
  console.log(`${status} ${outcome.name} (rc=${outcome.rc}, ${outcome.seconds.toFixed(1)}s)`)
  const output = outcome.output.trimEnd()
  if (outcome.rc !== 0 && output !== "") {
    for (const line of output.split(/\r?\n/)) console.log(`  ${line}`)
  }
}

/** Standard kit check set, in a fixed order. */
function kitSteps(): { readonly name: string; readonly command: readonly string[] }[] {
  return [
    { name: "locale-check", command: [process.execPath, "tools/locale-check.ts"] },
    { name: "test", command: [process.execPath, "test", "./test/"] },
    { name: "biome", command: [localBinary("biome"), "check", "."] },
    { name: "tsc", command: [localBinary("tsc"), "--noEmit"] },
  ]
}

async function runKitStand(): Promise<number> {
  const outcomes: StepOutcome[] = []
  for (const step of kitSteps()) {
    const outcome = await runStep(step.name, step.command)
    printStep(outcome)
    outcomes.push(outcome)
  }
  const failed = outcomes.filter((outcome) => outcome.rc !== 0).length
  console.log(`\nkit-verify: ${outcomes.length - failed}/${outcomes.length} ok`)
  return failed === 0 ? 0 : 1
}

/** Markdown file names (sorted) in a locale directory; `[]` when it is absent. */
async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

interface ProjectPair {
  readonly reference: string
  readonly translated: string
  readonly label: string
}

/** `agents/{ru,en}/*.md` and `docs/{ru,en}/*.md` under a project copy. */
async function projectPairs(directory: string): Promise<ProjectPair[]> {
  const pairs: ProjectPair[] = []
  for (const root of ["agents", "docs"]) {
    const localeRoot = path.join(directory, root)
    for (const name of await markdownFiles(path.join(localeRoot, "ru"))) {
      pairs.push({
        reference: path.join(localeRoot, "ru", name),
        translated: path.join(localeRoot, "en", name),
        label: `${root}/en/${name}`,
      })
    }
  }
  return pairs
}

async function pairIssueList(pair: ProjectPair): Promise<string[]> {
  const source = await readFile(pair.reference, "utf8").catch(() => undefined)
  if (source === undefined) return [`missing source file: ${pair.reference}`]
  const translated = await readFile(pair.translated, "utf8").catch(() => undefined)
  if (translated === undefined) return ["missing translation file"]
  return pairIssues(source, translated)
}

async function runProjectStand(directory: string): Promise<number> {
  const pairs = await projectPairs(directory)
  if (pairs.length === 0) {
    console.log(`kit-verify: no agents/** or docs/** locale pairs under ${directory}`)
    return 2
  }
  let failed = 0
  for (const pair of pairs) {
    const issues = await pairIssueList(pair)
    if (issues.length === 0) {
      console.log(`PASS  ${pair.label}`)
      continue
    }
    failed += 1
    console.log(`FAIL  ${pair.label}`)
    for (const issue of issues) console.log(`      - ${issue}`)
  }
  console.log(`\nkit-verify --proj: ${pairs.length - failed}/${pairs.length} pairs ok`)
  return failed === 0 ? 0 : 1
}

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE)
    return 0
  }
  if (args.length === 0) return runKitStand()
  if (args.length === 2 && args[0] === "--proj" && args[1] !== "") return runProjectStand(path.resolve(args[1]))
  console.error(USAGE)
  return 2
}

process.exit(await main(process.argv.slice(2)))
