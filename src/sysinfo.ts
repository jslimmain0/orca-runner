import os from 'node:os'

export interface SysSample { cpuPercent: number; usedBytes: number; totalBytes: number }

let prev: { idle: number; total: number } | undefined

/** os.cpus() 틱 델타로 시스템 전체 CPU% — 프로세스 스폰 없음, 비용 무시 가능 */
export function sampleSystem(): SysSample {
  let idle = 0, total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  let cpuPercent = 0
  if (prev && total > prev.total) cpuPercent = 100 * (1 - (idle - prev.idle) / (total - prev.total))
  prev = { idle, total }
  return { cpuPercent: Math.max(0, cpuPercent), usedBytes: os.totalmem() - os.freemem(), totalBytes: os.totalmem() }
}
