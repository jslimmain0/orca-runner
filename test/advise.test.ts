import { describe, it, expect } from 'vitest'
import { recommend, applyRecommendation } from '../src/advise.js'
import { loadConfigFromString } from '../src/config.js'
import type { ServiceDef } from '../src/types.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// 실제 orca CLI를 서브프로세스로 띄워 exit code 계약을 검증한다(headless-e2e/cli.test.ts와 동일한
// 서브프로세스 하네스 패턴). "orca advise는 항상 exit 0"이라는 구현 오해로 깨진/빈 설정에서까지
// exit 0을 내던 회귀(리뷰에서 발견)를 status/groups와의 계약 일치로 고정한다.
function runCli(args: string[], home: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home }, windowsHide: true,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

function makeHome(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-adv-'))
  mkdirSync(join(home, '.orca'), { recursive: true })
  writeFileSync(join(home, '.orca', 'services.yaml'), yaml)
  return home
}

describe('runAdvise: exit code 계약 (서브프로세스)', () => {
  it('깨진 config → advise도 status/groups처럼 exit 1', () => {
    const home = makeHome('services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: notanumber\n')
    const advise = runCli(['advise'], home)
    const status = runCli(['status'], home)
    const groups = runCli(['groups'], home)
    expect(advise.code).toBe(1)
    expect(status.code).toBe(1)
    expect(groups.code).toBe(1)
    expect(advise.stderr).toMatch(/port/)
  }, 15000)

  it('설정 파일 자체가 없으면 exit 1', () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-adv-'))   // .orca/services.yaml 없음
    const r = runCli(['advise'], home)
    expect(r.code).toBe(1)
  }, 15000)

  it('서비스 등록은 있지만 목록이 비면(services: {}) exit 1', () => {
    const home = makeHome('services: {}\n')
    const r = runCli(['advise'], home)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/등록된 서비스가 없습니다/)
  }, 15000)

  it('정상 config + 추천 없음(usage 기록 없음) → exit 0', () => {
    const home = makeHome('services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n')
    const r = runCli(['advise'], home)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('a (:1)')
  }, 15000)
})
