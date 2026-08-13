import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function parseNetstatPid(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    // [proto, local, remote, state, pid]
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
    if (cols[1].endsWith(`:${port}`)) return Number(cols[4])
  }
  return null
}

export async function whoHoldsPort(port: number): Promise<{ pid: number; exe: string } | null> {
  const { stdout } = await run('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
  const pid = parseNetstatPid(stdout, port)
  if (pid === null) return null
  let exe = '?'
  try {
    const { stdout: t } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    const m = t.match(/^"([^"]+)"/)
    if (m) exe = m[1]
  } catch { /* tasklist 실패해도 pid는 보고 */ }
  return { pid, exe }
}
