import { describe, it, expect } from 'vitest'
import { dashboardLines, fmtBytes, truncateRow, colorizeRow } from '../src/tui/dashboard.js'
import type { ServiceState } from '../src/types.js'

const st = (over: Partial<ServiceState['def']> & Partial<ServiceState> & { status: ServiceState['status'] }): ServiceState => ({
  def: { name: over.name ?? 'svc', kind: 'command', dir: 'C:\\x', port: over.port ?? 8080, heapMb: 0, cpus: 0, priority: 'normal', jvmArgs: [], run: 'r' },
  status: over.status, rssBytes: over.rssBytes, error: over.error, startedAt: over.startedAt, pid: over.pid,
})
const SYS = { cpuPercent: 41, usedBytes: 18 * 1024 ** 3, totalBytes: 63 * 1024 ** 3 }

describe('dashboard', () => {
  it('fmtBytes 단위 변환', () => {
    expect(fmtBytes(undefined)).toBe('-')
    expect(fmtBytes(500 * 1024 * 1024)).toBe('500MB')
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.5GB')
  })

  it('상태·포트·선택 표시가 들어간다', () => {
    const lines = dashboardLines(
      [st({ name: 'eis', status: 'UP', rssBytes: 480 * 1024 ** 2, port: 8081 }), st({ name: 'gw', status: 'DOWN', port: 9000 })],
      SYS,
      { sel: 1, statsOn: true, color: false },
    )
    expect(lines[0]).toContain('CPU 41%')
    const eisRow = lines.find(l => l.includes('eis'))!
    expect(eisRow).toContain('UP')
    expect(eisRow).toContain('8081')
    expect(eisRow).toContain('480MB')
    const gwRow = lines.find(l => l.includes('gw'))!
    expect(gwRow.startsWith('>')).toBe(true)      // sel=1 표시
  })

  it('ERROR 상태는 error 메시지를 노출한다', () => {
    const lines = dashboardLines([st({ name: 'bad', status: 'ERROR', error: '포트 8080 점유 중: java.exe (PID 7)' })],
      { cpuPercent: 0, usedBytes: 0, totalBytes: 1 }, { sel: 0, statsOn: false, color: false })
    expect(lines.find(l => l.includes('bad'))).toContain('포트 8080 점유 중')
  })

  it('수집 꺼짐이면 헤더에 표시된다', () => {
    const lines = dashboardLines([], { cpuPercent: 0, usedBytes: 0, totalBytes: 1 }, { sel: 0, statsOn: false, color: false })
    expect(lines[0]).toContain('수집 꺼짐')
  })

  it('truncateRow: 폭 초과 시 말줄임', () => {
    expect(truncateRow('abcdef', 4)).toBe('abc…')
    expect(truncateRow('abc', 4)).toBe('abc')
  })
})

