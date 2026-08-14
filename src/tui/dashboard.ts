import type { ServiceState } from '../types.js'
import type { SysSample } from '../sysinfo.js'

const ICON: Record<string, string> = { UP: '●', STARTING: '◐', BUILDING: '◔', DOWN: '○', CRASHED: '✖', ERROR: '✖' }

export function fmtBytes(n?: number): string {
  if (n === undefined) return '-'
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB'
  return Math.round(n / 1024 ** 2) + 'MB'
}

export function truncateRow(row: string, width: number): string {
  return row.length > width ? row.slice(0, width - 1) + '…' : row
}

export function dashboardLines(states: ServiceState[], sys: SysSample, sel: number, statsOn: boolean, width = 100): string[] {
  const head = ` ORCA RUNNER   CPU ${sys.cpuPercent.toFixed(0)}%  RAM ${fmtBytes(sys.usedBytes)}/${fmtBytes(sys.totalBytes)}${statsOn ? '' : '  [수집 꺼짐]'}`
  const sep = ' ' + '─'.repeat(Math.max(10, width - 2))
  const rows = states.map((s, i) => {
    const cur = i === sel ? '>' : ' '
    const name = s.def.name.padEnd(16).slice(0, 16)
    const port = String(s.def.port).padStart(5)
    const status = s.status.padEnd(9)
    const mem = statsOn ? fmtBytes(s.rssBytes).padStart(8) : ''
    const cpu = statsOn && s.cpuPercent !== undefined ? (s.cpuPercent.toFixed(0) + '%').padStart(5) : ''
    const err = s.error ? '  ' + s.error : ''
    return truncateRow(`${cur}${ICON[s.status] ?? '?'} ${name} :${port} ${status}${mem}${cpu}${err}`, width)
  })
  const help = ' [↑↓]선택 [s]시작/중지 [a]전체시작 [l]로그 [m]수집 [q]종료'
  return [head, sep, ...rows, sep, help]
}
