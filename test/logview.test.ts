import { describe, it, expect } from 'vitest'
import { logViewLines, maxOffset } from '../src/tui/logView.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = () => mkdtempSync(join(tmpdir(), 'orca-lv-'))

describe('logView', () => {
  it('maxOffset: 전체 줄 수 - 표시 줄 수', () => {
    const f = join(dir(), 'a.log')
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n')
    expect(maxOffset(f, 6)).toBe(5)     // 10줄, 화면 5줄(rows-1) → 최대 5
    expect(maxOffset(f, 100)).toBe(0)
  })
  it('offset이 상한을 넘어도 빈 화면이 되지 않는다', () => {
    const f = join(dir(), 'b.log')
    writeFileSync(f, 'one\ntwo\nthree\n')
    const lines = logViewLines('svc', f, 3, 999)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]).toBe('one')        // 가장 오래된 줄에서 클램프
    expect(lines[0]).toContain('[-')
  })
  it('빈/없는 로그는 안내 문구', () => {
    const lines = logViewLines('svc', join(dir(), 'none.log'), 5, 0)
    expect(lines[1]).toContain('기록된 로그가 없습니다')
    expect(lines[0]).toContain('[최신]')
  })
  it('최신 위치 헤더', () => {
    const f = join(dir(), 'c.log')
    writeFileSync(f, 'x\n')
    expect(logViewLines('svc', f, 5, 0)[0]).toContain('[최신]')
  })
})
