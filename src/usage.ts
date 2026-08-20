import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ORCA_HOME } from './config.js'

const run = promisify(execFile)
const USAGE_PATH = join(ORCA_HOME, 'usage.json')

export interface JstatGc { heapUsedKb: number; metaUsedKb: number; fullGc: number; gcTimeSec: number }

export function parseJstatGc(output: string): JstatGc | null {
  const lines = output.trim().split(/\r?\n/)
  if (lines.length < 2) return null
  const cols = lines[0].trim().split(/\s+/)
  const vals = lines[1].trim().split(/\s+/).map(v => Number(v.replace(',', '.')))
  const get = (name: string): number | undefined => {
    const i = cols.indexOf(name)
    return i === -1 || Number.isNaN(vals[i]) ? undefined : vals[i]
  }
  const s0u = get('S0U'), s1u = get('S1U'), eu = get('EU'), ou = get('OU')
  const mu = get('MU'), fgc = get('FGC'), gct = get('GCT')
  if (s0u === undefined || s1u === undefined || eu === undefined || ou === undefined || mu === undefined || fgc === undefined || gct === undefined) return null
  return { heapUsedKb: s0u + s1u + eu + ou, metaUsedKb: mu, fullGc: fgc, gcTimeSec: gct }
}

/** 1회성 스폰 (Global Constraints 허용 범주) — jstat 부재/실패는 null */
export async function jstatSnapshot(pid: number): Promise<JstatGc | null> {
  try {
    const { stdout } = await run('jstat', ['-gc', String(pid)], { windowsHide: true, timeout: 5000 })
    return parseJstatGc(stdout)
  } catch { return null }
}

export interface UsageEntry { sessions: number; peakRssMb: number; peakHeapMb?: number; peakMetaMb?: number; fgcAvg?: number; fgcSamples?: number; updatedAt: string }

export function readUsage(path = USAGE_PATH): Record<string, UsageEntry> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) ?? {}
    return typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}
export function mergeSession(usage: Record<string, UsageEntry>, name: string,
  s: { peakRssMb: number; heapMb?: number; metaMb?: number; fgc?: number }): Record<string, UsageEntry> {
  const prev = usage[name]
  const sessions = (prev?.sessions ?? 0) + 1
  const entry: UsageEntry = {
    sessions,
    peakRssMb: Math.max(prev?.peakRssMb ?? 0, s.peakRssMb),
    updatedAt: new Date().toISOString(),
  }
  if (s.heapMb !== undefined || prev?.peakHeapMb !== undefined) entry.peakHeapMb = Math.max(prev?.peakHeapMb ?? 0, s.heapMb ?? 0)
  if (s.metaMb !== undefined || prev?.peakMetaMb !== undefined) entry.peakMetaMb = Math.max(prev?.peakMetaMb ?? 0, s.metaMb ?? 0)
  if (s.fgc !== undefined) {
    const n = (prev?.fgcSamples ?? 0) + 1
    entry.fgcSamples = n
    entry.fgcAvg = prev?.fgcAvg === undefined ? s.fgc : (prev.fgcAvg * (n - 1) + s.fgc) / n
  } else if (prev?.fgcAvg !== undefined) {
    entry.fgcAvg = prev.fgcAvg
    entry.fgcSamples = prev.fgcSamples
  }
  return { ...usage, [name]: entry }
}
export function writeUsage(u: Record<string, UsageEntry>, path = USAGE_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(u, null, 2))
}
