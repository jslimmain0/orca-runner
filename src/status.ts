import { loadConfig } from './config.js'
import { readRunEntries, isAlive } from './procctl.js'
import { httpUp, portListening } from './health.js'
import type { Config } from './types.js'

export interface StatusRow { name: string; port: number; status: 'UP' | 'NO-RESPONSE' | 'DOWN'; pid?: number; owner?: string }

export async function statusReport(opts: { cfg: Config; runPath?: string }): Promise<{ rows: StatusRow[]; exitCode: number }> {
  const entries = opts.runPath === undefined ? readRunEntries() : readRunEntries(opts.runPath)
  const rows: StatusRow[] = []
  for (const s of opts.cfg.services) {
    const rec = entries[s.name]
    const alive = rec !== undefined && isAlive(rec.pid)
    if (!alive) { rows.push({ name: s.name, port: s.port, status: 'DOWN' }); continue }
    const probeOk = s.health ? await httpUp(s.health) : await portListening(s.port)
    const owner = rec.owner === 0 ? 'headless' : rec.owner > 0 && isAlive(rec.owner) ? `세션 ${rec.owner}` : '불명'
    rows.push({ name: s.name, port: s.port, status: probeOk ? 'UP' : 'NO-RESPONSE', pid: rec.pid, owner })
  }
  return { rows, exitCode: rows.every(r => r.status === 'UP') ? 0 : 1 }
}

export async function runStatus(json: boolean): Promise<void> {
  const cfg = loadConfig()
  const { rows, exitCode } = await statusReport({ cfg })
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    for (const r of rows) {
      const pid = r.pid ? `pid ${r.pid}` : ''
      const owner = r.owner ? `(${r.owner})` : ''
      console.log(`${r.name.padEnd(16)} ${r.status.padEnd(12)} :${String(r.port).padStart(5)}  ${pid} ${owner}`.trimEnd())
    }
  }
  process.exitCode = exitCode
}
