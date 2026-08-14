import { describe, it, expect, afterEach } from 'vitest'
import { runUp, runDown, runStartStop } from '../src/headless.js'
import { readRunEntries } from '../src/procctl.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../src/types.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const base = { kind: 'command' as const, dir: process.cwd(), heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
const cfg = (p1: number): Config => ({ services: [
  { ...base, name: 'h-a', run: `node "${FIXTURE}" ${p1}`, port: p1, health: `http://localhost:${p1}/health` },
] })

// runUp/runDown은 테스트 주입을 위해 opts로 cfg/runPath/logDir를 받을 수 있어야 한다 (아래 구현 참조)
describe('headless', () => {
  const runPath = join(mkdtempSync(join(tmpdir(), 'orca-hl-')), 'run.json')
  const logDir = mkdtempSync(join(tmpdir(), 'orca-hl-'))

  afterEach(async () => { await runDown(undefined, true, { cfg: cfg(45871), runPath, logDir }) })

  it('up은 서비스를 남기고 종료하며 owner=0으로 기록한다', async () => {
    await runUp(undefined, { cfg: cfg(45871), runPath, logDir })
    const r = readRunEntries(runPath)
    expect(r['h-a']).toBeDefined()
    expect(r['h-a'].owner).toBe(0)
    expect(process.exitCode ?? 0).toBe(0)
    process.exitCode = 0
  }, 30000)

  it('down은 --yes 없으면 dry-run, --yes면 종료하고 기록을 지운다', async () => {
    await runUp(undefined, { cfg: cfg(45871), runPath, logDir })
    await runDown(undefined, false, { cfg: cfg(45871), runPath, logDir })   // dry-run
    expect(readRunEntries(runPath)['h-a']).toBeDefined()                     // 아직 살아있음
    await runDown(undefined, true, { cfg: cfg(45871), runPath, logDir })
    expect(readRunEntries(runPath)['h-a']).toBeUndefined()
    process.exitCode = 0
  }, 30000)
})

describe('headless: 다른 세션 소유 보호', () => {
  const runPath = join(mkdtempSync(join(tmpdir(), 'orca-hl2-')), 'run.json')
  const logDir = mkdtempSync(join(tmpdir(), 'orca-hl2-'))
  const PORT = 45873
  let child: ChildProcess

  afterEach(async () => {
    child?.kill()
    process.exitCode = 0
  })

  it('다른 살아있는 세션(owner>0)이 소유한 항목은 --yes로도 죽이지 않는다', async () => {
    child = spawn(process.execPath, [FIXTURE, String(PORT)], { windowsHide: true })
    await new Promise<void>(r => child.stdout!.once('data', () => r()))
    writeFileSync(runPath, JSON.stringify({ 'h-b': { pid: child.pid, owner: process.pid } }))
    const c = cfg(PORT)
    c.services[0].name = 'h-b'
    await runDown(undefined, true, { cfg: c, runPath, logDir })
    expect(readRunEntries(runPath)['h-b']).toBeDefined()   // 지워지지 않음
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  }, 15000)
})

describe('headless: start/stop', () => {
  const runPath = join(mkdtempSync(join(tmpdir(), 'orca-hl3-')), 'run.json')
  const logDir = mkdtempSync(join(tmpdir(), 'orca-hl3-'))
  const PORT = 45874
  const c = cfg(PORT)

  afterEach(async () => {
    await runDown(undefined, true, { cfg: c, runPath, logDir })
    process.exitCode = 0
  })

  it('start는 개별 서비스를 owner=0으로 띄우고 UP이면 exit 0', async () => {
    await runStartStop('start', 'h-a', { cfg: c, runPath, logDir })
    const r = readRunEntries(runPath)
    expect(r['h-a']).toBeDefined()
    expect(r['h-a'].owner).toBe(0)
    expect(process.exitCode ?? 0).toBe(0)
    process.exitCode = 0
  }, 30000)

  it('stop은 살아있는 서비스를 종료하고 기록을 지운다', async () => {
    await runStartStop('start', 'h-a', { cfg: c, runPath, logDir })
    await runStartStop('stop', 'h-a', { cfg: c, runPath, logDir })
    expect(readRunEntries(runPath)['h-a']).toBeUndefined()
    expect(process.exitCode ?? 0).toBe(0)
    process.exitCode = 0
  }, 30000)

  it('등록되지 않은 이름이면 exit 1과 에러 메시지', async () => {
    await runStartStop('start', 'no-such-service', { cfg: c, runPath, logDir })
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
