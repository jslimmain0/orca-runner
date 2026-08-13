import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import type { ServiceDef } from './types.js'

export function javaArgs(def: ServiceDef, jar: string): string[] {
  return [
    `-Xmx${def.heapMb}m`,
    '-XX:MaxMetaspaceSize=256m',
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
