#!/usr/bin/env node
import type { Config } from './types.js'
import { loadConfig, ConfigError, RESERVED_WORDS } from './config.js'
import { runApp } from './app.js'

export const VERSION = '0.1.0'

export function helpText(): string {
  return [
    'orca — 로컬 서비스 절약 실행기', '',
    '처음이라면 (첫 10분):',
    '  orca setup            최초 1회: Defender 예외 등록·환경 점검',
    '  orca add              서비스 등록 (대화형)',
    '  orca                  대시보드 실행', '',
    '대시보드:',
    '  orca [그룹]           전체 또는 그룹만 표시',
    '  키: [↑↓/1-9]선택 [s/Enter]시작/중지 [r]재시작 [a]전체 [x]제외 [l]로그 [m]수집 [q]종료', '',
    '자동화·조회:',
    '  orca status [--json]  TUI 없이 상태 확인 (전부 UP=exit 0)',
    '  orca up [그룹]        headless 일괄 시작',
    '  orca down [그룹] --yes  headless 일괄 종료 (--yes 없으면 대상만 표시)',
    '  orca start|stop <이름>  개별 시작/종료',
    '  orca groups           그룹 목록',
    '  orca remove [이름]    서비스 등록 해제', '',
    `예약어(그룹명 사용 불가): ${RESERVED_WORDS.join(' ')}`,
  ].join('\n')
}

export function groupSummary(cfg: Config): string[] {
  const by = new Map<string, string[]>()
  for (const s of cfg.services) {
    const g = s.group ?? '(그룹 없음)'
    if (!by.has(g)) by.set(g, [])
    by.get(g)!.push(s.name)
  }
  return [...by.entries()].map(([g, names]) => `${g} (${names.length}개: ${names.join(', ')})`)
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === '--version') { console.log(VERSION); return }
  if (arg === '--help' || arg === '-h' || arg === 'help') { console.log(helpText()); return }
  if (arg === 'add') { const { runAdd } = await import('./add.js'); await runAdd(); return }
  if (arg === 'setup') { const { runSetup } = await import('./setup.js'); await runSetup(); return }
  if (arg === 'status') {
    const { runStatus } = await import('./status.js')
    try { await runStatus(process.argv[3] === '--json') }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
  if (arg === 'remove') { const { runRemove } = await import('./remove.js'); await runRemove(process.argv.slice(3)); return }
  if (arg === 'up' || arg === 'down') {
    const { runUp, runDown } = await import('./headless.js')
    const rest = process.argv.slice(3)
    const yes = rest.includes('--yes')
    const group = rest.find(a => a !== '--yes')
    try { arg === 'up' ? await runUp(group) : await runDown(group, yes) }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
  if (arg === 'start' || arg === 'stop') {
    const name = process.argv[3]
    if (!name) { console.error(`사용법: orca ${arg} <이름>`); process.exitCode = 1; return }
    const { runStartStop } = await import('./headless.js')
    try { await runStartStop(arg, name) }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
  if (arg === 'groups') {
    try {
      const cfg = loadConfig()
      if (cfg.services.length === 0) {
        console.error('등록된 서비스가 없습니다 — \'orca add\'로 등록하세요.')
        process.exitCode = 1
      } else {
        for (const l of groupSummary(cfg)) console.log(l)
      }
    }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
  try {
    const cfg = loadConfig()
    const group = arg?.trim()
    const services = group ? cfg.services.filter(s => s.group === group) : cfg.services
    if (services.length === 0) {
      if (group) {
        const known = [...new Set(cfg.services.map(s => s.group).filter(Boolean))]
        console.error(`그룹 '${group}'이(가) 없습니다.${known.length ? ` 등록된 그룹: ${known.join(', ')}` : ''}`)
      } else console.error('등록된 서비스가 없습니다')
      process.exitCode = 1
      return
    }
    await runApp({ services })
  } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1; return }
    throw e
  }
}

// 직접 실행(node cli.js / tsx cli.ts)일 때만 main()을 돈다 — vitest 등에서 import만 해도
// 부작용(콘솔 출력·TUI 진입) 없이 helpText/groupSummary 등을 테스트할 수 있어야 한다.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) void main()
