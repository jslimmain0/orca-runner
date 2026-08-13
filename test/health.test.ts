import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { httpUp, portListening } from '../src/health.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const PORT = 45810
let child: ChildProcess

beforeAll(async () => {
  child = spawn(process.execPath, [FIXTURE, String(PORT)], { windowsHide: true })
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
})
afterAll(() => { child.kill() })

describe('health', () => {
  it('떠 있는 서버의 /health는 true', async () => {
    expect(await httpUp(`http://localhost:${PORT}/health`)).toBe(true)
  })
  it('404 경로는 false', async () => {
    expect(await httpUp(`http://localhost:${PORT}/nope`)).toBe(false)
  })
  it('닫힌 포트는 false (throw하지 않음)', async () => {
    expect(await httpUp('http://localhost:1/health', 500)).toBe(false)
  })
  it('portListening: 리슨 중 true / 닫힌 포트 false', async () => {
    expect(await portListening(PORT)).toBe(true)
    expect(await portListening(1)).toBe(false)
  })
})
