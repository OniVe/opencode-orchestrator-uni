/** normalizeTags — см. spec.md: нормализация списка тегов. */
export function normalizeTags(items: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of items) {
    const tag = raw.trim().toLowerCase()
    if (out.includes(tag)) continue
    out.push(tag)
  }
  return out.sort()
}
