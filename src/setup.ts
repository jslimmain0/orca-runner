import { readFileSync, existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadConfig, ConfigError } from './config.js'

const run = promisify(execFile)

export function adviseGradleProps(props: string): string[] {
  const advices: string[] = []
  const xmx = props.match(/org\.gradle\.jvmargs\s*=.*?-Xmx(\d+)([gGmM])/)
  if (xmx) {
    const mb = Number(xmx[1]) * (xmx[2].toLowerCase() === 'g' ? 1024 : 1)
    if (mb > 2048) advices.push(`Gradle 데몬 힙이 ${xmx[1]}${xmx[2]}입니다 — 로컬 빌드는 2g 이하 권장 (org.gradle.jvmargs)`)
  }
  if (!/org\.gradle\.workers\.max\s*=/.test(props)) {
    advices.push('org.gradle.workers.max 미설정 — 코어 수만큼 병렬 빌드가 돌 수 있습니다. 4~8 권장 (max-workers)')
  }
  return advices
}

export function exclusionPaths(serviceDirs: string[]): string[] {
  return [...new Set([...serviceDirs, join(homedir(), '.gradle')])]
}

export async function runSetup(): Promise<void> {
  let dirs: string[] = []
  let springDirs: string[] = []
  try {
    const cfg = loadConfig()
    dirs = cfg.services.map(s => s.dir)
    springDirs = [...new Set(cfg.services.filter(s => s.kind === 'spring').map(s => s.dir))]
  } catch (e) {
    if (e instanceof ConfigError) console.log('(설정이 없어 등록된 서비스 경로는 건너뜁니다)')
  }
  const paths = exclusionPaths(dirs)
  try {
    const { stdout } = await run('pnpm', ['store', 'path'], { windowsHide: true, shell: true })
    if (stdout.trim()) paths.push(stdout.trim())
  } catch { /* pnpm 없으면 생략 */ }

  console.log('Windows Defender 실시간 검사 예외로 등록할 경로:')
  for (const p of paths) console.log(`  - ${p}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = (await rl.question('등록할까요? 관리자 권한 창이 뜹니다 [y/N] ')).trim().toLowerCase()
  rl.close()
  if (ans === 'y') {
    const list = paths.map(p => `'${p}'`).join(',')
    // UAC 승격 1회로 전체 등록
    spawn('powershell', ['-NoProfile', '-Command',
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command Add-MpPreference -ExclusionPath ${list}'`,
    ], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    console.log('관리자 권한 창에서 등록을 승인해주세요.')
  }

  for (const cmd of [['java', '-version'], ['node', '-v']] as const) {
    try {
      const { stdout, stderr } = await run(cmd[0], [cmd[1]], { windowsHide: true, shell: true })
      console.log(`${cmd[0]}: ${(stdout + stderr).split(/\r?\n/)[0]}`)
    } catch { console.log(`${cmd[0]}: 찾을 수 없음 — PATH 확인 필요`) }
  }

  for (const dir of springDirs) {
    const gp = join(dir, 'gradle.properties')
    if (!existsSync(gp)) continue
    const advices = adviseGradleProps(readFileSync(gp, 'utf8'))
    if (advices.length > 0) {
      console.log(`\n${gp}:`)
      for (const a of advices) console.log(`  ! ${a}`)
    }
  }
  console.log('\nsetup 완료. (프로젝트 파일은 수정하지 않았습니다 — 권장 사항만 안내)')
}
