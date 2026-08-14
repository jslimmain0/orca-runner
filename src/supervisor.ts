import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Config, ServiceDef, ServiceState, ServiceStatus } from './types.js'
import { whoHoldsPort } from './ports.js'
import { loadCache, saveCache, needsRebuild } from './buildCache.js'
import { spawnService, killTree, recordStart, recordStop, isAlive } from './procctl.js'
import { LogWriter, logPathFor } from './logs.js'
import { httpProbe, portListening } from './health.js'
import { buildJar, findBootJar, javaArgs, gradleStop } from './spring.js'

const HEALTH_INTERVAL = 1000
const HEALTH_TIMEOUT = 120_000

interface Entry {
  state: ServiceState
  child?: ChildProcess
  buildChild?: ChildProcess
  log?: LogWriter
  stopping: boolean
}

export class Supervisor extends EventEmitter {
  private entries = new Map<string, Entry>()
  private logDir?: string
  private healthTimeoutMs: number

  constructor(cfg: Config, opts?: { logDir?: string; healthTimeoutMs?: number }) {
    super()
    this.logDir = opts?.logDir
    this.healthTimeoutMs = opts?.healthTimeoutMs ?? HEALTH_TIMEOUT
    for (const def of cfg.services) {
      this.entries.set(def.name, { state: { def, status: 'DOWN' }, stopping: false })
    }
  }

  states(): ServiceState[] { return [...this.entries.values()].map(e => e.state) }
  pids(): Map<string, number> {
    const m = new Map<string, number>()
    for (const [n, e] of this.entries) if (e.state.pid && e.state.status !== 'DOWN') m.set(n, e.state.pid)
    return m
  }

  private set(e: Entry, patch: Partial<ServiceState>): void {
    Object.assign(e.state, patch)
    this.emit('change')
  }
  private logFile(name: string): string {
    return this.logDir ? join(this.logDir, `${name}.log`) : logPathFor(name)
  }
  /** ERROR/CRASHED 사유를 서비스 로그 마지막 줄에 남긴다 — "빨간 상태 → l" 루프의 연결고리 */
  private noteToLog(e: Entry, reason: string): void {
    try { e.log?.stream().write(`[ORCA] ${new Date().toISOString()} ERROR: ${reason}\n`) } catch { /* 동기 오류만 — 비동기 오류는 LogWriter의 error 가드가 흡수 */ }
  }

  setSkip(name: string, v: boolean): void {
    const e = this.entries.get(name)
    if (!e) return
    this.set(e, { skipped: v, skipPortUp: undefined })
  }

  async start(name: string): Promise<void> {
    const e = this.entries.get(name)
    if (!e || e.state.status === 'UP' || e.state.status === 'STARTING' || e.state.status === 'BUILDING') return
    if (e.state.skipped) this.set(e, { skipped: false, skipPortUp: undefined })
    const def = e.state.def
    e.stopping = false
    try {
      e.log = new LogWriter(this.logFile(name))
      let command: string, args: string[]
      if (def.kind === 'spring') {
        const cache = loadCache()
        if (needsRebuild(def.dir, cache[name])) {
          this.set(e, { status: 'BUILDING', error: undefined, startedAt: Date.now() })
          try {
            const jar = await buildJar(def, e.log.stream(), child => { e.buildChild = child })
            cache[name] = { builtAt: Date.now(), jar }
            saveCache(cache)
          } finally {
            e.buildChild = undefined
          }
          await gradleStop(def.dir)   // 단일 서비스 시작만으로도 데몬을 남기지 않는다
        }
        const jar = cache[name]?.jar ?? findBootJar(def.dir, def.module)
        command = 'java'; args = javaArgs(def, jar)
      } else {
        command = 'cmd'; args = ['/c', def.run!]
      }

      const holder = await whoHoldsPort(def.port)
      if (holder) {
        const reason = `포트 ${def.port} 점유 중: ${holder.exe} (PID ${holder.pid})`
        this.noteToLog(e, reason)
        e.log?.close()
        this.set(e, { status: 'ERROR', error: reason, startedAt: undefined })
        return
      }

      const { pid, child } = await spawnService({
        command, args, cwd: def.dir, priority: def.priority,
        cpus: def.kind === 'command' && def.cpus > 0 ? def.cpus : undefined, out: e.log.stream(),
      })
      e.child = child
      recordStart(name, pid)
      this.set(e, { status: 'STARTING', pid, error: undefined, startedAt: Date.now() })

      child.once('exit', (code, signal) => {
        if (e.child !== child) return   // 이미 새 spawn으로 교체됨 — 이 리스너는 과거 자식의 것
        recordStop(name)
        e.child = undefined
        if (e.state.status === 'ERROR') { e.log?.close(); this.set(e, { pid: undefined }); return }
        const reason = signal ? `시그널 ${signal}로 종료` : `프로세스 종료 (code ${code ?? '?'})`
        if (!e.stopping) this.noteToLog(e, reason)
        e.log?.close()
        this.set(e, e.stopping
          ? { status: 'DOWN', pid: undefined, startedAt: undefined }
          : { status: 'CRASHED', pid: undefined, error: reason, startedAt: undefined })
      })

      // 함수 호출 경계로 TS의 상태 좁히기(narrowing)를 우회 — this.set()이 Object.assign으로
      // e.state.status를 비동기적으로 바꾸는 것을 컴파일러는 추적할 수 없다.
      const cur = (): ServiceStatus => e.state.status

      let lastDetail = ''
      const deadline = Date.now() + this.healthTimeoutMs
      while (Date.now() < deadline && cur() === 'STARTING') {
        if (def.health) {
          const p = await httpProbe(def.health)
          lastDetail = p.detail
          if (p.ok && cur() === 'STARTING') { this.set(e, { status: 'UP', startedAt: undefined }); return }
        } else {
          const up = await portListening(def.port)
          lastDetail = up ? '' : `포트 ${def.port} 리슨 없음`
          if (up && cur() === 'STARTING') { this.set(e, { status: 'UP', startedAt: undefined }); return }
        }
        await new Promise(r => setTimeout(r, HEALTH_INTERVAL))
      }
      if (cur() === 'STARTING') {
        const sec = this.healthTimeoutMs / 1000
        const reason = def.health
          ? `${sec}초 내 ${def.health} 확인 실패 (마지막: ${lastDetail}) — l로 로그 확인`
          : `${sec}초 내 포트 ${def.port} 리슨 확인 실패`
        this.noteToLog(e, reason)
        this.set(e, { status: 'ERROR', error: reason, startedAt: undefined })
        if (e.state.pid) await killTree(e.state.pid)   // 좀비 방지 — exit 핸들러가 pid만 정리 (ERROR 유지)
      }
    } catch (err) {
      this.noteToLog(e, (err as Error).message)
      e.log?.close()
      if (e.stopping) { this.set(e, { status: 'DOWN', pid: undefined, startedAt: undefined }); return }
      this.set(e, { status: 'ERROR', error: (err as Error).message, startedAt: undefined })
    }
  }

