import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseDocument } from 'yaml'
import { CONFIG_PATH, ORCA_HOME, loadConfigFromString } from './config.js'

export interface NewService {
  name: string; group?: string; kind: 'spring' | 'command'
  dir: string; module?: string; run?: string; port: number; health?: string
}

const NAME_RE = /^[A-Za-z0-9._-]+$/

export function validateName(name: string, existing: string[]): string | null {
  if (!NAME_RE.test(name)) return `잘못된 서비스 이름: '${name}' (영문/숫자/._- 만 허용)`
  if (existing.includes(name)) return `'${name}'은(는) 이미 등록돼 있습니다`
  return null
}

export function validatePort(input: string, cfg: { services: { name: string; port: number }[] }):
  { ok: true; port: number } | { ok: false; msg: string } {
  const port = Number(input)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, msg: '포트는 1~65535 정수여야 합니다 (예: 8081)' }
  const dup = cfg.services.find(s => s.port === port)
  if (dup) return { ok: false, msg: `포트 ${port}은(는) 이미 ${dup.name}이(가) 쓰고 있습니다` }
  return { ok: true, port }
}

export function resolveGroup(input: string, existing: string[]): { value: string; needsConfirm?: string } {
  const v = input.trim()
  const caseHit = existing.find(g => g !== v && g.toLowerCase() === v.toLowerCase())
  return caseHit ? { value: v, needsConfirm: caseHit } : { value: v }
}

export function appendService(src: string, s: NewService): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s.name)) throw new Error(`잘못된 서비스 이름: '${s.name}' (영문/숫자/._- 만 허용)`)
  const doc = parseDocument(src.trim() === '' ? 'services: {}\n' : src)
  if (doc.hasIn(['services', s.name])) throw new Error(`'${s.name}'은(는) 이미 등록돼 있습니다`)
  const svcNode = doc.get('services', true)
  if (!svcNode || !('items' in (svcNode as object))) doc.setIn(['services'], doc.createNode({}))
  const entry: Record<string, unknown> = { kind: s.kind, dir: s.dir, port: s.port }
  if (s.group) entry.group = s.group
  if (s.module) entry.module = s.module
  if (s.run) entry.run = s.run
  if (s.health) entry.health = s.health
  doc.setIn(['services', s.name], doc.createNode(entry))
  return doc.toString()
}

export async function runAdd(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim()
  /** validate가 null(통과) 아닐 때까지 같은 필드만 재질문 */
  const askValid = async (q: string, validate: (v: string) => string | null): Promise<string> => {
    for (;;) {
      const v = await ask(q)
      const err = validate(v)
      if (err === null) return v
      console.error(`  ✖ ${err}`)
    }
  }
  /** 다른 서비스도 등록할지 묻는다 */
  const askContinue = async (): Promise<boolean> => (await ask('다른 서비스도 등록할까요? [y/N] ')).toLowerCase() === 'y'
  try {
    let count = 0
    for (;;) {
      // 매 회차 디스크 재로드 — 직전 회차가 즉시 저장하므로 캐시 참조 금지 (협의회 P0-4 필수 요건)
      let src = ''
      try { src = readFileSync(CONFIG_PATH, 'utf8') } catch { /* 첫 등록 */ }
      let cur: { services: { name: string; port: number; group?: string }[] } = { services: [] }
      try { cur = loadConfigFromString(src, CONFIG_PATH) } catch { /* 빈/신규 파일 */ }
      const existingNames = cur.services.map(s => s.name)
      const existingGroups = [...new Set(cur.services.map(s => s.group).filter((g): g is string => !!g))]

      count++
      if (count > 1) console.log(`\n[${count}번째 서비스]`)
      const name = await askValid('서비스 이름: ', v => validateName(v, existingNames))
      const kind = await askValid('종류 (spring/command) [spring]: ',
        v => v === '' || v === 'spring' || v === 'command' ? null : 'spring 또는 command만 가능합니다') || 'spring'
      const dir = await askValid('프로젝트 절대 경로 (예: C:\\work\\eis): ',
        v => /^[A-Za-z]:\\/.test(v) ? null : '절대 경로여야 합니다 (예: C:\\work\\eis)')
      if (!existsSync(dir)) {
        const go = await ask('  경로가 존재하지 않습니다. 계속할까요? [y/N] ')
        if (go.toLowerCase() !== 'y') {
          console.log('이 서비스 등록을 건너뜁니다.')
          if (await askContinue()) continue
          break
        }
      }
      const portStr = await askValid('포트 (예: 8081): ', v => { const r = validatePort(v, cur); return r.ok ? null : r.msg })
      const groupHint = existingGroups.length > 0 ? `, 기존: ${existingGroups.join(', ')}` : ''
      let group = (await ask(`그룹 (없으면 엔터${groupHint}): `))
      if (group) {
        const g = resolveGroup(group, existingGroups)
        if (g.needsConfirm) {
          const a = await ask(`  '${g.value}' 대신 기존 그룹 '${g.needsConfirm}'을(를) 쓸까요? [Y/n] `)
          group = a.toLowerCase() === 'n' ? g.value : g.needsConfirm
        } else group = g.value
      }
      const module = kind === 'spring' ? await ask('Gradle 모듈 (단일 모듈이면 엔터): ') : ''
      const run = kind === 'command' ? await askValid('실행 명령: ', v => v ? null : '실행 명령은 필수입니다') : ''
      const health = await ask('헬스체크 URL (없으면 엔터 — 포트로 판정): ')

      const out = appendService(src, {
        name, kind: kind as NewService['kind'], dir, port: Number(portStr),
        group: group || undefined, module: module || undefined,
        run: run || undefined, health: health || undefined,
      })
      loadConfigFromString(out, CONFIG_PATH)
      mkdirSync(ORCA_HOME, { recursive: true })
      writeFileSync(CONFIG_PATH, out)
      console.log(`  ✔ 등록 완료: ${name}`)
      if (!(await askContinue())) break
    }
    console.log(`\n이제 'orca'로 대시보드를 실행해 확인하세요.`)
  } catch (e) {
    console.error(`등록 실패: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  } finally { rl.close() }
}
