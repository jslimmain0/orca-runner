import net from 'node:net'

export async function httpProbe(url: string, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, detail: `HTTP ${res.status}` }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    if (e.name === 'TimeoutError') return { ok: false, detail: `응답 시간 초과(${timeoutMs}ms)` }
    if (e.cause?.code === 'ECONNREFUSED') return { ok: false, detail: '연결 거부' }
    return { ok: false, detail: e.message }
  }
}

export async function httpUp(url: string, timeoutMs = 2000): Promise<boolean> {
  return (await httpProbe(url, timeoutMs)).ok
}

export function portListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}
