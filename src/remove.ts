import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseDocument } from 'yaml'
import { CONFIG_PATH, loadConfigFromString } from './config.js'

export function removeService(src: string, name: string): string {
  const doc = parseDocument(src)
  if (!doc.hasIn(['services', name])) throw new Error(`'${name}'은(는) 등록돼 있지 않습니다`)
  doc.deleteIn(['services', name])
  return doc.toString()
}

export async function runRemove(argv: string[]): Promise<void> {
  const yes = argv.includes('--yes')
  let name = argv.find(a => a !== '--yes')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const src = readFileSync(CONFIG_PATH, 'utf8')
    const cfg = loadConfigFromString(src, CONFIG_PATH)
    if (!name) {
      cfg.services.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} (:${s.port}${s.group ? `, ${s.group}` : ''})`))
      const pick = Number((await rl.question('해제할 번호: ')).trim())
      if (!Number.isInteger(pick) || pick < 1 || pick > cfg.services.length) { console.error('잘못된 번호입니다'); process.exitCode = 1; return }
      name = cfg.services[pick - 1].name
    }
    if (!yes) {
      const a = (await rl.question(`'${name}'을(를) 등록 해제할까요? [y/N] `)).trim().toLowerCase()
      if (a !== 'y') { console.log('취소했습니다'); process.exitCode = 1; return }
    }
    writeFileSync(CONFIG_PATH, removeService(src, name))
    console.log(`✔ 등록 해제: ${name}`)
  } catch (e) {
    console.error(`해제 실패: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  } finally { rl.close() }
}
