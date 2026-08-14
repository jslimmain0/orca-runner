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
  let name = argv.find(a => !a.startsWith('--'))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    let src: string
    try { src = readFileSync(CONFIG_PATH, 'utf8') } catch {
      console.error(`설정 파일이 없습니다: ${CONFIG_PATH}\n'orca add'로 서비스를 등록하세요.`)
      process.exitCode = 1
      return
    }
    const cfg = loadConfigFromString(src, CONFIG_PATH)
    if (!name) {
      cfg.services.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} (:${s.port}${s.group ? `, ${s.group}` : ''})`))
      const pick = Number((await rl.question('해제할 번호: ')).trim())
      if (!Number.isInteger(pick) || pick < 1 || pick > cfg.services.length) { console.error('잘못된 번호입니다'); process.exitCode = 1; return }
      name = cfg.services[pick - 1].name
    }
    const isLast = cfg.services.length === 1
    if (!yes) {
      const prompt = isLast
        ? `'${name}'은(는) 마지막 서비스입니다. 해제하면 등록된 서비스가 없게 됩니다. 해제할까요? [y/N] `
        : `'${name}'을(를) 등록 해제할까요? [y/N] `
      const a = (await rl.question(prompt)).trim().toLowerCase()
      if (a !== 'y') { console.log('취소했습니다'); process.exitCode = 1; return }
    }
    const out = removeService(src, name)
    loadConfigFromString(out, CONFIG_PATH)
    writeFileSync(CONFIG_PATH, out)
    const message = cfg.services.length === 1
      ? `✔ 등록 해제: ${name} (남은 서비스 없음 — 'orca add'로 다시 등록하세요)`
      : `✔ 등록 해제: ${name}`
    console.log(message)
  } catch (e) {
    console.error(`해제 실패: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  } finally { rl.close() }
}
