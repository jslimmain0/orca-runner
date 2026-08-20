import { describe, it, expect } from 'vitest'
import { writeLastSession, readLastSession, resumeSet, failedSet } from '../src/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/types.js'

const base = { kind: 'command' as const, dir: 'C:\\x', run: 'r', heapMb: 0, metaspaceMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [], env: {} }
const cfg: Config = { services: [{ ...base, name: 'a', port: 1 }, { ...base, name: 'b', port: 2 }] }

describe('session', () => {
  it('스냅샷 라운드트립과 재개/실패 세트 계산', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'orca-ss-')), 'last-session.json')
    writeLastSession([
      { name: 'a', status: 'UP' }, { name: 'b', status: 'CRASHED' }, { name: 'deleted', status: 'UP' },
    ], p)
    const s = readLastSession(p)
    expect(s).not.toBeNull()
    expect(resumeSet(s, cfg)).toEqual(['a'])          // CRASHED 제외, 삭제된 이름 필터
    expect(failedSet(s, cfg)).toEqual(['b'])
  })
  it('파일 없으면 null, resumeSet은 빈 배열', () => {
    expect(readLastSession(join(mkdtempSync(join(tmpdir(), 'orca-ss-')), 'x.json'))).toBeNull()
    expect(resumeSet(null, cfg)).toEqual([])
  })
})
