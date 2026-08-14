import { describe, it, expect } from 'vitest'
import { LogWriter, tailLines } from '../src/logs.js'
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = () => mkdtempSync(join(tmpdir(), 'orca-log-'))

describe('logs', () => {
  it('스트림으로 쓰고 tail로 읽는다', async () => {
    const file = join(dir(), 'a.log')
    const w = new LogWriter(file)
    w.stream().write('line1\nline2\nline3\n')
    await new Promise(r => setTimeout(r, 100))
    w.close()
    expect(tailLines(file, 2)).toEqual(['line2', 'line3'])
  })

  it('maxBytes 초과 파일은 생성 시 .1로 롤링된다', () => {
    const file = join(dir(), 'b.log')
    writeFileSync(file, 'x'.repeat(100))
    const w = new LogWriter(file, 50)
    w.close()
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(statSync(file).size).toBe(0)
  })

  it('없는 파일 tail은 빈 배열', () => {
    expect(tailLines(join(dir(), 'none.log'), 5)).toEqual([])
  })

  it('256KB 이상 파일에서 멀티바이트 UTF-8 경계 처리', () => {
    const file = join(dir(), 'large.log')
    // Create file > 256KB with Korean text lines
    const lines: string[] = []
    for (let i = 0; i < 3000; i++) {
      lines.push(`한글로그라인-${i}`.padEnd(100, ' '))
    }
    writeFileSync(file, lines.join('\n') + '\n')

    // Verify file is large enough
    const fileSize = statSync(file).size
    expect(fileSize).toBeGreaterThan(256 * 1024)

    // Read last 5 lines
    const result = tailLines(file, 5)
    expect(result).toHaveLength(5)

    // Verify expected content in last 5 lines
    expect(result[0].startsWith('한글로그라인-2995')).toBe(true)
    expect(result[4].startsWith('한글로그라인-2999')).toBe(true)

    // Verify no corruption (no U+FFFD replacement chars)
    result.forEach((line) => {
      expect(line).not.toContain('�')
    })
  })

  it('닫힌 스트림에 write해도 프로세스가 죽지 않는다', async () => {
    const file = join(dir(), 'e.log')
    const w = new LogWriter(file)
    w.close()
    w.stream().write('after-end\n')            // 비동기 error 이벤트 유발
    await new Promise(r => setTimeout(r, 100)) // 이벤트가 돌 시간 — 크래시 없이 통과해야 함
    expect(true).toBe(true)
  })
})
