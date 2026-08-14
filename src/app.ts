import { createInterface } from 'node:readline/promises'
import { Supervisor } from './supervisor.js'
import { StatsCollector } from './stats.js'
import { sampleSystem } from './sysinfo.js'
import { Screen } from './tui/screen.js'
import { parseKey } from './tui/keys.js'
import { dashboardLines } from './tui/dashboard.js'
import { logViewLines } from './tui/logView.js'
import { logPathFor } from './logs.js'
import { findOrphans, killTree } from './procctl.js'
import type { Config } from './types.js'

export async function runApp(cfg: Config): Promise<void> {
  // 이전 세션의 고아 프로세스 정리 (TUI 진입 전 일반 콘솔에서)
  const orphans = findOrphans()
  if (orphans.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('이전 세션이 남긴 프로세스가 있습니다:')
    for (const o of orphans) console.log(`  - ${o.name} (PID ${o.pid})`)
    const ans = await rl.question('정리할까요? [y/N] ')
    rl.close()
    if (ans.trim().toLowerCase() === 'y') for (const o of orphans) await killTree(o.pid)
  }

  const sup = new Supervisor(cfg)
  const stats = new StatsCollector()
  const screen = new Screen()
  let statsOn = true
  let sel = 0
  let view: 'dash' | 'log' = 'dash'
  let logOffset = 0
  let confirmQuit = false
  stats.start()

  const draw = () => {
    const states = sup.states()
    const width = process.stdout.columns || 100
    if (view === 'dash') {
      screen.render(dashboardLines(states, sampleSystem(), {
        sel, statsOn, width, color: process.stdout.isTTY === true && !process.env.NO_COLOR,
        helpOverride: confirmQuit ? ' ⚠ 빌드/기동 진행 중 — [q] 한 번 더 = 전체 종료, 다른 키 = 취소' : undefined,
      }))
    } else {
      const name = states[sel].def.name
      screen.render(logViewLines(name, logPathFor(name), process.stdout.rows || 30, logOffset, width))
    }
  }

  sup.on('change', draw)

  const tick = setInterval(async () => {          // 3초 배치 샘플 — 유일한 주기 작업
    if (statsOn) {
      const m = await stats.sample([...sup.pids().values()])
      for (const s of sup.states()) {
        const st = s.pid ? m.get(s.pid) : undefined
        s.cpuPercent = st?.cpuPercent
        s.rssBytes = st?.rssBytes
      }
    }
    draw()
  }, 3000)

  let quitting = false
  const quit = async () => {
    if (quitting) return
    quitting = true
    clearInterval(tick)
    stats.stop()
    screen.exit()
    console.log('서비스를 정리하는 중...')
    const r = await sup.stopAll()
    if (r.unconfirmed.length === 0) console.log(`✔ 서비스 ${r.stopped.length}개 모두 종료 확인`)
    else for (const u of r.unconfirmed) console.log(`⚠ 종료 미확인: ${u.name} (PID ${u.pid}) — 다음 orca 실행 시 고아 정리를 이용하세요`)
    process.exit(0)
  }
  // 외부 신호는 강제 종료 의사로 간주 — 2단계 확인을 의도적으로 생략한다 (협의회 P0-1 결정)
  // (raw mode에서는 Ctrl+C가 이 SIGINT가 아니라 stdin 데이터 \x03으로 도착한다 — 아래 stdin
  //  핸들러의 별도 가드가 동일한 정책을 적용한다)
  process.on('SIGINT', () => { void quit() })

  screen.enter()
  draw()
  process.stdin.on('data', (b: Buffer) => {
    // Ctrl+C: raw mode에선 SIGINT가 아니라 데이터로 도착 — 강제 종료 제스처, 확인 생략 (협의회 P0-1)
    if (b.length === 1 && b[0] === 0x03) { void quit(); return }
    const k = parseKey(b)
    const n = sup.states().length
    if (view === 'log') {
      if (k === 'esc' || k === 'l' || k === 'q') { view = 'dash'; screen.reset() }
      else if (k === 'up') logOffset++
      else if (k === 'down') logOffset = Math.max(0, logOffset - 1)
      draw()
      return
    }
    if (confirmQuit && k !== 'q') { confirmQuit = false; draw(); return }
    switch (k) {
      case 'up': sel = (sel + n - 1) % n; break
      case 'down': sel = (sel + 1) % n; break
      case 's': {
        const s = sup.states()[sel]
        if (s.status === 'UP' || s.status === 'STARTING' || s.status === 'BUILDING') void sup.stop(s.def.name)
        else void sup.start(s.def.name)
        break
      }
      case 'a': void sup.startAll(); break
      case 'l': view = 'log'; logOffset = 0; screen.reset(); break
      case 'm':
        statsOn = !statsOn
        if (statsOn) stats.start(); else stats.stop()
        for (const s of sup.states()) { s.cpuPercent = undefined; s.rssBytes = undefined }
        break
      case 'q': {
        const busy = sup.states().some(s => s.status === 'BUILDING' || s.status === 'STARTING')
        if (busy && !confirmQuit) { confirmQuit = true; break }
        void quit(); return
      }
    }
    draw()
  })
}
