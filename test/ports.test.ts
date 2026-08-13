import { describe, it, expect } from 'vitest'
import { parseNetstatPid, whoHoldsPort } from '../src/ports.js'
import { createServer } from 'node:http'

const SAMPLE = [
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
  '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       5678',
  '  TCP    127.0.0.1:8082         127.0.0.1:50000        ESTABLISHED     9999',
  '  TCP    [::]:8081              [::]:0                 LISTENING       5678',
].join('\r\n')

describe('ports', () => {
  it('LISTENING 중인 포트의 PID를 찾는다', () => {
    expect(parseNetstatPid(SAMPLE, 8081)).toBe(5678)
  })
  it('LISTENING이 아니면 무시한다', () => {
    expect(parseNetstatPid(SAMPLE, 8082)).toBeNull()
  })
  it('실제 리슨 중인 포트에서 자기 자신을 찾는다', async () => {
    const srv = createServer(() => {})
    await new Promise<void>(r => srv.listen(0, () => r()))
    const port = (srv.address() as { port: number }).port
    const holder = await whoHoldsPort(port)
    expect(holder?.pid).toBe(process.pid)
    srv.close()
  })
  it('빈 포트는 null', async () => {
    expect(await whoHoldsPort(1)).toBeNull()
  })
})
