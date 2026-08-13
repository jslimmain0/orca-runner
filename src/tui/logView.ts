import { tailLines } from '../logs.js'

export function logViewLines(name: string, file: string, rows: number, offset: number, width = 160): string[] {
  const all = tailLines(file, 500)
  const end = Math.max(0, all.length - offset)
  const start = Math.max(0, end - (rows - 1))
  const view = all.slice(start, end).map(l => l.slice(0, width))
  return [` LOG: ${name}  (↑↓ 스크롤, Esc 복귀)`, ...view]
}
