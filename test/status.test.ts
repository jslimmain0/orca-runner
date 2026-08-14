import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { statusReport } from '../src/status.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../src/types.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const PORT = 45851
let child: ChildProcess
beforeAll(async () => {
  child = spawn(process.execPath, [FIXTURE, String(PORT)], { windowsHide: true })
  await new Promise<void>(r => child.stdout!.once('data', () => r()))
})
afterAll(() => { child.kill() })

const base = { kind: 'command' as const, dir: process.cwd(), run: 'x', heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
const cfg: Config = { services: [
  { ...base, name: 'live', port: PORT, health: `http://localhost:${PORT}/health` },
  { ...base, name: 'gone', port: 45852 },
] }

describe('status', () => {
  it('살아있는 프로세스+프로브 통과=UP, 기록 없음=DOWN, exit 1', async () => {
    const runPath = join(mkdtempSync(join(tmpdir(), 'orca-st-')), 'run.json')
    writeFileSync(runPath, JSON.stringify({ live: { pid: child.pid, owner: 0 } }))
    const r = await statusReport({ cfg, runPath })
    const live = r.rows.find(x => x.name === 'live')!
    expect(live.status).toBe('UP')
    expect(live.owner).toBe('headless')
    expect(r.rows.find(x => x.name === 'gone')!.status).toBe('DOWN')
    expect(r.exitCode).toBe(1)
  })
  it('전부 UP이면 exit 0', async () => {
    const runPath = join(mkdtempSync(join(tmpdir(), 'orca-st-')), 'run.json')
    writeFileSync(runPath, JSON.stringify({ live: { pid: child.pid, owner: 0 } }))
    const one: Config = { services: [cfg.services[0]] }
    expect((await statusReport({ cfg: one, runPath })).exitCode).toBe(0)
  })
})
