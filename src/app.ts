import { createInterface } from 'node:readline/promises'
import { Supervisor } from './supervisor.js'
import { StatsCollector } from './stats.js'
import { sampleSystem } from './sysinfo.js'
import { Screen } from './tui/screen.js'
import { parseKey, parseDigit } from './tui/keys.js'
import { dashboardLines } from './tui/dashboard.js'
import { logViewLines, maxOffset } from './tui/logView.js'
import { logPathFor } from './logs.js'
import { findOrphans, activeSessions, killTree } from './procctl.js'
import { portListening } from './health.js'
import { readLastSession, writeLastSession, resumeSet, failedSet } from './session.js'
import type { Config } from './types.js'

export async function runApp(cfg: Config): Promise<void> {
  // 다른 터미널이 이미 관리 중인 서비스는 정리 대상에서 제외하고 안내만 한다
  const sessions = activeSessions()
  if (sessions.length > 0) {
    for (const s of sessions) {
      console.log(`이미 다른 터미널(PID ${s.owner})에서 관리 중: ${s.services.map(x => x.name).join(', ')} — 상태만 보려면 orca status`)
    }
  }

  // 이전 세션의 고아 프로세스 정리 (TUI 진입 전 일반 콘솔에서)
  const orphans = findOrphans()
  if (orphans.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('이전 세션이 남긴 프로세스가 있습니다:')
    for (const o of orphans) {
      const svc = cfg.services.find(s => s.name === o.name)
      const extra = svc ? `, :${svc.port}, ${(await portListening(svc.port)) ? '응답 있음' : '응답 없음'}` : ''
      console.log(`  - ${o.name} (PID ${o.pid}${extra})`)
    }
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

  // 지난 세션 재개 배너 — 이전 실행이 UP/STARTING/BUILDING이었던 서비스가 있으면 [u]로 재개 유도
  const last = readLastSession()
  const resume = resumeSet(last, cfg)
  const failed = failedSet(last, cfg)
  // resume이 있으면 재개 유도 배너(+실패 병기), resume 없이 failed만 있어도(=전부 실패로 끝난 세션)
  // 원인 확인 경로(l)를 잃지 않도록 배너를 띄운다 — 둘 다 없으면 배너 없음
  let banner: string | undefined
  if (resume.length > 0) {
    banner = ` 지난 세션: ${resume.length}개 실행 중이었음 — [u] 재개${failed.length ? ` / 실패했던 서비스: ${failed.join(', ')} (l로 사유 확인)` : ''}`
  } else if (failed.length > 0) {
    banner = ` 지난 세션에 실패: ${failed.join(', ')} (l로 사유 확인)`
  }

  const draw = () => {
    const states = sup.states()
    const width = process.stdout.columns || 100
    if (view === 'dash') {
      screen.render(dashboardLines(states, sampleSystem(), {
        sel, statsOn, width, color: process.stdout.isTTY === true && !process.env.NO_COLOR,
        helpOverride: confirmQuit ? ' ⚠ 빌드/기동 진행 중 — [q] 한 번 더 = 전체 종료, 다른 키 = 취소' : undefined,
        banner,
      }))
    } else {
      const name = states[sel].def.name
      screen.render(logViewLines(name, logPathFor(name), process.stdout.rows || 30, logOffset, width))
    }
  }

  sup.on('change', draw)

  let ticking = false
  const tick = setInterval(async () => {          // 3초 배치 샘플 — 유일한 주기 작업
    if (ticking) return   // 이전 tick이 아직 안 끝났으면 이번 회차 스킵 — stats.sample()의 once('line')가
    ticking = true         // 겹친 tick끼리 서로의 응답을 가로채는 레이스를 구조적으로 차단
    try {
      if (statsOn) {
        const m = await stats.sample([...sup.pids().values()])
        for (const s of sup.states()) {
          const st = s.pid ? m.get(s.pid) : undefined
          s.cpuPercent = st?.cpuPercent
          s.rssBytes = st?.rssBytes
        }
      }
      await Promise.all(sup.states().filter(s => s.skipped).map(async s => {
        s.skipPortUp = await portListening(s.def.port)   // 기존 3초 tick에 편승, 병렬이라 최악 +1s로 상한
      }))
      draw()
    } finally {
      ticking = false
    }
  }, 3000)

  let quitting = false
  const quit = async () => {
    if (quitting) return
    quitting = true
    clearInterval(tick)
    stats.stop()
    screen.exit()
    writeLastSession(sup.states().map(s => ({ name: s.def.name, status: s.status })))   // stopAll 직전 스냅샷 — 이후엔 전부 DOWN이라 의미 없음
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
      else if (k === 'up') {
        const name = sup.states()[sel].def.name
        logOffset = Math.min(logOffset + 1, maxOffset(logPathFor(name), process.stdout.rows || 30))
      }
      else if (k === 'down') logOffset = Math.max(0, logOffset - 1)
      draw()
      return
    }
    if (confirmQuit && k !== 'q') { confirmQuit = false; draw(); return }
    const digit = view === 'dash' ? parseDigit(b) : null
    if (digit !== null && !confirmQuit) {
      if (digit <= n) { sel = digit - 1; draw() }
      return
    }
    const toggleSel = () => {
      const s = sup.states()[sel]
      if (s.status === 'UP' || s.status === 'STARTING' || s.status === 'BUILDING') void sup.stop(s.def.name)
      else void sup.start(s.def.name)
    }
    switch (k) {
      case 'up': sel = (sel + n - 1) % n; break
      case 'down': sel = (sel + 1) % n; break
      case 's': toggleSel(); break
      case 'enter': toggleSel(); break
      case 'r': {
        const name = sup.states()[sel].def.name
        void (async () => { await sup.stop(name); await sup.start(name) })()
        break
      }
      case 'a': void sup.startAll(); break
      case 'u': if (banner) { banner = undefined; if (resume.length > 0) void sup.startMany(resume) } break
      case 'x': {
        const s3 = sup.states()[sel]
        if (s3.status !== 'UP' && s3.status !== 'STARTING' && s3.status !== 'BUILDING') sup.setSkip(s3.def.name, !s3.skipped)
        break
      }
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
    if (k === 'a' || k === 's' || k === 'enter' || k === 'r') banner = undefined   // 시작 동작 후엔 재개 배너가 무의미
    draw()
  })
}
