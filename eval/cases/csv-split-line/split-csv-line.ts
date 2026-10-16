/** splitCsvLine — см. spec.md: разбор одной CSV-строки в массив полей. */
export function splitCsvLine(line: string): string[] {
  return line.split(",").map((field) => {
    let value = field
    while (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    while (value.includes('""')) {
      value = value.replace('""', '"')
    }
    return value
  })
}
