import { describe, it, expect, afterEach } from 'vitest'
import { Supervisor } from '../src/supervisor.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { Config } from '../src/types.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')

function cfg(port1: number, port2: number): Config {
  const base = { kind: 'command' as const, dir: process.cwd(), heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
  return {
    services: [
      { ...base, name: 'dummy-a', run: `node "${FIXTURE}" ${port1}`, port: port1, health: `http://localhost:${port1}/health` },
      { ...base, name: 'dummy-b', run: `node "${FIXTURE}" ${port2}`, port: port2 },   // health 없음 → 포트 판정
    ],
  }
}

let sup: Supervisor
afterEach(async () => { await sup?.stopAll() })

describe('supervisor', () => {
  it('startAll로 전부 UP, stopAll로 전부 DOWN', async () => {
    sup = new Supervisor(cfg(45821, 45822), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.startAll()
    expect(sup.states().map(s => s.status)).toEqual(['UP', 'UP'])
    await sup.stopAll()
    expect(sup.states().map(s => s.status)).toEqual(['DOWN', 'DOWN'])
  }, 30000)

  it('포트가 점유돼 있으면 ERROR + 점유자 정보', async () => {
    const blocker: Server = createServer(() => {})
    await new Promise<void>(r => blocker.listen(45823, () => r()))
    sup = new Supervisor(cfg(45823, 45824), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const st = sup.states()[0]
    expect(st.status).toBe('ERROR')
    expect(st.error).toMatch(/포트/)
    expect(st.error).toMatch(String(process.pid))
    blocker.close()
  }, 15000)

  it('외부에서 죽으면 CRASHED로 표시된다', async () => {
    sup = new Supervisor(cfg(45825, 45826), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const pid = sup.pids().get('dummy-a')!
    process.kill(pid)
    await new Promise(r => setTimeout(r, 1500))
    expect(sup.states()[0].status).toBe('CRASHED')

    const t0 = Date.now()
    await sup.stopAll()
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 15000)
})
