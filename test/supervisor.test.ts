import { describe, it, expect, afterEach } from 'vitest'
import { Supervisor } from '../src/supervisor.js'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { isAlive } from '../src/procctl.js'
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
    // process.kill(pid)만 쓰면 cmd.exe 래퍼만 죽고 실제 dummy-server(node.exe) 손자
    // 프로세스는 포트를 계속 리슨한 채 고아로 남는다. 트리째 죽여 외부 강제종료를
    // 시뮬레이션하면서도(수퍼바이저 입장에선 여전히 "자신이 죽이지 않은 exit") 다음
    // 테스트 실행이 45825 포트 점유로 실패하지 않도록 한다.
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    await new Promise(r => setTimeout(r, 1500))
    expect(sup.states()[0].status).toBe('CRASHED')

    const t0 = Date.now()
    await sup.stopAll()
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 15000)

  it('헬스체크 타임아웃 시 ERROR로 전환하고 좀비 프로세스를 정리한다 (재시도 안전)', async () => {
    const cfg: Config = {
      services: [
        {
          name: 'never-up', kind: 'command', dir: process.cwd(),
          run: 'node -e "setInterval(()=>{},1000)"', port: 45827,
          heapMb: 0, cpus: 0, priority: 'normal', jvmArgs: [],
        },
      ],
    }
    sup = new Supervisor(cfg, { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')), healthTimeoutMs: 3000 })
    const startP = sup.start('never-up')

    // STARTING 상태에서 pid를 확보 (좀비가 실제로 죽었는지 나중에 확인하기 위해)
    let pid: number | undefined
    const d1 = Date.now() + 5000
    while (Date.now() < d1 && pid === undefined) {
      pid = sup.pids().get('never-up')
      if (pid === undefined) await new Promise(r => setTimeout(r, 50))
    }
    expect(pid).toBeDefined()

    await startP
    expect(sup.states()[0].status).toBe('ERROR')

    // exit 핸들러가 비동기로 pid를 지우므로 짧게 폴링
    const d2 = Date.now() + 3000
    while (Date.now() < d2 && sup.states()[0].pid !== undefined) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(sup.states()[0].pid).toBeUndefined()
    expect(isAlive(pid!)).toBe(false)   // 헬스체크 타임아웃 후 자식 프로세스가 좀비로 남지 않았다

    // 재시도: 이전 자식의 지연된 exit 이벤트가 새 spawn을 덮어쓰지 않아야 한다
    const retryP = sup.start('never-up')
    let pid2: number | undefined
    const d3 = Date.now() + 3000
    while (Date.now() < d3 && pid2 === undefined) {
      pid2 = sup.pids().get('never-up')
      if (pid2 === undefined) await new Promise(r => setTimeout(r, 50))
    }
    expect(pid2).toBeDefined()
    expect(pid2).not.toBe(pid)
    await sup.stop('never-up')
    await retryP
  }, 20000)

  it('BUILDING 중 stop()이 gradle 빌드 트리를 정리한다 (30초 안 기다림)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sv-build-'))
    writeFileSync(join(dir, 'gradlew.bat'), '@echo off\r\ntimeout /t 30 /nobreak >nul\r\nexit /b 0\r\n')
    const cfg: Config = {
      services: [
        { name: 'slow-build', kind: 'spring', dir, port: 45828, heapMb: 512, cpus: 2, priority: 'belowNormal', jvmArgs: [] },
      ],
    }
    sup = new Supervisor(cfg, { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    const startP = sup.start('slow-build')

    const d1 = Date.now() + 5000
    while (Date.now() < d1 && sup.states()[0].status !== 'BUILDING') {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(sup.states()[0].status).toBe('BUILDING')

    const t0 = Date.now()
    await sup.stop('slow-build')
    const d2 = Date.now() + 5000
    while (Date.now() < d2 && sup.states()[0].status !== 'DOWN') {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(sup.states()[0].status).toBe('DOWN')
    expect(Date.now() - t0).toBeLessThan(10000)   // 30초 gradlew 타임아웃이 아니라 즉시 정리됐는지 확인

    await startP   // start()의 내부 catch 흐름이 끝나길 대기 (미처리 rejection 방지)
  }, 20000)

  it('포트 점유 ERROR 시 로그 파일에 [ORCA] ERROR 사유가 남는다', async () => {
    const blocker = createServer(() => {})
    await new Promise<void>(r => blocker.listen(45833, () => r()))
    const logDir = mkdtempSync(join(tmpdir(), 'orca-sv-'))
    sup = new Supervisor(cfg(45833, 45834), { logDir })
    await sup.start('dummy-a')
    const log = readFileSync(join(logDir, 'dummy-a.log'), 'utf8')
    expect(log).toMatch(/\[ORCA\] .+ ERROR: 포트 45833 점유 중/)
    blocker.close()
  }, 15000)

  it('stopAll이 종료 확인 결과를 반환한다', async () => {
    sup = new Supervisor(cfg(45841, 45842), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.startAll()
    const r = await sup.stopAll()
    expect(r.stopped.sort()).toEqual(['dummy-a', 'dummy-b'])
    expect(r.unconfirmed).toEqual([])
  }, 30000)

  it('CRASHED 시 종료 코드/시그널이 error 필드와 로그에 남는다', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'orca-sv-'))
    sup = new Supervisor(cfg(45835, 45836), { logDir })
    await sup.start('dummy-a')
    const pid = sup.pids().get('dummy-a')!
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    await new Promise(r => setTimeout(r, 1500))
    const st = sup.states()[0]
    expect(st.status).toBe('CRASHED')
    expect(st.error).toMatch(/프로세스 종료|시그널/)
    const log = readFileSync(join(logDir, 'dummy-a.log'), 'utf8')
    expect(log).toMatch(/\[ORCA\] .+ ERROR: (프로세스 종료|시그널)/)
  }, 15000)
})
