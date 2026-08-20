import { describe, it, expect } from 'vitest'
import { helpText, groupSummary } from '../src/cli.js'
import type { Config } from '../src/types.js'

const base = { kind: 'command' as const, dir: 'C:\\x', run: 'r', heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [], env: {} }

describe('help/groups', () => {
  it('helpText: 첫 10분 경로와 자동화 섹션이 분리돼 있다', () => {
    const h = helpText()
    expect(h).toContain('처음이라면')
    expect(h).toContain('자동화·조회')
    expect(h).toContain('orca setup')
    expect(h).toContain('예약어')
  })
  it('groupSummary: 그룹별 서비스 수와 이름', () => {
    const cfg: Config = { services: [
      { ...base, name: 'a', port: 1, group: 'tspay' },
      { ...base, name: 'b', port: 2, group: 'tspay' },
      { ...base, name: 'c', port: 3 },
    ] }
    const g = groupSummary(cfg)
    expect(g.some(l => l.includes('tspay') && l.includes('2개') && l.includes('a'))).toBe(true)
    expect(g.some(l => l.includes('(그룹 없음)') && l.includes('c'))).toBe(true)
  })
})
