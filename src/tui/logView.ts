import { tailLines } from '../logs.js'

export function maxOffset(file: string, rows: number): number {
  return Math.max(0, tailLines(file, 500).length - (rows - 1))
}

export function logViewLines(name: string, file: string, rows: number, offset: number, width = 160): string[] {
  const all = tailLines(file, 500)
  const capped = Math.min(offset, Math.max(0, all.length - (rows - 1)))
  const pos = capped === 0 ? '[최신]' : `[-${capped}줄]`
  const keys = capped === 0 ? '(↑↓ 스크롤, Esc/q 복귀)' : '(↓ 최신으로, Esc/q 복귀)'
  const header = ` LOG: ${name} ${pos} ${keys}`
  if (all.length === 0) return [header, '(기록된 로그가 없습니다)']
  const end = Math.max(0, all.length - capped)
  const start = Math.max(0, end - (rows - 1))
  return [header, ...all.slice(start, end).map(l => l.slice(0, width))]
}
