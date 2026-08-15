import { describe, it, expect, afterEach } from 'vitest'
import { watchConfig } from '../src/configWatcher.js'
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/types.js'

const VALID = 'services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 4501\n'
const VALID2 = VALID + '  b:\n    kind: command\n    dir: C:\\y\n    run: r\n    port: 4502\n'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let close: (() => void) | undefined
afterEach(() => { close?.(); close = undefined })

async function waitFor<T>(get: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error('timeout')
    await sleep(100)
  }
}

describe('configWatcher', () => {
  it('파일 저장을 감지해 새 설정을 전달한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let got: Config | undefined
    close = watchConfig(c => { got = c }, () => {}, file, 200)
    await sleep(300)                               // 워처 안정화
    writeFileSync(file, VALID2)
    const cfg = await waitFor(() => got)
    expect(cfg.services.map(s => s.name)).toEqual(['a', 'b'])
  })

  it('rename-replace 저장도 감지한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let got: Config | undefined
    close = watchConfig(c => { got = c }, () => {}, file, 200)
    await sleep(300)
    const tmp = join(dir, 'services.yaml.tmp')
    writeFileSync(tmp, VALID2)
    renameSync(tmp, file)
    const cfg = await waitFor(() => got)
    expect(cfg.services).toHaveLength(2)
  })

  it('깨진 yaml은 onError로 가고 onReload는 불리지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let err: string | undefined
    let reloaded = false
    close = watchConfig(() => { reloaded = true }, m => { err = m }, file, 200)
    await sleep(300)
    writeFileSync(file, 'services:\n  bad name:\n    kind: nope\n')
    const msg = await waitFor(() => err)
    expect(msg.length).toBeGreaterThan(0)
    expect(reloaded).toBe(false)
  })

  it('디바운스: 연속 저장은 한 번만 전달된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let count = 0
    close = watchConfig(() => { count++ }, () => {}, file, 400)
    await sleep(300)
    writeFileSync(file, VALID2)
    await sleep(50)
    writeFileSync(file, VALID)
    await sleep(50)
    writeFileSync(file, VALID2)
    await sleep(1200)
    expect(count).toBe(1)
  })
})
