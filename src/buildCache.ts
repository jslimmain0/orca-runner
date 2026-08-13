import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { ORCA_HOME } from './config.js'

export interface BuildRecord { builtAt: number; jar: string }

const CACHE_PATH = join(ORCA_HOME, 'cache.json')
const SKIP_DIRS = new Set(['build', '.git', '.gradle', 'node_modules', 'out', 'dist', '.idea'])
const ROOT_FILES = /^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/

/** dir 하위에서 src/** 및 gradle 설정 파일들의 최신 mtime(ms). 빌드 산출물 디렉토리는 제외. */
export function latestSourceMtime(dir: string): number {
  let latest = 0
  const walk = (d: string, inSrc: boolean) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(p, inSrc || e.name === 'src')
      } else if (inSrc || ROOT_FILES.test(basename(p))) {
        try {
          const m = statSync(p).mtimeMs
          if (m > latest) latest = m
        } catch { /* 스캔 중 삭제된 파일 무시 */ }
      }
    }
  }
  walk(dir, false)
  return latest
}

export function needsRebuild(dir: string, rec?: BuildRecord): boolean {
  if (!rec) return true
  return latestSourceMtime(dir) > rec.builtAt
}

export function loadCache(path = CACHE_PATH): Record<string, BuildRecord> {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

export function saveCache(c: Record<string, BuildRecord>, path = CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(c, null, 2))
}
