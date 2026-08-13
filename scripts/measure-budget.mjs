// 사용: pnpm build 후 node scripts/measure-budget.mjs
// 더미 서비스 6개를 띄우고 30초간 3초 간격 수집을 돌리며 러너 자신의 CPU/RAM을 측정한다.
import { Supervisor } from '../dist/supervisor.js'
import { StatsCollector } from '../dist/stats.js'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'dummy-server.mjs')
const services = Array.from({ length: 6 }, (_, i) => ({
  name: `dummy-${i}`, kind: 'command', dir: process.cwd(),
  run: `node "${FIXTURE}" ${46100 + i}`, port: 46100 + i,
  health: `http://localhost:${46100 + i}/health`,
  heapMb: 0, cpus: 0, priority: 'normal', jvmArgs: [],
}))

const sup = new Supervisor({ services }, { logDir: mkdtempSync(join(tmpdir(), 'orca-budget-')) })
await sup.startAll()
if (sup.states().some(s => s.status !== 'UP')) {
  console.error('더미 서비스 기동 실패:', sup.states().map(s => `${s.def.name}=${s.status}`).join(' '))
  await sup.stopAll()
  process.exit(1)
}

const stats = new StatsCollector()
stats.start()
const DURATION = 30000
const t0 = process.cpuUsage()
const timer = setInterval(() => { void stats.sample([...sup.pids().values(), stats.helperPid()]) }, 3000)
await new Promise(r => setTimeout(r, DURATION))
clearInterval(timer)

const cpu = process.cpuUsage(t0)
const cpuPct = ((cpu.user + cpu.system) / 1000 / DURATION) * 100
const selfRss = process.memoryUsage().rss
const helperMap = await stats.sample([stats.helperPid()])
const helperRss = helperMap.get(stats.helperPid())?.rssBytes ?? 0
stats.stop()
await sup.stopAll()

const totalMb = (selfRss + helperRss) / 1048576
console.log(`러너 CPU 평균: ${cpuPct.toFixed(2)}%  (예산 1%)`)
console.log(`러너 RAM 합계: ${totalMb.toFixed(0)}MB — 자체 ${(selfRss / 1048576).toFixed(0)}MB + PS헬퍼 ${(helperRss / 1048576).toFixed(0)}MB  (예산 150MB)`)
const ok = cpuPct <= 1 && totalMb <= 150
console.log(ok ? '✔ 예산 통과' : '✘ 예산 초과')
process.exit(ok ? 0 : 1)
