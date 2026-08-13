import { describe, it, expect } from 'vitest'
import { dashboardLines, fmtBytes } from '../src/tui/dashboard.js'
import type { ServiceState } from '../src/types.js'

const st = (over: Partial<ServiceState['def']> & { status: ServiceState['status']; rssBytes?: number; error?: string }): ServiceState => ({
  def: { name: over.name ?? 'svc', kind: 'command', dir: 'C:\\x', port: over.port ?? 8080, heapMb: 0, cpus: 0, priority: 'normal', jvmArgs: [], run: 'r' },
  status: over.status, rssBytes: over.rssBytes, error: over.error,
})

describe('dashboard', () => {
  it('fmtBytes 단위 변환', () => {
    expect(fmtBytes(undefined)).toBe('-')
    expect(fmtBytes(500 * 1024 * 1024)).toBe('500MB')
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.5GB')
  })

  it('상태·포트·선택 표시가 들어간다', () => {
    const lines = dashboardLines(
      [st({ name: 'eis', status: 'UP', rssBytes: 480 * 1024 ** 2, port: 8081 }), st({ name: 'gw', status: 'DOWN', port: 9000 })],
      { cpuPercent: 41, usedBytes: 18 * 1024 ** 3, totalBytes: 63 * 1024 ** 3 },
      1, true,
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
      { cpuPercent: 0, usedBytes: 0, totalBytes: 1 }, 0, false)
    expect(lines.find(l => l.includes('bad'))).toContain('포트 8080 점유 중')
  })

  it('수집 꺼짐이면 헤더에 표시된다', () => {
    const lines = dashboardLines([], { cpuPercent: 0, usedBytes: 0, totalBytes: 1 }, 0, false)
    expect(lines[0]).toContain('수집 꺼짐')
  })
})
