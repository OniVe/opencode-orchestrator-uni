/** parseDuration — см. spec.md: строки вида "1h30m" → миллисекунды. */
const FACTORS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const

export function parseDuration(input: string): number {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g
  let total = 0
  let found = false
  for (const match of input.matchAll(pattern)) {
    found = true
    total += Number(match[1]) * FACTORS[match[2] as keyof typeof FACTORS]
  }
  if (!found) throw new Error(`Invalid duration: ${input}`)
  return total
}
