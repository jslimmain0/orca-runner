export type Key = 'up' | 'down' | 'enter' | 'esc' | 's' | 'a' | 'l' | 'm' | 'q' | 'other'

export function parseKey(b: Buffer): Key {
  const s = b.toString('utf8')
  if (s === '\x1b[A') return 'up'
  if (s === '\x1b[B') return 'down'
  if (s === '\r') return 'enter'
  if (s === '\x1b') return 'esc'
  if (s === '\x03') return 'q'   // Ctrl+C도 정상 종료 경로로
  const c = s.toLowerCase()
  if (c === 's' || c === 'a' || c === 'l' || c === 'm' || c === 'q') return c
  return 'other'
}
