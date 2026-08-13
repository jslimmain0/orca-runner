import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseDocument } from 'yaml'
import { CONFIG_PATH, ORCA_HOME, loadConfigFromString } from './config.js'

export interface NewService {
  name: string; group?: string; kind: 'spring' | 'command'
  dir: string; module?: string; run?: string; port: number; health?: string
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
  try {
    const name = await ask('서비스 이름: ')
    const kindIn = await ask('종류 (spring/command) [spring]: ')
    const kind = (kindIn === '' ? 'spring' : kindIn) as NewService['kind']
    if (kind !== 'spring' && kind !== 'command') { console.error('spring 또는 command만 가능합니다'); return }
    const dir = await ask('프로젝트 절대 경로: ')
    const port = Number(await ask('포트: '))
    const group = await ask('그룹 (없으면 엔터): ')
    const module = kind === 'spring' ? await ask('Gradle 모듈 (단일 모듈이면 엔터): ') : ''
    const run = kind === 'command' ? await ask('실행 명령: ') : ''
    const health = await ask('헬스체크 URL (없으면 엔터 — 포트로 판정): ')

    let src = ''
    try { src = readFileSync(CONFIG_PATH, 'utf8') } catch { /* 첫 등록 */ }
    const out = appendService(src, {
      name, kind, dir, port,
      group: group || undefined, module: module || undefined,
      run: run || undefined, health: health || undefined,
    })
    loadConfigFromString(out, CONFIG_PATH)   // 저장 전 전체 검증
    mkdirSync(ORCA_HOME, { recursive: true })
    writeFileSync(CONFIG_PATH, out)
    console.log(`등록 완료: ${name} → ${CONFIG_PATH}`)
  } catch (e) {
    console.error(`등록 실패: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  } finally { rl.close() }
}
