import { describe, it, expect, afterAll } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portListening } from '../src/health.js'
import { whoHoldsPort } from '../src/ports.js'

// 실제 orca CLI를 별도 프로세스로 스폰하는 진짜 통합 테스트 — vitest 워커 내부에서 Supervisor를
// 직접 호출하면 워커 자체의 teardown이 "부모 프로세스가 자연 종료했는가"를 가려버려서(vitest가
// 워커를 강제로 죽이므로) orca up이 실제로 스스로 exit하는지는 확인할 수 없다. 그래서 여기서는
// child_process로 orca CLI 프로세스를 띄우고, 그 프로세스 자체가 시간 내에 스스로 종료하는지를
// 검증한다.

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const PORT = 46310
const REPO_ROOT = process.cwd()

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-e2e-'))
  mkdirSync(join(home, '.orca'), { recursive: true })
  const yaml = [
    'services:',
    '  h-e2e:',
    '    kind: command',
    `    dir: ${REPO_ROOT}`,
    `    run: node "${FIXTURE}" ${PORT}`,
    `    port: ${PORT}`,
    `    health: http://localhost:${PORT}/health`,
    '',
  ].join('\n')
  writeFileSync(join(home, '.orca', 'services.yaml'), yaml)
  return home
}

interface CliResult { code: number | null; stdout: string; stderr: string }

// orca CLI를 별도 프로세스로 띄우고 스스로 종료하는지를 타임아웃과 함께 기다린다.
// 자연 종료하지 않으면(=이벤트 루프 hang 회귀) 타임아웃에서 reject.
function runCli(args: string[], home: string, timeoutMs = 30000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, USERPROFILE: home },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += String(d) })
    child.stderr.on('data', d => { stderr += String(d) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI가 ${timeoutMs}ms 내에 스스로 종료하지 않았습니다 (이벤트 루프 hang) — stdout: ${stdout} stderr: ${stderr}`))
    }, timeoutMs)
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.once('error', err => { clearTimeout(timer); reject(err) })
  })
}

describe('headless e2e: orca up/down 프로세스가 스스로 종료한다', () => {
  let home = ''

  afterAll(async () => {
    // 안전망 — 테스트가 도중에 실패해도 46310 포트에 뜬 프로세스를 남기지 않는다.
    if (home) {
      try { await runCli(['down', '--yes'], home, 15000) } catch { /* best-effort */ }
    }
    const holder = await whoHoldsPort(PORT)
    if (holder) {
      try { execFileSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { windowsHide: true }) } catch { /* 이미 죽었을 수도 */ }
    }
  }, 20000)

  it('up: CLI 프로세스는 30초 내 exit 0으로 스스로 종료하고, 서비스는 계속 살아있는다', async () => {
    home = makeHome()
    const r = await runCli(['up'], home)
    expect(r.code).toBe(0)
    expect(await portListening(PORT)).toBe(true)
  }, 35000)

  it('down --yes: CLI도 exit 0으로 종료하고, 포트도 내려간다', async () => {
    const r = await runCli(['down', '--yes'], home)
    expect(r.code).toBe(0)
    expect(await portListening(PORT)).toBe(false)
  }, 35000)
})
