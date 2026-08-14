import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Writable } from 'node:stream'
import type { Priority } from './types.js'
import { ORCA_HOME } from './config.js'

const run = promisify(execFile)
const RUN_PATH = join(ORCA_HOME, 'run.json')

const PRIO: Record<Priority, number> = {
  normal: os.constants.priority.PRIORITY_NORMAL,
  belowNormal: os.constants.priority.PRIORITY_BELOW_NORMAL,
  idle: os.constants.priority.PRIORITY_LOW,
}

export async function spawnService(o: {
  command: string; args: string[]; cwd: string
  priority: Priority; cpus?: number; out: Writable
}): Promise<{ pid: number; child: ChildProcess }> {
  // cmd.exe로 위임하는 원문 명령줄(예: `cmd /c <run>`)은 Node의 기본 인자 자동-따옴표 처리가
  // 내장된 큰따옴표를 백슬래시로 이스케이프해 cmd가 이를 리터럴로 오인, 경로를 깨뜨린다.
  // command가 cmd일 때만 verbatim으로 넘겨 이미 올바르게 인용된 문자열을 그대로 전달한다.
  const windowsVerbatimArguments = o.command.toLowerCase() === 'cmd'
  const child = spawn(o.command, o.args, { cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } catch (err) {
    throw new Error(`프로세스 시작 실패: ${o.command} — ${(err as Error).message}`)
  }
  // spawn 성공 이후 발생하는 비동기 'error' 이벤트가 프로세스 전체를 죽이지 않도록 가드
  child.on('error', () => { /* killTree 등에서 별도로 처리 */ })
  if (child.pid === undefined) throw new Error(`프로세스 시작 실패: ${o.command}`)
  child.stdout!.pipe(o.out, { end: false })
  child.stderr!.pipe(o.out, { end: false })
  try { os.setPriority(child.pid, PRIO[o.priority]) } catch { /* 이미 종료된 경우 */ }
  if (o.cpus && o.cpus > 0 && o.cpus < os.cpus().length) {
    const mask = (1 << o.cpus) - 1
    // 시작 시점 1회성 스폰 (Global Constraints에서 허용)
    run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).ProcessorAffinity=[IntPtr]${mask}`], { windowsHide: true }).catch(() => {})
  }
  return { pid: child.pid, child }
}

/** true = 트리 종료 확인(성공 또는 이미 죽음), false = 진짜 실패(권한 등) */
export async function killTree(pid: number): Promise<boolean> {
  try { await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); return true }
  catch (err) {
    const code = (err as { code?: number }).code
    if (code === 128) return true          // ERROR_WAIT_NO_CHILDREN: 프로세스 없음 = 이미 죽음
    return !isAlive(pid)                   // 그 외 오류라도 실제로 죽었으면 확인된 것
  }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export interface RunEntry { pid: number; owner: number }

export function readRunEntries(path = RUN_PATH): Record<string, RunEntry> {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
  const out: Record<string, RunEntry> = {}
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v === 'number') out[name] = { pid: v, owner: -1 }                       // v1 레거시
    else if (v && typeof v === 'object' && typeof (v as RunEntry).pid === 'number') {
      out[name] = { pid: (v as RunEntry).pid, owner: typeof (v as RunEntry).owner === 'number' ? (v as RunEntry).owner : -1 }
    }
  }
  return out
}
function writeRunEntries(r: Record<string, RunEntry>, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(r, null, 2))
}

export function recordStart(name: string, pid: number, path = RUN_PATH, owner = process.pid): void {
  const r = readRunEntries(path); r[name] = { pid, owner }; writeRunEntries(r, path)
}
export function recordStop(name: string, path = RUN_PATH): void {
  const r = readRunEntries(path); delete r[name]; writeRunEntries(r, path)
}
/** 소유 세션이 죽었고(단 headless=0 제외) 프로세스는 살아있는 항목 = 진짜 고아 */
export function findOrphans(path = RUN_PATH): { name: string; pid: number }[] {
  return Object.entries(readRunEntries(path))
    .filter(([, e]) => isAlive(e.pid) && e.owner !== 0 && !(e.owner > 0 && isAlive(e.owner)))
    .map(([name, e]) => ({ name, pid: e.pid }))
}
/** owner가 살아있는(headless=0 제외) 세션들이 관리 중인 서비스 */
export function activeSessions(path = RUN_PATH): { owner: number; services: { name: string; pid: number }[] }[] {
  const by = new Map<number, { name: string; pid: number }[]>()
  for (const [name, e] of Object.entries(readRunEntries(path))) {
    if (e.owner > 0 && isAlive(e.owner) && isAlive(e.pid)) {
      if (!by.has(e.owner)) by.set(e.owner, [])
      by.get(e.owner)!.push({ name, pid: e.pid })
    }
  }
  return [...by.entries()].map(([owner, services]) => ({ owner, services }))
}
