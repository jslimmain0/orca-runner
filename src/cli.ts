#!/usr/bin/env node
import { loadConfig, ConfigError } from './config.js'
import { runApp } from './app.js'

export const VERSION = '0.1.0'

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === '--version') { console.log(VERSION); return }
  if (arg === 'add') { const { runAdd } = await import('./add.js'); await runAdd(); return }
  try {
    const cfg = loadConfig()
    const services = arg ? cfg.services.filter(s => s.group === arg) : cfg.services
    if (services.length === 0) {
      console.error(arg ? `그룹 '${arg}'에 등록된 서비스가 없습니다` : '등록된 서비스가 없습니다')
      process.exitCode = 1
      return
    }
    await runApp({ services })
  } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1; return }
    throw e
  }
}
void main()
