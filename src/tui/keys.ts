export type Key = 'up' | 'down' | 'enter' | 'esc' | 's' | 'a' | 'l' | 'm' | 'q' | 'other'

export function parseKey(b: Buffer): Key {
  const s = b.toString('utf8')
  if (s === '\x1b[A') return 'up'
  if (s === '\x1b[B') return 'down'
  if (s === '\r') return 'enter'
  if (s === '\x1b') return 'esc'
  if (s === '\x03') return 'q'   // Ctrl+C — app.ts stdin 핸들러가 앱 레벨에서 선처리하므로 이 분기엔 도달하지 않음(하위 호환용 유지)
  const c = s.toLowerCase()
  if (c === 's' || c === 'a' || c === 'l' || c === 'm' || c === 'q') return c
  return 'other'
}
