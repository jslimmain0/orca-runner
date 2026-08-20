import { describe, it, expect } from 'vitest'
import { recommend, applyRecommendation } from '../src/advise.js'
import { loadConfigFromString } from '../src/config.js'
import type { ServiceDef } from '../src/types.js'

const springDef = (over: Partial<ServiceDef> = {}): ServiceDef => ({
  name: 'a', kind: 'spring', dir: 'C:\\x', port: 1,
  heapMb: 512, cpus: 2, priority: 'belowNormal', jvmArgs: [], env: {}, metaspaceMb: 256, ...over,
})
const entry = (over: object) => ({ sessions: 3, peakRssMb: 400, updatedAt: 'x', ...over })

describe('recommend', () => {
  it('힙 90% 초과 → 상향', () => {
    const r = recommend(springDef(), entry({ peakHeapMb: 480 }))!
    expect(r.heapMb).toBeGreaterThan(512)
  })
  it('힙 35% 미만 + 세션 2회 이상 → 하향 (128 스텝, 최소 256)', () => {
    const r = recommend(springDef(), entry({ peakHeapMb: 100 }))!
    expect(r.heapMb).toBe(256)
  })
  it('세션 1회면 하향 추천 안 함, 상향은 함', () => {
    expect(recommend(springDef(), entry({ sessions: 1, peakHeapMb: 100 }))).toBeNull()
    expect(recommend(springDef(), entry({ sessions: 1, peakHeapMb: 500 }))).not.toBeNull()
  })
  it('Full GC 빈발 → 힙 상향', () => {
    const r = recommend(springDef(), entry({ peakHeapMb: 300, fgcAvg: 35 }))!
    expect(r.heapMb).toBeGreaterThan(512)
    expect(r.reasons.join()).toMatch(/GC/)
  })
  it('메타 85% 초과 → 상향, 40% 미만 → 하향(최소 128)', () => {
    expect(recommend(springDef(), entry({ peakMetaMb: 230 }))!.metaspaceMb).toBeGreaterThan(256)
    expect(recommend(springDef(), entry({ peakMetaMb: 60 }))!.metaspaceMb).toBe(128)
  })
  it('command/무데이터/변화없음 → null', () => {
    expect(recommend(springDef({ kind: 'command', run: 'r' }), entry({ peakHeapMb: 100 }))).toBeNull()
    expect(recommend(springDef(), undefined)).toBeNull()
    expect(recommend(springDef(), entry({ peakHeapMb: 300 }))).toBeNull()   // 0.35~0.9 사이
  })
})

describe('applyRecommendation', () => {
  const SRC = '# 주석\nservices:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    heapMb: 512\n'
  it('heapMb/metaspaceMb를 주석 보존하며 갱신한다', () => {
    const out = applyRecommendation(SRC, 'a', { heapMb: 256, metaspaceMb: 128, reasons: [] })
    expect(out).toContain('# 주석')
    const cfg = loadConfigFromString(out)
    expect(cfg.services[0].heapMb).toBe(256)
    expect(cfg.services[0].metaspaceMb).toBe(128)
  })
  it('미등록 이름 throw', () => {
    expect(() => applyRecommendation(SRC, 'nope', { heapMb: 256, reasons: [] })).toThrowError(/등록/)
  })
})
