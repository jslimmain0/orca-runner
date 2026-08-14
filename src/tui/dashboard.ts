import type { ServiceState, ServiceStatus } from '../types.js'
import type { SysSample } from '../sysinfo.js'

const ICON: Record<string, string> = { UP: '●', STARTING: '▲', BUILDING: '■', DOWN: '○', CRASHED: '×', ERROR: '!' }
const SGR: Record<string, string> = { UP: '\x1b[32m', STARTING: '\x1b[33m', BUILDING: '\x1b[33m', DOWN: '\x1b[2m', CRASHED: '\x1b[31m', ERROR: '\x1b[35m' }
const RESET = '\x1b[0m'

export function fmtBytes(n?: number): string {
  if (n === undefined) return '-'
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB'
  return Math.round(n / 1024 ** 2) + 'MB'
}

export function truncateRow(row: string, width: number): string {
  return row.length > width ? row.slice(0, width - 1) + '…' : row
}

/** 평문 행에서 아이콘+상태 구간만 SGR로 감싼다 — 상태 텍스트가 항상 1차 신호, 색은 가속 장치 */
export function colorizeRow(row: string, status: ServiceStatus, on: boolean): string {
  if (!on) return row
  const sgr = SGR[status]
  if (!sgr) return row
  const icon = ICON[status]
  const idx = row.indexOf(icon)
  if (idx === -1) return row
  const end = row.indexOf('  ', row.indexOf(status, idx))   // 상태 셀 끝(패딩 공백)까지
  const stop = end === -1 ? row.length : end
  return row.slice(0, idx) + sgr + row.slice(idx, stop) + RESET + row.slice(stop)
}

export interface DashOpts {
  sel: number; statsOn: boolean
  width?: number; now?: number; color?: boolean; helpOverride?: string
}

function statusCell(s: ServiceState, now: number): string {
  const elapsed = s.startedAt !== undefined ? Math.max(0, Math.round((now - s.startedAt) / 1000)) : 0
  if (s.status === 'BUILDING') return `BUILDING ${elapsed}s`
  if (s.status === 'STARTING') return elapsed > 30 ? `STARTING ${elapsed}s/120s` : `STARTING ${elapsed}s`
  return s.status
}

export function dashboardLines(states: ServiceState[], sys: SysSample, opts: DashOpts): string[] {
  const width = opts.width ?? 100
  const now = opts.now ?? Date.now()
  const color = opts.color ?? false
  const svcSum = states.reduce((n, s) => n + (s.rssBytes ?? 0), 0)
  const head = ` ORCA RUNNER   시스템 CPU ${sys.cpuPercent.toFixed(0)}% · RAM ${fmtBytes(sys.usedBytes)}/${fmtBytes(sys.totalBytes)}`
    + (opts.statsOn ? (svcSum > 0 ? ` · 서비스 ${fmtBytes(svcSum)}` : '') : '  [수집 꺼짐]')
  const sep = ' ' + '─'.repeat(Math.max(10, width - 2))
  const rows = states.map((s, i) => {
    const cur = i === opts.sel ? '>' : ' '
    const name = s.def.name.padEnd(16).slice(0, 16)
    const port = String(s.def.port).padStart(5)
    const isSkip = s.skipped === true && (s.status === 'DOWN' || s.status === 'CRASHED' || s.status === 'ERROR')
    const icon = isSkip ? '◇' : (ICON[s.status] ?? '?')
    const statusText = isSkip ? (s.skipPortUp === false ? 'SKIP(!)' : 'SKIP(IDE)') : statusCell(s, now)
    const status = statusText.padEnd(19)
    const mem = opts.statsOn ? fmtBytes(s.rssBytes).padStart(8) : ''
    const cpu = opts.statsOn && s.cpuPercent !== undefined ? (s.cpuPercent.toFixed(0) + '%').padStart(5) : ''
    const note = isSkip && s.skipPortUp === false ? '  ⚠ 포트 응답 없음 (IDE에서 내려간 듯)'
      : s.error ? '  ' + s.error
      : (s.status === 'BUILDING' ? '  (빌드는 수 분 걸릴 수 있음)' : '')
    const num = i < 9 ? String(i + 1) : ' '
    const plain = truncateRow(`${cur}${num} ${icon} ${name} :${port} ${status}${mem}${cpu}${note}`, width)
    return colorizeRow(plain, s.status, color)
  })
  const help = opts.helpOverride ?? ' [↑↓/1-9]선택 [s/Enter]시작/중지 [r]재시작 [a]전체 [x]제외 [l]로그 [m]수집 [q]종료'
  return [head, sep, ...rows, sep, help]
}