  async stop(name: string): Promise<void> {
    const e = this.entries.get(name)
    if (!e) return
    if (e.state.status === 'BUILDING' && e.buildChild?.pid) {
      e.stopping = true
      await killTree(e.buildChild.pid)
    } else if (e.state.pid && e.state.status !== 'DOWN') {
      e.stopping = true
      await killTree(e.state.pid)
    } else {
      return
    }
    await this.waitSettled(e)
  }

  /**
   * killTree()는 taskkill.exe 프로세스가 끝나면 resolve된다 — 대상 자식의 'exit' 이벤트(상태를
   * DOWN/CRASHED 등 종단으로 옮기는 주체)는 OS 통지 지연으로 그보다 늦게 돌 수 있다. 이 사이에
   * start()가 불리면 옛 상태(UP/STARTING/BUILDING)를 보고 초입 가드에서 조용히 no-op하는
   * 레이스가 생긴다 — stop() 자체가 상태 정착까지 기다려 이를 근본 차단한다.
   */
  private async waitSettled(e: Entry): Promise<void> {
    // 함수 호출 경계로 TS의 상태 좁히기(narrowing)를 우회 — start()의 cur() 패턴과 동일한 이유
    const status = (): ServiceStatus => e.state.status
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (
      status() === 'UP' || status() === 'STARTING' || status() === 'BUILDING' || e.state.pid !== undefined || e.buildChild !== undefined
    )) {
      await new Promise(r => setTimeout(r, 50))
    }
  }

  async startAll(): Promise<void> {
    // 순차 시작: 동시 빌드로 CPU를 폭주시키지 않는다 (절약이 목적)
    for (const [name, e] of this.entries) {
      if (e.state.skipped) continue
      await this.start(name)
    }
    const springDirs = new Set(
      [...this.entries.values()].filter(e => e.state.def.kind === 'spring').map(e => e.state.def.dir),
    )
    for (const dir of springDirs) await gradleStop(dir)   // 스펙: 데몬 잔류 방지
  }

  async stopAll(): Promise<{ stopped: string[]; unconfirmed: { name: string; pid: number }[] }> {
    const targets = [...this.entries.entries()]
      .filter(([, e]) => e.state.status !== 'DOWN' && (e.state.pid || e.buildChild?.pid))
      .map(([n]) => n)
    await Promise.all(targets.map(n => this.stop(n)))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && [...this.entries.values()].some(e => e.stopping && e.state.status !== 'DOWN')) {
      await new Promise(r => setTimeout(r, 100))
    }
    const stopped: string[] = []
    const unconfirmed: { name: string; pid: number }[] = []
    for (const n of targets) {
      const e = this.entries.get(n)!
      if (e.state.status === 'DOWN') stopped.push(n)
      else if (e.state.pid && isAlive(e.state.pid)) unconfirmed.push({ name: n, pid: e.state.pid })
      else stopped.push(n)   // pid 없거나 이미 죽음 = 확인
    }
    return { stopped, unconfirmed }
  }
}
