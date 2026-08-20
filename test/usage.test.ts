import { describe, it, expect } from 'vitest'
import { parseJstatGc, readUsage, mergeSession, writeUsage } from '../src/usage.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const JSTAT = ` S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC     YGCT    FGC    FGCT     GCT
 8704.0 8704.0  0.0   6816.0 69952.0  35108.3   175104.0   98230.5  121208.0 115726.0 15736.0 14522.4     42    0.586   3      0.208    0.794`

describe('usage', () => {
  it('parseJstatGc: 힙 합산·메타·FGC·GCT를 뽑는다', () => {
    const r = parseJstatGc(JSTAT)!
    expect(Math.round(r.heapUsedKb)).toBe(Math.round(0 + 6816.0 + 35108.3 + 98230.5))
    expect(r.metaUsedKb).toBeCloseTo(115726.0)
    expect(r.fullGc).toBe(3)
    expect(r.gcTimeSec).toBeCloseTo(0.794)
  })
  it('parseJstatGc: 쉼표 소수점 정규화, 컬럼 누락 시 null', () => {
    expect(parseJstatGc(JSTAT.replace('0.794', '0,794'))!.gcTimeSec).toBeCloseTo(0.794)
    expect(parseJstatGc('S0C S1C\n1 2')).toBeNull()
  })
  it('mergeSession: peak는 max, fgcAvg는 이동평균, sessions 증가', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'orca-us-')), 'usage.json')
    let u = readUsage(p)
    u = mergeSession(u, 'svc', { peakRssMb: 300, heapMb: 200, metaMb: 100, fgc: 2 })
    u = mergeSession(u, 'svc', { peakRssMb: 250, heapMb: 260, metaMb: 90, fgc: 6 })
    writeUsage(u, p)
    const r = readUsage(p)['svc']
    expect(r.sessions).toBe(2)
    expect(r.peakRssMb).toBe(300)
    expect(r.peakHeapMb).toBe(260)
    expect(r.peakMetaMb).toBe(100)
    expect(r.fgcAvg).toBeCloseTo(4)
  })
})
