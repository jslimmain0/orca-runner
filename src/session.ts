import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ORCA_HOME } from './config.js'
import type { Config } from './types.js'

const SESSION_PATH = join(ORCA_HOME, 'last-session.json')
const RUNNING = new Set(['UP', 'STARTING', 'BUILDING'])
const FAILED = new Set(['CRASHED', 'ERROR'])

export interface LastSession { savedAt: number; services: { name: string; status: string }[] }

export function writeLastSession(services: { name: string; status: string }[], path = SESSION_PATH): void {
  mkdirSync(ORCA_HOME, { recursive: true })
  writeFileSync(path, JSON.stringify({ savedAt: Date.now(), services } satisfies LastSession, null, 2))
}
export function readLastSession(path = SESSION_PATH): LastSession | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as LastSession } catch { return null }
}
export function resumeSet(s: LastSession | null, cfg: Config): string[] {
  if (!s) return []
  const known = new Set(cfg.services.map(x => x.name))
  return s.services.filter(x => RUNNING.has(x.status) && known.has(x.name)).map(x => x.name)
}
export function failedSet(s: LastSession | null, cfg: Config): string[] {
  if (!s) return []
  const known = new Set(cfg.services.map(x => x.name))
  return s.services.filter(x => FAILED.has(x.status) && known.has(x.name)).map(x => x.name)
}
