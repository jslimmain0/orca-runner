import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export interface ProcStat { pid: number; cpuPercent: number; rssBytes: number }

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'stats-helper.ps1')
const REPLY_TIMEOUT = 2000

export class StatsCollector {
  private child?: ChildProcess
  private rl?: Interface
  private prev = new Map<number, { cpuMs: number; at: number }>()

  start(): void {
    if (this.child) return
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    this.rl = createInterface({ input: child.stdout! })
    child.once('exit', () => { if (this.child === child) this.child = undefined })
  }

  stop(): void {
    try { this.child?.stdin?.write('exit\n') } catch { /* 이미 닫힘 */ }
    this.child?.kill()
    this.child = undefined
    this.prev.clear()
  }

  helperPid(): number | undefined { return this.child?.pid }

  async sample(pids: (number | undefined)[]): Promise<Map<number, ProcStat>> {
    const out = new Map<number, ProcStat>()
    const list = pids.filter((p): p is number => p !== undefined)
    if (!this.child || !this.rl || list.length === 0) return out
    const reply = new Promise<string | null>((resolve) => {
      const onLine = (l: string) => { clearTimeout(t); resolve(l) }
      const t = setTimeout(() => { this.rl?.off('line', onLine); resolve(null) }, REPLY_TIMEOUT)
      this.rl!.once('line', onLine)
    })
    this.child.stdin!.write(list.join(',') + '\n')
    const raw = await reply
    if (raw === null) return out
    let rows: { pid: number; cpuMs: number; rss: number }[] = []
    try { rows = JSON.parse(raw) } catch { return out }
    const now = Date.now()
    const cores = os.cpus().length
    for (const r of rows) {
      const p = this.prev.get(r.pid)
      let cpuPercent = 0
      if (p && now > p.at) cpuPercent = ((r.cpuMs - p.cpuMs) / (now - p.at)) * 100 / cores
      this.prev.set(r.pid, { cpuMs: r.cpuMs, at: now })
      out.set(r.pid, { pid: r.pid, cpuPercent: Math.max(0, cpuPercent), rssBytes: r.rss })
    }
    return out
  }
}
