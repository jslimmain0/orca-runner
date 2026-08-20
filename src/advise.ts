import { parseDocument } from 'yaml'
import { loadConfig, loadConfigFromString, ConfigError } from './config.js'
import { readUsage, jstatSnapshot } from './usage.js'
import { readRunEntries, isAlive } from './procctl.js'
import type { Config, ServiceDef } from './types.js'
import type { UsageEntry, JstatGc } from './usage.js'

export interface Recommendation { heapMb?: number; metaspaceMb?: number; reasons: string[] }

/**
 * 사용량 기반 heapMb/metaspaceMb 추천 — Global Constraints의 고정 수식 그대로.
 * spring 서비스·관측 데이터가 있을 때만 값을 낸다. 하향은 세션 2회 이상 관측을 요구하고,
 * 상향(위험 신호)은 1회 관측이라도 즉시 낸다. 결과가 현재값과 같으면(변화 없음) 그 항목은 스킵한다.
 */
export function recommend(def: ServiceDef, u: UsageEntry | undefined): Recommendation | null {
  if (def.kind !== 'spring') return null
  if (!u) return null

  const reasons: string[] = []
  let heapMb: number | undefined
  let metaspaceMb: number | undefined

  if (u.peakHeapMb !== undefined && def.heapMb > 0) {
    const ratio = u.peakHeapMb / def.heapMb
    const fgcHot = u.fgcAvg !== undefined && u.fgcAvg > 20
    if (ratio > 0.9 || fgcHot) {
      const up = Math.max(Math.ceil(u.peakHeapMb * 1.4 / 128) * 128, def.heapMb + 256)
      if (up !== def.heapMb) {
        heapMb = up
        if (ratio > 0.9) reasons.push(`힙 사용률 ${Math.round(ratio * 100)}%`)
        if (fgcHot) reasons.push(`Full GC 세션평균 ${u.fgcAvg!.toFixed(1)}회`)
      }
    } else if (ratio < 0.35 && u.sessions >= 2) {
      const down = Math.max(256, Math.ceil(u.peakHeapMb * 1.4 / 128) * 128)
      if (down !== def.heapMb) {
        heapMb = down
        reasons.push(`힙 사용률 ${Math.round(ratio * 100)}%`)
      }
    }
  }

  if (u.peakMetaMb !== undefined && def.metaspaceMb > 0) {
    const ratio = u.peakMetaMb / def.metaspaceMb
    if (ratio > 0.85) {
      const up = Math.ceil(u.peakMetaMb * 1.3 / 64) * 64
      if (up !== def.metaspaceMb) {
        metaspaceMb = up
        reasons.push(`메타스페이스 사용률 ${Math.round(ratio * 100)}%`)
      }
    } else if (ratio < 0.4 && u.sessions >= 2) {
      const down = Math.max(128, Math.ceil(u.peakMetaMb * 1.5 / 64) * 64)
      if (down !== def.metaspaceMb) {
        metaspaceMb = down
        reasons.push(`메타스페이스 사용률 ${Math.round(ratio * 100)}%`)
      }
    }
  }

  if (heapMb === undefined && metaspaceMb === undefined) return null
  const rec: Recommendation = { reasons }
  if (heapMb !== undefined) rec.heapMb = heapMb
  if (metaspaceMb !== undefined) rec.metaspaceMb = metaspaceMb
  return rec
}

/** 서비스별 한 블록 — live가 있으면 현재값(jstat 스냅샷)을 병기, command는 측정 제외 한 줄만. */
export function adviseLines(cfg: Config, usage: Record<string, UsageEntry>, live?: Record<string, JstatGc | null>): string[] {
  const lines: string[] = []
  for (const def of cfg.services) {
    lines.push(`${def.name} (:${def.port})`)
    if (def.kind !== 'spring') {
      lines.push('  (측정 제외 — command)')
      lines.push('')
      continue
    }
    const u = usage[def.name]
    if (!u) {
      lines.push('  데이터 없음 — 세션을 실행하면 다음 조회부터 추천이 표시됩니다')
      lines.push('')
      continue
    }
    const liveEntry = live?.[def.name]
    const heapNow = liveEntry ? `, 현재 ${Math.round(liveEntry.heapUsedKb / 1024)}MB` : ''
    const metaNow = liveEntry ? `, 현재 ${Math.round(liveEntry.metaUsedKb / 1024)}MB` : ''
    const heapPeak = u.peakHeapMb !== undefined ? `${u.peakHeapMb}MB` : '-'
    const metaPeak = u.peakMetaMb !== undefined ? `${u.peakMetaMb}MB` : '-'
    const fgc = u.fgcAvg !== undefined ? u.fgcAvg.toFixed(1) : '-'
    lines.push(`  현재 설정: heapMb=${def.heapMb} metaspaceMb=${def.metaspaceMb}`)
    lines.push(`  관측(세션 ${u.sessions}회): 힙 피크 ${heapPeak}${heapNow} · 메타 피크 ${metaPeak}${metaNow} · RSS 피크 ${u.peakRssMb}MB · FGC 평균 ${fgc}`)
    const rec = recommend(def, u)
    if (!rec) {
      lines.push('  권장: 변화 없음')
    } else {
      const parts: string[] = []
      if (rec.heapMb !== undefined) parts.push(`힙 ${def.heapMb}→${rec.heapMb}`)
      if (rec.metaspaceMb !== undefined) parts.push(`메타 ${def.metaspaceMb}→${rec.metaspaceMb}`)
      const why = rec.reasons.length > 0 ? ` (${rec.reasons.join(', ')})` : ''
      lines.push(`  ▼ 권장: ${parts.join(' · ')}${why}`)
    }
    lines.push('')
  }
  return lines
}

/** 순수 함수 — yaml Document API로 heapMb/metaspaceMb만 setIn(있는 값만), 주석 보존, 반환 전 검증. */
export function applyRecommendation(src: string, name: string, rec: Recommendation): string {
  const doc = parseDocument(src)
  if (!doc.hasIn(['services', name])) throw new Error(`'${name}'은(는) 등록돼 있지 않습니다`)
  if (rec.heapMb !== undefined) doc.setIn(['services', name, 'heapMb'], rec.heapMb)
  if (rec.metaspaceMb !== undefined) doc.setIn(['services', name, 'metaspaceMb'], rec.metaspaceMb)
  const out = doc.toString()
  loadConfigFromString(out)   // 쓰기 전 검증 — 실패 시 여기서 throw
  return out
}

/** `orca advise` — 정보 제공 명령이라 항상 exit 0(호출부에서 exitCode를 건드리지 않음). */
export async function runAdvise(): Promise<void> {
  let cfg: Config
  try {
    cfg = loadConfig()
  } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); return }
    throw e
  }
  if (cfg.services.length === 0) {
    console.error('등록된 서비스가 없습니다 — \'orca add\'로 등록하세요.')
    return
  }
  const usage = readUsage()
  const runEntries = readRunEntries()
  const live: Record<string, JstatGc | null> = {}
  const running = cfg.services.filter(s => s.kind === 'spring' && runEntries[s.name] && isAlive(runEntries[s.name].pid))
  // 실행 중 spring 서비스당 jstat 1회성 스냅샷(Global Constraints에서 허용하는 범주) — 새 주기 작업 아님
  await Promise.all(running.map(async s => { live[s.name] = await jstatSnapshot(runEntries[s.name].pid) }))
  for (const line of adviseLines(cfg, usage, live)) console.log(line)
}