describe('dashboard v2', () => {
  it('BUILDING 경과 시간과 힌트를 표시한다', () => {
    const lines = dashboardLines([st({ name: 'eis', status: 'BUILDING', startedAt: 100_000 })], SYS,
      { sel: 0, statsOn: false, now: 142_000, color: false })
    const row = lines.find(l => l.includes('eis'))!
    expect(row).toContain('BUILDING 42s')
    expect(row).toContain('빌드는 수 분')
  })
  it('STARTING 30초 초과 시에만 /120s 분모를 붙인다', () => {
    const mk = (elapsed: number) => dashboardLines([st({ status: 'STARTING', startedAt: 0 })], SYS,
      { sel: 0, statsOn: false, now: elapsed * 1000, color: false }).find(l => l.includes('STARTING'))!
    expect(mk(7)).toContain('STARTING 7s')
    expect(mk(7)).not.toContain('/120s')
    expect(mk(37)).toContain('STARTING 37s/120s')
  })
  it('헤더에 시스템 라벨과 서비스 합계 RAM이 표시된다', () => {
    const lines = dashboardLines([st({ status: 'UP', rssBytes: 500 * 1024 ** 2 }), st({ name: 'b', status: 'UP', rssBytes: 500 * 1024 ** 2 })],
      SYS, { sel: 0, statsOn: true, color: false })
    expect(lines[0]).toContain('시스템 CPU 41%')
    expect(lines[0]).toContain('서비스 1000MB')
  })
  it('colorizeRow: on이면 상태 토큰에 SGR, off면 평문 그대로', () => {
    const row = ' ● svc UP'
    expect(colorizeRow(row, 'UP', false)).toBe(row)
    const c = colorizeRow(row, 'UP', true)
    expect(c).toContain('\x1b[32m')
    expect(c).toContain('\x1b[0m')
  })
  it('아이콘이 상태별로 구분된다 (CRASHED × / ERROR !)', () => {
    const mk = (s: ServiceState['status']) => dashboardLines([st({ status: s })], SYS, { sel: 0, statsOn: false, color: false })[2]
    expect(mk('CRASHED')).toContain('×')
    expect(mk('ERROR')).toContain('!')
    expect(mk('STARTING')).toContain('▲')
  })
  it('상태 셀이 길어도 컬럼 정렬이 유지된다', () => {
    const a = st({ name: 'a', status: 'UP', rssBytes: 100 * 1024 ** 2 })
    const b = st({ name: 'b', status: 'STARTING', startedAt: 0, rssBytes: 100 * 1024 ** 2, port: 8081 })
    const lines = dashboardLines([a, b], SYS, { sel: 0, statsOn: true, now: 119_000, color: false })
    const memIdx = (l: string) => l.indexOf('100MB')
    expect(lines[3]).toContain('STARTING 119s/120s')
    expect(memIdx(lines[2])).toBe(memIdx(lines[3]))   // 같은 컬럼에서 시작해야 함
  })

  it('행에 표시 번호가 붙는다 (1~9, 이후 공백)', () => {
    const many = Array.from({ length: 10 }, (_, i) => st({ name: `s${i}`, status: 'DOWN' as const, port: 1000 + i }))
    const lines = dashboardLines(many, SYS, { sel: 0, statsOn: false, color: false })
    expect(lines[2]).toMatch(/^>1 /)
    expect(lines[3]).toMatch(/^ 2 /)
    expect(lines[11]).toMatch(/^ {2}○|^ {2}/)   // 10번째: 번호 없음
  })

  it('SKIP 상태 표시와 포트 비어있음 승격', () => {
    const skipped = st({ status: 'DOWN' }); skipped.skipped = true
    let lines = dashboardLines([skipped], SYS, { sel: 0, statsOn: false, color: false })
    expect(lines[2]).toContain('◇')
    expect(lines[2]).toContain('SKIP(IDE)')
    skipped.skipPortUp = false
    lines = dashboardLines([skipped], SYS, { sel: 0, statsOn: false, color: false })
    expect(lines[2]).toContain('SKIP(!)')
    expect(lines[2]).toContain('포트 응답 없음')
  })

  it('notice 줄과 배너가 공존한다', () => {
    const lines = dashboardLines([st({ status: 'DOWN' })], SYS,
      { sel: 0, statsOn: false, color: false, banner: ' 배너', notice: ' 공지' })
    expect(lines[1]).toBe(' 배너')
    expect(lines[2]).toBe(' 공지')
  })
  it('removedFromConfig/configChanged 행 노트', () => {
    const rm = st({ status: 'UP' }); rm.removedFromConfig = true
    expect(dashboardLines([rm], SYS, { sel: 0, statsOn: false, color: false })[2]).toContain('설정에서 삭제됨')
    const ch = st({ status: 'UP' }); ch.configChanged = true
    expect(dashboardLines([ch], SYS, { sel: 0, statsOn: false, color: false })[2]).toContain('r로 반영')
  })
})
