import { Supervisor } from './supervisor.js'
import { loadConfig } from './config.js'
import { readRunEntries, recordStop, killTree, isAlive } from './procctl.js'
import { readLastSession, resumeSet } from './session.js'
import type { Config } from './types.js'

interface HeadlessOpts { cfg?: Config; runPath?: string; logDir?: string }

function pick(cfg: Config, group?: string): Config {
  const services = group ? cfg.services.filter(s => s.group === group) : cfg.services
  return { services }
}

export async function runUp(group: string | undefined, opts: HeadlessOpts = {}): Promise<void> {
  let cfg = pick(opts.cfg ?? loadConfig(), group)
  // 인자 없이 orca up만 치면 지난 세션(직전 종료 시점에 UP/STARTING/BUILDING이었던 서비스)만 재개한다 —
  // --all이면 강제로 전체, group 지정이나 테스트 주입(opts.cfg)이면 이 기본값을 건드리지 않는다.
  if (!opts.cfg && group === undefined && !process.argv.includes('--all')) {
    const rs = resumeSet(readLastSession(), cfg)
    if (rs.length > 0) {
      const set = new Set(rs)
      cfg = { services: cfg.services.filter(s => set.has(s.name)) }
      console.log(`지난 세션 기준 ${cfg.services.length}개를 시작합니다 (전체는 orca up --all)`)
    }
  }
  if (cfg.services.length === 0) { console.error(group ? `그룹 '${group}'에 서비스가 없습니다` : '등록된 서비스가 없습니다'); process.exitCode = 1; return }
  const sup = new Supervisor(cfg, { owner: 0, logDir: opts.logDir, runPath: opts.runPath })
  await sup.startAll()
  let ok = true
  for (const s of sup.states()) {
    if (s.status === 'UP') console.log(`✔ ${s.def.name} UP (:${s.def.port})`)
    else { ok = false; console.log(`✖ ${s.def.name} ${s.status}${s.error ? `: ${s.error}` : ''}`) }
  }
  process.exitCode = ok ? 0 : 1
}

export async function runDown(group: string | undefined, yes: boolean, opts: HeadlessOpts = {}): Promise<void> {
  const cfg = pick(opts.cfg ?? loadConfig(), group)
  const names = new Set(cfg.services.map(s => s.name))
  const all = readRunEntries(opts.runPath)
  const targets = Object.entries(all).filter(([n, e]) => names.has(n) && isAlive(e.pid))
  if (targets.length === 0) { console.log('종료할 실행 중 서비스가 없습니다'); return }
  if (!yes) {
    console.log('종료 대상 (dry-run):')
    for (const [n, e] of targets) console.log(`  - ${n} (PID ${e.pid})`)
    console.log('실행하려면 --yes를 붙이세요')
    return
  }
  const foreign = targets.filter(([, e]) => e.owner > 0 && isAlive(e.owner))
  if (foreign.length > 0) {
    for (const [n, e] of foreign) console.error(`✖ ${n}은(는) 다른 터미널(PID ${e.owner})이 관리 중 — 그 터미널에서 종료하세요`)
    process.exitCode = 1
    return
  }
  let ok = true
  for (const [n, e] of targets) {
    const done = await killTree(e.pid)
    if (done) { recordStop(n, opts.runPath); console.log(`✔ ${n} 종료`) }
    else { ok = false; console.error(`⚠ ${n} 종료 실패 (PID ${e.pid})`) }
  }
  process.exitCode = ok ? 0 : 1
}

export async function runStartStop(action: 'start' | 'stop', name: string, opts: HeadlessOpts = {}): Promise<void> {
  const cfg = opts.cfg ?? loadConfig()
  const svc = cfg.services.find(s => s.name === name)
  if (!svc) { console.error(`'${name}'은(는) 등록돼 있지 않습니다`); process.exitCode = 1; return }
  if (action === 'start') {
    await runUp(undefined, { ...opts, cfg: { services: [svc] } })
  } else {
    await runDown(undefined, true, { ...opts, cfg: { services: [svc] } })
  }
}
