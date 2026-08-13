import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

describe('cli', () => {
  it('--version 이 버전을 출력한다', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], { encoding: 'utf8' })
    expect(out.trim()).toBe('0.1.0')
  })
})
