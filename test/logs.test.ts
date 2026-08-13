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
})
