import { describe, it, expect } from 'vitest'
import { spawnService, killTree, isAlive, recordStart, recordStop, findOrphans, readRunEntries, activeSessions } from '../src/procctl.js'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('procctl', () => {
  it('프로세스를 낮은 우선순위로 띄우고 트리째 죽인다', async () => {
    const out = new PassThrough()
    // 자식이 손자를 낳는 스크립트: killTree가 손자까지 정리해야 한다
    const script = "const { spawn } = require('node:child_process');" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);" +
      "console.log('CHILD:' + c.pid); setInterval(()=>{},1000)"
    const { pid } = await spawnService({
      command: process.execPath, args: ['-e', script],
      cwd: process.cwd(), priority: 'belowNormal', out,
    })
    expect(isAlive(pid)).toBe(true)

    // 손자 pid 수집
    let buf = ''
    out.on('data', d => { buf += String(d) })
    await sleep(1500)
    const grandchild = Number(buf.match(/CHILD:(\d+)/)?.[1])
    expect(grandchild).toBeGreaterThan(0)

    // 우선순위 확인 (PowerShell 1회성 — 테스트에서만)
    const cls = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PriorityClass`], { encoding: 'utf8' }).trim()
    expect(cls).toBe('BelowNormal')

    await killTree(pid)
    await sleep(500)
    expect(isAlive(pid)).toBe(false)
    expect(isAlive(grandchild)).toBe(false)
  }, 20000)

  it('존재하지 않는 명령이면 프로세스 전체를 죽이지 않고 reject한다', async () => {
    const out = new PassThrough()
    await expect(spawnService({
      command: 'this-command-does-not-exist-xyz', args: [],
      cwd: process.cwd(), priority: 'normal', out,
    })).rejects.toThrow('this-command-does-not-exist-xyz')
  })

  it('killTree: 살아있는 프로세스는 true, 이미 죽은 pid도 true', async () => {
    const { pid } = await spawnService({
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: process.cwd(), priority: 'normal', out: new PassThrough(),
    })
    expect(await killTree(pid)).toBe(true)      // 실제 종료
    await sleep(300)
    expect(await killTree(pid)).toBe(true)      // 이미 죽음 = 확인된 것
    expect(await killTree(4000000)).toBe(true)  // 존재한 적 없음 = 이미 죽음 취급
  }, 15000)

  it('recordStop이 항목을 지운다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    recordStart('svc-a', process.pid, file)
    recordStop('svc-a', file)
    expect(readRunEntries(file)).toEqual({})
  })

  it('run.json v2: owner를 기록하고 레거시 숫자를 정규화한다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    writeFileSync(file, JSON.stringify({ legacy: 4000000 }))          // v1 레거시
    recordStart('svc-a', process.pid, file)                           // v2 (owner=현재 프로세스)
    const r = readRunEntries(file)
    expect(r['legacy']).toEqual({ pid: 4000000, owner: -1 })
    expect(r['svc-a']).toEqual({ pid: process.pid, owner: process.pid })
  })

  it('findOrphans: 소유 세션이 살아있으면 고아가 아니다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    recordStart('mine', process.pid, file)                            // owner = 살아있는 나
    expect(findOrphans(file)).toEqual([])                             // 고아 아님
    expect(activeSessions(file)).toEqual([{ owner: process.pid, services: [{ name: 'mine', pid: process.pid }] }])
  })

  it('readRunEntries: run.json이 리터럴 null이면 크래시 없이 빈 객체', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    writeFileSync(file, 'null')
    expect(readRunEntries(file)).toEqual({})
  })

  it('spawnService: env가 셸 환경 위에 덮어써진다', async () => {
    const out = new PassThrough()
    let buf = ''
    out.on('data', d => { buf += String(d) })
    const { pid } = await spawnService({
      command: process.execPath,
      args: ['-e', "process.stdout.write((process.env.ORCA_ENV_TEST || 'missing') + '|' + (process.env.PATH ? 'inherited' : 'no-path'))"],
      cwd: process.cwd(), priority: 'normal', out,
      env: { ORCA_ENV_TEST: 'hello' },
    })
    await new Promise(r => setTimeout(r, 1500))
    expect(buf).toBe('hello|inherited')      // 서비스 값 적용 + 셸 환경(PATH) 상속 유지
    expect(isAlive(pid)).toBe(false)
  }, 15000)

  it('findOrphans: owner가 죽었고 pid가 살아있으면 고아, owner=0(headless)은 제외', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    writeFileSync(file, JSON.stringify({
      orphan: { pid: process.pid, owner: 4000000 },   // 죽은 소유자 + 살아있는 pid
      headless: { pid: process.pid, owner: 0 },        // 의도적 분리
      dead: { pid: 4000001, owner: 4000000 },          // pid도 죽음
    }))
    expect(findOrphans(file)).toEqual([{ name: 'orphan', pid: process.pid }])
  })
})
