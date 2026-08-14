import { describe, it, expect } from 'vitest'
import { spawnService, killTree, isAlive, recordStart, recordStop, findOrphans } from '../src/procctl.js'
import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
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

  it('run.json에 시작/중지를 기록하고 고아를 찾는다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    recordStart('svc-a', process.pid, file)      // 살아있는 pid
    recordStart('svc-b', 4000000, file)          // 존재하지 않는 pid
    expect(findOrphans(file)).toEqual([{ name: 'svc-a', pid: process.pid }])
    recordStop('svc-a', file)
    expect(findOrphans(file)).toEqual([])
  })
})
