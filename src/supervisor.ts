import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Config, ServiceDef, ServiceState, ServiceStatus } from './types.js'
import { whoHoldsPort } from './ports.js'
import { loadCache, saveCache, needsRebuild } from './buildCache.js'
import { spawnService, killTree, recordStart, recordStop } from './procctl.js'
import { LogWriter, logPathFor } from './logs.js'
import { httpUp, portListening } from './health.js'
import { buildJar, findBootJar, javaArgs, gradleStop } from './spring.js'

const HEALTH_INTERVAL = 1000
const HEALTH_TIMEOUT = 120_000

interface Entry {
  state: ServiceState
  child?: ChildProcess
  log?: LogWriter
  stopping: boolean
}

export class Supervisor extends EventEmitter {
  private entries = new Map<string, Entry>()
  private logDir?: string

  constructor(cfg: Config, opts?: { logDir?: string }) {
    super()
    this.logDir = opts?.logDir
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

  async start(name: string): Promise<void> {
    const e = this.entries.get(name)
    if (!e || e.state.status === 'UP' || e.state.status === 'STARTING' || e.state.status === 'BUILDING') return
    const def = e.state.def
    e.stopping = false
    try {
      e.log = new LogWriter(this.logFile(name))
      let command: string, args: string[]
      if (def.kind === 'spring') {
        const cache = loadCache()
        if (needsRebuild(def.dir, cache[name])) {
          this.set(e, { status: 'BUILDING', error: undefined })
          const jar = await buildJar(def, e.log.stream())
          cache[name] = { builtAt: Date.now(), jar }
          saveCache(cache)
        }
        const jar = cache[name]?.jar ?? findBootJar(def.dir, def.module)
        command = 'java'; args = javaArgs(def, jar)
      } else {
        command = 'cmd'; args = ['/c', def.run!]
      }

      const holder = await whoHoldsPort(def.port)
      if (holder) {
        e.log?.close()
        this.set(e, { status: 'ERROR', error: `포트 ${def.port} 점유 중: ${holder.exe} (PID ${holder.pid})` })
        return
      }

      const { pid, child } = await spawnService({
        command, args, cwd: def.dir, priority: def.priority,
        cpus: def.kind === 'command' && def.cpus > 0 ? def.cpus : undefined, out: e.log.stream(),
      })
      e.child = child
      recordStart(name, pid)
      this.set(e, { status: 'STARTING', pid, error: undefined })

      child.once('exit', () => {
        recordStop(name)
        e.log?.close()
        this.set(e, e.stopping ? { status: 'DOWN', pid: undefined } : { status: 'CRASHED', pid: undefined })
      })

      // 함수 호출 경계로 TS의 상태 좁히기(narrowing)를 우회 — this.set()이 Object.assign으로
      // e.state.status를 비동기적으로 바꾸는 것을 컴파일러는 추적할 수 없다.
      const cur = (): ServiceStatus => e.state.status

      const deadline = Date.now() + HEALTH_TIMEOUT
      while (Date.now() < deadline && cur() === 'STARTING') {
        const up = def.health ? await httpUp(def.health) : await portListening(def.port)
        if (up && cur() === 'STARTING') { this.set(e, { status: 'UP' }); return }
        await new Promise(r => setTimeout(r, HEALTH_INTERVAL))
      }
      if (cur() === 'STARTING') {
        this.set(e, { status: 'ERROR', error: `${HEALTH_TIMEOUT / 1000}초 내에 헬스체크를 통과하지 못했습니다` })
      }
    } catch (err) {
      e.log?.close()
      this.set(e, { status: 'ERROR', error: (err as Error).message })
    }
  }

  async stop(name: string): Promise<void> {
    const e = this.entries.get(name)
    if (!e || !e.state.pid || e.state.status === 'DOWN') return
    e.stopping = true
    await killTree(e.state.pid)
  }

  async startAll(): Promise<void> {
    // 순차 시작: 동시 빌드로 CPU를 폭주시키지 않는다 (절약이 목적)
    for (const name of this.entries.keys()) await this.start(name)
    const springDirs = new Set(
      [...this.entries.values()].filter(e => e.state.def.kind === 'spring').map(e => e.state.def.dir),
    )
    for (const dir of springDirs) await gradleStop(dir)   // 스펙: 데몬 잔류 방지
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(n => this.stop(n)))
    // exit 이벤트가 DOWN으로 바꿀 때까지 잠깐 대기
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && [...this.entries.values()].some(e => e.stopping && e.state.status !== 'DOWN')) {
      await new Promise(r => setTimeout(r, 100))
    }
  }
}
