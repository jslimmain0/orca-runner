import { createWriteStream, statSync, renameSync, rmSync, readSync, openSync, closeSync, mkdirSync, type WriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Writable } from 'node:stream'
import { ORCA_HOME } from './config.js'

const MAX_BYTES = 10 * 1024 * 1024
const TAIL_READ = 256 * 1024

export function logPathFor(name: string): string {
  return join(ORCA_HOME, 'logs', `${name}.log`)
}

export class LogWriter {
  private ws: WriteStream
  constructor(file: string, maxBytes = MAX_BYTES) {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > maxBytes) {
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      }
    } catch { /* 파일 없음 */ }
    // Ensure file is created synchronously by opening and closing an fd
    const fd = openSync(file, 'a')
    closeSync(fd)
    this.ws = createWriteStream(file, { flags: 'a' })
  }
  stream(): Writable { return this.ws }
  close(): void { this.ws.end() }
}

export function tailLines(file: string, n: number): string[] {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return [] }
  try {
    const size = statSync(file).size
    const len = Math.min(size, TAIL_READ)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const truncated = len < size
    let lines = buf.toString('utf8').split(/\r?\n/)
    if (truncated) lines = lines.slice(1)
    return lines.filter(l => l.length > 0).slice(-n)
  } finally { closeSync(fd) }
}
