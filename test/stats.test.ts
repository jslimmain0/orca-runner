import { describe, it, expect } from 'vitest'
import { StatsCollector } from '../src/stats.js'
import { sampleSystem } from '../src/sysinfo.js'
import { isAlive } from '../src/procctl.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('stats', () => {
  it('자기 자신의 RSS를 수집하고, 헬퍼는 샘플 간에 재스폰되지 않는다', async () => {
    const c = new StatsCollector()
    c.start()
    const helper1 = c.helperPid()
    const m1 = await c.sample([process.pid])
    expect(m1.get(process.pid)!.rssBytes).toBeGreaterThan(10 * 1024 * 1024)
    await sleep(500)
    const m2 = await c.sample([process.pid])
    expect(m2.get(process.pid)!.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(c.helperPid()).toBe(helper1)          // 장수명 1개 — 재스폰 금지
    const hp = helper1!
    c.stop()
    await sleep(1000)
    expect(isAlive(hp)).toBe(false)              // stop이 헬퍼를 정리
  }, 20000)

  it('죽은 pid는 결과에서 빠진다', async () => {
    const c = new StatsCollector()
    c.start()
    const m = await c.sample([process.pid, 4000000])
    expect(m.has(process.pid)).toBe(true)
    expect(m.has(4000000)).toBe(false)
    c.stop()
  }, 15000)

  it('sampleSystem: 두 번째 호출부터 0~100 사이 CPU%', async () => {
    sampleSystem()
    await sleep(300)
    const s = sampleSystem()
    expect(s.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(s.cpuPercent).toBeLessThanOrEqual(100)
    expect(s.totalBytes).toBeGreaterThan(0)
  })
})
