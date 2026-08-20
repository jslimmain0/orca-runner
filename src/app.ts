import { readFileSync, writeFileSync } from 'node:fs'
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
import { watchConfig } from './configWatcher.js'
import { loadConfigFromString, CONFIG_PATH } from './config.js'
import { readUsage, mergeSession, writeUsage, jstatSnapshot } from './usage.js'
import { recommend, applyRecommendation } from './advise.js'
import type { Config, ServiceDef, ServiceStatus } from './types.js'
import type { JstatGc } from './usage.js'
import type { Recommendation } from './advise.js'

/** DashOpts.recs용 압축 문구 — 예: '힙 512→256·메타 256→128' */
function fmtRec(def: ServiceDef, rec: Recommendation): string {
  const parts: string[] = []
  if (rec.heapMb !== undefined) parts.push(`힙 ${def.heapMb}→${rec.heapMb}`)
  if (rec.metaspaceMb !== undefined) parts.push(`메타 ${def.metaspaceMb}→${rec.metaspaceMb}`)
  return parts.join('·')
}

export async function runApp(cfg: Config, opts?: { group?: string }): Promise<void> {
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
  let notice: string | undefined
  let noticeExpiry = 0   // Infinity = 스티키(다음 성공 리로드가 덮을 때까지 유지)

  // 사용량 기반 추천 — 세션 시작 시 1회 계산. v로 적용한 서비스는 목록에서 제거하고
  // 다음 세션(다음 orca 실행)까지 재계산하지 않는다 — 브리프 명시 사항.
  const usageAtStart = readUsage()
  const recs = new Map<string, Recommendation>()
  for (const def of cfg.services) {
    const rec = recommend(def, usageAtStart[def.name])
    if (rec) recs.set(def.name, rec)
  }

  // 세션 수집: RSS 피크는 kind 무관 전부, jstat(힙/메타/FGC) 피크는 spring만 — UP 전이 후
  // 90초 뒤 1회 스냅샷(서비스·세션당 1회, 진행 중 DOWN/CRASHED면 결과 무시) + quit 시 마지막 1회.
  // 둘 다 1회성 setTimeout/execFile — 새 주기 작업 아님(디바운스 선례와 동일한 허용 범주).
  const peakRss = new Map<string, number>()          // bytes
  const jstatPeaks = new Map<string, JstatGc>()
  const jstatScheduled = new Set<string>()
  const jstatTimers = new Map<string, NodeJS.Timeout>()
  const prevStatus = new Map<string, ServiceStatus>()

  const mergeJstatPeak = (name: string, r: JstatGc): void => {
    const prev = jstatPeaks.get(name)
    jstatPeaks.set(name, {
      heapUsedKb: Math.max(prev?.heapUsedKb ?? 0, r.heapUsedKb),
      metaUsedKb: Math.max(prev?.metaUsedKb ?? 0, r.metaUsedKb),
      fullGc: Math.max(prev?.fullGc ?? 0, r.fullGc),
      gcTimeSec: Math.max(prev?.gcTimeSec ?? 0, r.gcTimeSec),
    })
  }

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
    // 유예 엔트리 삭제 등 어떤 경로로 목록이 줄어도 키 핸들러가 안전하도록 draw가 유일한 클램프 지점
    sel = Math.min(sel, Math.max(0, states.length - 1))
    const width = process.stdout.columns || 100
    if (view === 'dash') {
      const recDisplay: Record<string, string> = {}
      for (const [name, rec] of recs) {
        const def = states.find(s => s.def.name === name)?.def
        if (def) recDisplay[name] = fmtRec(def, rec)
      }
      screen.render(dashboardLines(states, sampleSystem(), {
        sel, statsOn, width, color: process.stdout.isTTY === true && !process.env.NO_COLOR,
        helpOverride: confirmQuit ? ' ⚠ 빌드/기동 진행 중 — [q] 한 번 더 = 전체 종료, 다른 키 = 취소' : undefined,
        banner, notice, recs: recDisplay,
      }))
    } else {
      const name = states[sel].def.name
      screen.render(logViewLines(name, logPathFor(name), process.stdout.rows || 30, logOffset, width))
    }
  }

  sup.on('change', () => {
    for (const s of sup.states()) {
      const prev = prevStatus.get(s.def.name)
      if (prev !== 'UP' && s.status === 'UP' && s.def.kind === 'spring' && s.pid !== undefined && !jstatScheduled.has(s.def.name)) {
        jstatScheduled.add(s.def.name)   // 서비스·세션당 1회만 예약
        const name = s.def.name, pid = s.pid
        const t = setTimeout(() => {
          jstatTimers.delete(name)
          const cur = sup.states().find(x => x.def.name === name)
          if (!cur || cur.status !== 'UP' || cur.pid !== pid) return   // 진행 중 DOWN/CRASHED 등이면 결과 무시
          void jstatSnapshot(pid).then(r => { if (r) mergeJstatPeak(name, r) })
        }, 90_000)
        jstatTimers.set(name, t)
      }
      prevStatus.set(s.def.name, s.status)
    }
    draw()
  })

  // services.yaml 핫로드: 다른 터미널의 orca add/remove·직접 편집을 감지해 반영한다
  const stopWatch = watchConfig(
    full => {
      const services = opts?.group ? full.services.filter(s => s.group === opts.group) : full.services
      if (services.length === 0) {
        notice = ` ⚠ 리로드 결과 서비스가 없어 기존 설정을 유지합니다`
        noticeExpiry = Date.now() + 8000
        draw(); return
      }
      const r = sup.applyConfig({ services })
      sel = Math.min(sel, Math.max(0, sup.states().length - 1))   // draw()도 클램프하지만 draw 전에 sel을 쓰는 경로가 없도록 유지 — 중복이지만 무해
      const totalChanges = r.added.length + r.changed.length + r.removed.length + r.deferredRemoved.length
      if (totalChanges > 0) {
        notice = ` 설정 반영: +${r.added.length} 추가, ${r.changed.length} 변경, ${r.removed.length + r.deferredRemoved.length} 제거`
        noticeExpiry = Date.now() + 5000
      } else if (noticeExpiry === Infinity) {
        notice = undefined; noticeExpiry = 0   // 무변경이어도 성공 리로드는 스티키 오류를 걷는다 — 파일이 유효해졌다는 사실 자체가 정보
      }
      draw()
    },
    msg => {
      notice = ` ⚠ services.yaml 오류 — 기존 설정 유지: ${msg.split('\n')[0]}`
      noticeExpiry = Infinity   // 스티키 — 다음 성공 리로드가 덮는다
      draw()
    },
  )

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
          if (s.rssBytes !== undefined) {
            peakRss.set(s.def.name, Math.max(peakRss.get(s.def.name) ?? 0, s.rssBytes))
          }
        }
      }
      await Promise.all(sup.states().filter(s => s.skipped).map(async s => {
        s.skipPortUp = await portListening(s.def.port)   // 기존 3초 tick에 편승, 병렬이라 최악 +1s로 상한
      }))
      if (notice && Date.now() > noticeExpiry) { notice = undefined }   // 새 타이머 없이 3초 tick에 편승해 해제
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
    for (const t of jstatTimers.values()) clearTimeout(t)   // 90초 1회성 타이머 정리 — 세션 종료 후 발화 방지
    jstatTimers.clear()
    stopWatch()
    stats.stop()
    screen.exit()
    writeLastSession(sup.states().map(s => ({ name: s.def.name, status: s.status })))   // stopAll 직전 스냅샷 — 이후엔 전부 DOWN이라 의미 없음

    // 세션 마지막 jstat 스냅샷(1회성) — 살아있는 pid가 필요하므로 stopAll보다 먼저
    const runningSpring = sup.states().filter(s => s.def.kind === 'spring' && s.status === 'UP' && s.pid !== undefined)
    await Promise.all(runningSpring.map(async s => {
      const g = await jstatSnapshot(s.pid!)
      if (g) mergeJstatPeak(s.def.name, g)
    }))
    try {
      let usage = readUsage()
      for (const [name, peakBytes] of peakRss) {
        const g = jstatPeaks.get(name)
        usage = mergeSession(usage, name, {
          peakRssMb: Math.round(peakBytes / 1024 ** 2),
          heapMb: g ? Math.round(g.heapUsedKb / 1024) : undefined,
          metaMb: g ? Math.round(g.metaUsedKb / 1024) : undefined,
          fgc: g?.fullGc,
        })
      }
      writeUsage(usage)
    } catch { /* usage.json 기록 실패는 종료를 막지 않는다 */ }

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
      case 'v': {
        const s4 = sup.states()[sel]
        const rec = recs.get(s4.def.name)
        if (rec) {
          const name = s4.def.name
          const beforeDef = s4.def   // applyConfig가 s4.def를 새 def로 교체하기 전에 '적용 전' 값을 잡아둔다
          const wasUp = s4.status === 'UP'
          try {
            const src = readFileSync(CONFIG_PATH, 'utf8')
            const out = applyRecommendation(src, name, rec)
            writeFileSync(CONFIG_PATH, out)
            // 핫로드 워처도 곧 이 저장을 감지해 다시 반영하지만, 우리가 먼저 같은 값으로
            // applyConfig를 호출해두므로 워처의 재적용은 동일 def에 대한 멱등 호출이라 무해
            const full = loadConfigFromString(out)
            const services = opts?.group ? full.services.filter(s => s.group === opts.group) : full.services
            sup.applyConfig({ services })
            notice = ` 권장 적용: ${name} ${fmtRec(beforeDef, rec)}`
            noticeExpiry = Date.now() + 5000
            if (wasUp) void (async () => { await sup.stop(name); await sup.start(name) })()
            recs.delete(name)   // 재계산은 다음 세션
          } catch (e) {
            notice = ` ⚠ 권장 적용 실패: ${(e as Error).message}`
            noticeExpiry = Date.now() + 8000
          }
        }
        break
      }
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
