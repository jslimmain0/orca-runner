import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import type { ServiceDef } from './types.js'
import { killTree } from './procctl.js'

const run = promisify(execFile)

export function javaArgs(def: ServiceDef, jar: string): string[] {
  return [
    `-Xmx${def.heapMb}m`,
    `-XX:MaxMetaspaceSize=${def.metaspaceMb}m`,
    `-XX:ActiveProcessorCount=${def.cpus}`,
    '-XX:+UseSerialGC',
    ...def.jvmArgs,
    '-jar', jar,
  ]
}

export function findBootJar(dir: string, module?: string): string {
  const libs = module ? join(dir, module, 'build', 'libs') : join(dir, 'build', 'libs')
  let files: string[] = []
  try { files = readdirSync(libs) } catch { /* 폴더 없음 → 아래에서 throw */ }
  const jars = files.filter(f => f.endsWith('.jar') && !f.endsWith('-plain.jar'))
  if (jars.length === 0) throw new Error(`jar를 찾을 수 없습니다: ${libs} — 빌드가 실행됐는지 확인`)
  jars.sort((a, b) => statSync(join(libs, b)).mtimeMs - statSync(join(libs, a)).mtimeMs)
  return join(libs, jars[0])
}

function runGradle(dir: string, args: string[], out?: Writable, onSpawn?: (child: ChildProcess) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd', ['/c', '.\\gradlew.bat', ...args], { cwd: dir, windowsHide: true })
    onSpawn?.(child)
    if (out) { child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false }) }
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

export async function buildJar(def: ServiceDef, out: Writable, onSpawn?: (child: ChildProcess) => void): Promise<string> {
  if (def.module && !/^[A-Za-z0-9._-]+$/.test(def.module)) throw new Error(`잘못된 module 이름: ${def.module}`)
  const target = def.module ? `:${def.module}:bootJar` : 'bootJar'
  const code = await runGradle(def.dir, [target, '-x', 'test'], out, onSpawn)
  if (code !== 0) throw new Error(`빌드 실패: ${def.name} — 로그를 확인하세요`)
  return findBootJar(def.dir, def.module)
}

export async function gradleStop(dir: string): Promise<void> {
  try { await runGradle(dir, ['--stop']) } catch { /* 데몬 없음 등은 무시 */ }
}

/** PowerShell ConvertTo-Json 출력(객체 1개면 객체, 여러 개면 배열, 없으면 빈 문자열)에서 pid 목록을 뽑는다 */
export function parseDaemonPids(json: string): number[] {
  const t = json.trim()
  if (!t) return []
  try {
    const v = JSON.parse(t) as { ProcessId?: number } | { ProcessId?: number }[]
    return (Array.isArray(v) ? v : [v]).map(x => x.ProcessId).filter((n): n is number => typeof n === 'number')
  } catch { return [] }
}

/** 이 PC의 모든 Gradle 데몬(IDE·다른 터미널이 띄운 것 포함)을 명령줄로 찾아 PID 반환 */
export async function findGradleDaemons(): Promise<number[]> {
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*org.gradle.launcher.daemon.bootstrap.GradleDaemon*' } | Select-Object ProcessId | ConvertTo-Json -Compress"
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true })
    return parseDaemonPids(stdout)
  } catch { return [] }
}

/** 찾은 Gradle 데몬을 전부 kill. 종료한 개수 반환 */
export async function killGradleDaemons(): Promise<number> {
  const pids = await findGradleDaemons()
  const r = await Promise.all(pids.map(pid => killTree(pid)))
  return r.filter(Boolean).length
}
