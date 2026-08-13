# orca 러너 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows에서 등록된 로컬 서비스들을 자원 제한(힙·코어·우선순위) 걸어 백그라운드로 띄우고 TUI 대시보드로 관리하는 `orca` CLI를 만든다.

**Architecture:** Node.js 단일 프로세스가 자식 서비스 프로세스들을 소유하고(supervisor), 자원 수집은 장수명 PowerShell 헬퍼 1개에 요청-응답으로 위임하며, TUI는 ANSI 이스케이프 직접 렌더링. 설정은 전역 `~\.orca\services.yaml`.

**Tech Stack:** Node.js 20+, TypeScript(NodeNext ESM), 런타임 의존성 `yaml` 단 하나, dev는 vitest/tsx/typescript. 스펙: `docs/superpowers/specs/2026-08-14-orca-runner-design.md`

## Global Constraints

- **Windows 전용.** 경로·프로세스 제어 모두 win32 전제. wmic 사용 금지(Win11 24H2에서 제거됨).
- **런타임 의존성은 `yaml` 하나만.** TUI 프레임워크(ink/blessed) 금지 — ANSI 직접 렌더링.
- **자원 예산: 러너 전체(TUI+수집+헬스체크) 평균 CPU 1% 이하, RAM 150MB 이하.** Task 15에서 측정으로 검증.
- **수집은 3초에 한 번, 전체 PID 일괄 샘플링. 폴링마다 프로세스 스폰 금지** — 장수명 헬퍼 1개(요청-응답)만 허용. 서비스 시작/중지 시점의 1회성 스폰(netstat, taskkill, affinity 설정)은 허용.
- **크래시 자동 재시작 금지** — CRASHED 표시만.
- 파일 위치: 설정 `%USERPROFILE%\.orca\services.yaml`, 로그 `%USERPROFILE%\.orca\logs\<이름>.log`(10MB 롤링 1회), 실행 기록 `%USERPROFILE%\.orca\run.json`, 빌드 캐시 `%USERPROFILE%\.orca\cache.json`.
- spring 프리셋 기본값: heapMb=512, cpus=2, priority=belowNormal, `-XX:MaxMetaspaceSize=256m`, `-XX:+UseSerialGC`.
- 저장소 루트: `C:\Users\jslim\orca\runner`. 커밋 메시지는 conventional commits(`feat:`, `test:`, `docs:` …).
- 모든 명령 예시는 저장소 루트에서 PowerShell 기준. 테스트 실행은 `pnpm test`(= `vitest run`).

## File Structure

```
runner/
  package.json / tsconfig.json / .gitignore / README.md
  assets/stats-helper.ps1     # 장수명 자원수집 헬퍼 (Task 10)
  src/
    types.ts                  # 공용 타입 (Task 2)
    config.ts                 # services.yaml 로드/검증/기본값 병합 (Task 2)
    ports.ts                  # 포트 점유 검사 netstat 파싱 (Task 3)
    buildCache.ts             # 소스 mtime 스캔 + cache.json (Task 4)
    procctl.ts                # spawn/우선순위/affinity/트리킬/run.json (Task 5)
    logs.ts                   # LogWriter(롤링) + tailLines (Task 6)
    health.ts                 # HTTP 헬스체크 + 포트 리슨 확인 (Task 7)
    spring.ts                 # gradlew bootJar/jar 탐색/java 인자/--stop (Task 8)
    supervisor.ts             # 서비스 상태머신·시작/중지 오케스트레이션 (Task 9)
    stats.ts                  # StatsCollector — PS 헬퍼 통신 (Task 10)
    sysinfo.ts                # 시스템 전체 CPU/RAM (os.cpus 델타) (Task 10)
    tui/screen.ts             # alt buffer·diff 렌더링 (Task 11)
    tui/keys.ts               # 키 입력 파싱 (Task 11)
    tui/dashboard.ts          # 메인 화면 조립 (Task 12)
    tui/logView.ts            # 로그 tail 뷰 (Task 12)
    app.ts                    # supervisor+stats+TUI 연결 루프 (Task 12)
    cli.ts                    # 엔트리/인자 분기 (Task 1, 12에서 확장)
    add.ts                    # orca add 대화형 등록 (Task 13)
    setup.ts                  # orca setup — Defender 예외 등 (Task 14)
  test/
    fixtures/dummy-server.mjs # 1초 내 뜨는 더미 HTTP 서버 (Task 7)
    *.test.ts                 # 각 태스크의 vitest 테스트
  scripts/measure-budget.mjs  # 자원 예산 측정 (Task 15)
```

의존 관계: supervisor(9) ← config(2)·ports(3)·buildCache(4)·procctl(5)·logs(6)·health(7)·spring(8). app(12) ← supervisor(9)·stats(10)·tui(11). add(13)·setup(14)는 config에만 의존. Task 2~8은 서로 독립이라 순서 바꿔도 된다.

---

### Task 1: 프로젝트 스캐폴드 + CLI 엔트리

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/cli.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `src/cli.ts`가 `--version` 인자에 버전을 출력하는 실행 엔트리. 이후 태스크는 `pnpm test`(vitest)와 `node --import tsx src/cli.ts` 실행 환경을 전제.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/cli.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

describe('cli', () => {
  it('--version 이 버전을 출력한다', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], { encoding: 'utf8' })
    expect(out.trim()).toBe('0.1.0')
  })
})
```

- [ ] **Step 2: 프로젝트 파일 생성**

`package.json`:

```json
{
  "name": "orca-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "orca": "./dist/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run"
  },
  "dependencies": { "yaml": "^2.5.0" },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules/
dist/
*.log
```

`src/cli.ts`:

```ts
export const VERSION = '0.1.0'

const arg = process.argv[2]
if (arg === '--version') {
  console.log(VERSION)
  process.exit(0)
}
console.log('orca: 아직 구현 중입니다. --version 만 지원.')
```

- [ ] **Step 3: 설치 후 테스트 실패 확인**

Run: `pnpm install` 후 `pnpm test`
Expected: Step 2까지 하면 통과해버리므로 순서 주의 — 테스트 파일만 있는 상태에서 `pnpm install; pnpm test`로 FAIL(cli.ts 없음)을 먼저 확인하고 Step 2의 `src/cli.ts`를 만든다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test`
Expected: PASS (1 passed)

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: 프로젝트 스캐폴드 및 CLI 엔트리"
```

---

### Task 2: 설정 로더 (types + config)

**Files:**
- Create: `src/types.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `Kind = 'spring'|'command'`, `Priority = 'normal'|'belowNormal'|'idle'`, `ServiceDef { name, group?, kind, dir, module?, run?, port, health?, heapMb, cpus, priority, jvmArgs }`(spring 기본값 병합 후라 heapMb/cpus/priority는 non-optional), `Config { services: ServiceDef[] }`, `ServiceStatus = 'DOWN'|'BUILDING'|'STARTING'|'UP'|'CRASHED'|'ERROR'`, `ServiceState { def, status, pid?, error?, cpuPercent?, rssBytes? }`
  - `config.ts`: `loadConfig(path?: string): Config`, `loadConfigFromString(src: string, path?: string): Config`, `class ConfigError extends Error`, `const CONFIG_PATH`(= `~\.orca\services.yaml`)
- 검증 실패 시 `ConfigError` 메시지에 **파일 경로와 줄 번호** 포함 (스펙 요구).

- [ ] **Step 1: 실패하는 테스트 작성** — `test/config.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { loadConfigFromString, ConfigError } from '../src/config.js'

const VALID = `
defaults:
  spring:
    heapMb: 768
services:
  eis-server:
    group: tspay
    kind: spring
    dir: C:\\work\\eis
    module: eis-server
    port: 8081
    health: http://localhost:8081/actuator/health
  gateway:
    kind: command
    dir: C:\\work\\gw
    run: run-local.cmd
    port: 9000
`

describe('config', () => {
  it('유효한 yaml을 파싱하고 spring 기본값을 병합한다', () => {
    const cfg = loadConfigFromString(VALID)
    expect(cfg.services).toHaveLength(2)
    const eis = cfg.services[0]
    expect(eis.name).toBe('eis-server')
    expect(eis.heapMb).toBe(768)      // defaults.spring 오버라이드
    expect(eis.cpus).toBe(2)          // 내장 기본값
    expect(eis.priority).toBe('belowNormal')
  })

  it('command 서비스에 run이 없으면 줄 번호와 함께 에러', () => {
    const bad = `services:\n  gw:\n    kind: command\n    dir: C:\\x\n    port: 9000\n`
    expect(() => loadConfigFromString(bad, 'C:\\cfg.yaml')).toThrowError(ConfigError)
    try { loadConfigFromString(bad, 'C:\\cfg.yaml') } catch (e) {
      expect((e as Error).message).toMatch(/C:\\cfg\.yaml/)
      expect((e as Error).message).toMatch(/2행/)     // gw: 가 있는 줄
      expect((e as Error).message).toMatch(/run/)
    }
  })

  it('알 수 없는 kind는 에러', () => {
    const bad = `services:\n  a:\n    kind: docker\n    dir: C:\\x\n    port: 1\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/kind/)
  })

  it('포트 중복은 에러', () => {
    const bad = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r.cmd\n    port: 1\n  b:\n    kind: command\n    dir: C:\\y\n    run: r.cmd\n    port: 1\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/포트/)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: 구현**

`src/types.ts`:

```ts
export type Kind = 'spring' | 'command'
export type Priority = 'normal' | 'belowNormal' | 'idle'

export interface ServiceDef {
  name: string
  group?: string
  kind: Kind
  dir: string
  module?: string        // spring: 멀티모듈 대상
  run?: string           // command: 실행 명령
  port: number
  health?: string        // 헬스체크 URL (없으면 포트 리슨으로 판정)
  heapMb: number
  cpus: number
  priority: Priority
  jvmArgs: string[]
}

export interface Config { services: ServiceDef[] }

export type ServiceStatus = 'DOWN' | 'BUILDING' | 'STARTING' | 'UP' | 'CRASHED' | 'ERROR'

export interface ServiceState {
  def: ServiceDef
  status: ServiceStatus
  pid?: number
  error?: string
  cpuPercent?: number
  rssBytes?: number
}
```

`src/config.ts`:

```ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import type { Config, Kind, Priority, ServiceDef } from './types.js'

export class ConfigError extends Error {}

export const ORCA_HOME = join(homedir(), '.orca')
export const CONFIG_PATH = join(ORCA_HOME, 'services.yaml')

const BUILTIN = { heapMb: 512, cpus: 2, priority: 'belowNormal' as Priority }
const KINDS: Kind[] = ['spring', 'command']
const PRIORITIES: Priority[] = ['normal', 'belowNormal', 'idle']

export function loadConfig(path = CONFIG_PATH): Config {
  let src: string
  try { src = readFileSync(path, 'utf8') } catch {
    throw new ConfigError(`설정 파일이 없습니다: ${path}\n'orca add'로 서비스를 등록하세요.`)
  }
  return loadConfigFromString(src, path)
}

export function loadConfigFromString(src: string, path = '(inline)'): Config {
  const lc = new LineCounter()
  const doc = parseDocument(src, { lineCounter: lc })
  if (doc.errors.length > 0) {
    const e = doc.errors[0]
    throw new ConfigError(`${path} ${lc.linePos(e.pos[0]).line}행: YAML 문법 오류 — ${e.message}`)
  }
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>

  const lineOf = (keys: (string | number)[]): number => {
    const node = doc.getIn(keys, true) as { range?: [number, number, number] } | undefined
    return node?.range ? lc.linePos(node.range[0]).line : 1
  }
  const fail = (keys: (string | number)[], msg: string): never => {
    throw new ConfigError(`${path} ${lineOf(keys)}행: ${msg}`)
  }

  const d = (raw.defaults as { spring?: Partial<typeof BUILTIN> } | undefined)?.spring ?? {}
  const springDefaults = { ...BUILTIN, ...d }

  const rawServices = raw.services as Record<string, Record<string, unknown>> | undefined
  if (!rawServices || Object.keys(rawServices).length === 0) {
    throw new ConfigError(`${path}: services 항목이 비어 있습니다.`)
  }

  const services: ServiceDef[] = []
  for (const [name, s] of Object.entries(rawServices)) {
    const at = ['services', name]
    if (!KINDS.includes(s.kind as Kind)) fail(at, `${name}: kind는 spring|command 여야 합니다 (현재: ${s.kind})`)
    if (typeof s.dir !== 'string' || !/^[A-Za-z]:\\/.test(s.dir)) fail(at, `${name}: dir는 절대 경로여야 합니다`)
    const port = s.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail(at, `${name}: port는 1~65535 정수여야 합니다`)
    }
    if (s.kind === 'command' && typeof s.run !== 'string') fail(at, `${name}: command 서비스는 run이 필요합니다`)
    if (s.priority !== undefined && !PRIORITIES.includes(s.priority as Priority)) {
      fail(at, `${name}: priority는 normal|belowNormal|idle 중 하나여야 합니다`)
    }
    const base = s.kind === 'spring' ? springDefaults : { ...BUILTIN, heapMb: 0 }
    services.push({
      name,
      group: s.group as string | undefined,
      kind: s.kind as Kind,
      dir: s.dir as string,
      module: s.module as string | undefined,
      run: s.run as string | undefined,
      port: port as number,
      health: s.health as string | undefined,
      heapMb: (s.heapMb as number | undefined) ?? base.heapMb,
      cpus: (s.cpus as number | undefined) ?? base.cpus,
      priority: (s.priority as Priority | undefined) ?? base.priority,
      jvmArgs: (s.jvmArgs as string[] | undefined) ?? [],
    })
  }

  const seenPort = new Map<number, string>()
  for (const s of services) {
    const dup = seenPort.get(s.port)
    if (dup) throw new ConfigError(`${path} ${lineOf(['services', s.name, 'port'])}행: 포트 ${s.port}가 ${dup}와(과) 중복됩니다`)
    seenPort.set(s.port, s.name)
  }
  return { services }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test`
Expected: PASS. 줄 번호 assertion(`2행`)이 어긋나면 `lineOf`가 반환하는 실제 줄을 확인해 테스트 기대값을 실제 동작에 맞게 수정한다(키 노드 기준이라 서비스 이름 줄).

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: services.yaml 설정 로더 및 검증"
```

---

### Task 3: 포트 점유 검사 (ports)

**Files:**
- Create: `src/ports.ts`
- Test: `test/ports.test.ts`

**Interfaces:**
- Produces: `parseNetstatPid(output: string, port: number): number | null`, `whoHoldsPort(port: number): Promise<{ pid: number; exe: string } | null>` — 시작 시점 1회성 `netstat -ano -p tcp` + `tasklist` 스폰 (Global Constraints에서 허용).
- Consumes: 없음 (독립 모듈)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/ports.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseNetstatPid, whoHoldsPort } from '../src/ports.js'
import { createServer } from 'node:http'

const SAMPLE = [
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
  '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       5678',
  '  TCP    127.0.0.1:8082         127.0.0.1:50000        ESTABLISHED     9999',
  '  TCP    [::]:8081              [::]:0                 LISTENING       5678',
].join('\r\n')

describe('ports', () => {
  it('LISTENING 중인 포트의 PID를 찾는다', () => {
    expect(parseNetstatPid(SAMPLE, 8081)).toBe(5678)
  })
  it('LISTENING이 아니면 무시한다', () => {
    expect(parseNetstatPid(SAMPLE, 8082)).toBeNull()
  })
  it('실제 리슨 중인 포트에서 자기 자신을 찾는다', async () => {
    const srv = createServer(() => {})
    await new Promise<void>(r => srv.listen(0, () => r()))
    const port = (srv.address() as { port: number }).port
    const holder = await whoHoldsPort(port)
    expect(holder?.pid).toBe(process.pid)
    srv.close()
  })
  it('빈 포트는 null', async () => {
    expect(await whoHoldsPort(1)).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/ports.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/ports.ts`

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function parseNetstatPid(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    // [proto, local, remote, state, pid]
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
    if (cols[1].endsWith(`:${port}`)) return Number(cols[4])
  }
  return null
}

export async function whoHoldsPort(port: number): Promise<{ pid: number; exe: string } | null> {
  const { stdout } = await run('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
  const pid = parseNetstatPid(stdout, port)
  if (pid === null) return null
  let exe = '?'
  try {
    const { stdout: t } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    const m = t.match(/^"([^"]+)"/)
    if (m) exe = m[1]
  } catch { /* tasklist 실패해도 pid는 보고 */ }
  return { pid, exe }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/ports.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: netstat 기반 포트 점유 검사"
```

---

### Task 4: 빌드 캐시 (buildCache)

**Files:**
- Create: `src/buildCache.ts`
- Test: `test/buildCache.test.ts`

**Interfaces:**
- Produces: `latestSourceMtime(dir: string): number`, `needsRebuild(dir: string, rec?: BuildRecord): boolean`, `loadCache(path?: string): Record<string, BuildRecord>`, `saveCache(c: Record<string, BuildRecord>, path?: string): void`, `interface BuildRecord { builtAt: number; jar: string }` — 캐시 키는 서비스 이름, 기본 저장 위치 `~\.orca\cache.json`.
- Consumes: `ORCA_HOME` (config.ts)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/buildCache.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestSourceMtime, needsRebuild, loadCache, saveCache } from '../src/buildCache.js'

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bc-'))
  mkdirSync(join(dir, 'src', 'main'), { recursive: true })
  mkdirSync(join(dir, 'build', 'libs'), { recursive: true })   // 스캔 제외 대상
  writeFileSync(join(dir, 'build.gradle'), 'plugins {}')
  writeFileSync(join(dir, 'src', 'main', 'App.java'), 'class App {}')
  writeFileSync(join(dir, 'build', 'libs', 'app.jar'), 'jar')
  return dir
}

describe('buildCache', () => {
  it('build/ 밑은 무시하고 소스의 최신 mtime을 찾는다', () => {
    const dir = makeProject()
    const old = Date.now() / 1000 - 3600
    utimesSync(join(dir, 'build.gradle'), old, old)
    utimesSync(join(dir, 'src', 'main', 'App.java'), old, old)
    const jarTime = Date.now() / 1000
    utimesSync(join(dir, 'build', 'libs', 'app.jar'), jarTime, jarTime)
    const mtime = latestSourceMtime(dir)
    expect(mtime).toBeLessThan(jarTime * 1000 - 1000)   // jar가 아니라 소스 기준
  })

  it('기록이 없으면 재빌드 필요', () => {
    expect(needsRebuild(makeProject(), undefined)).toBe(true)
  })

  it('기록이 소스보다 새로우면 재빌드 불필요, 소스를 다시 만지면 필요', () => {
    const dir = makeProject()
    const rec = { builtAt: Date.now() + 5000, jar: 'x.jar' }
    expect(needsRebuild(dir, rec)).toBe(false)
    const future = Date.now() / 1000 + 60
    utimesSync(join(dir, 'src', 'main', 'App.java'), future, future)
    expect(needsRebuild(dir, rec)).toBe(true)
  })

  it('cache.json 저장/로드 라운드트립', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-bc-')), 'cache.json')
    saveCache({ eis: { builtAt: 123, jar: 'a.jar' } }, file)
    expect(loadCache(file)).toEqual({ eis: { builtAt: 123, jar: 'a.jar' } })
    expect(loadCache(join(tmpdir(), 'no-such-orca-cache.json'))).toEqual({})
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/buildCache.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/buildCache.ts`

```ts
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/buildCache.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: 소스 mtime 기반 jar 빌드 캐시"
```

---

### Task 5: 프로세스 제어 (procctl)

**Files:**
- Create: `src/procctl.ts`
- Test: `test/procctl.test.ts`

**Interfaces:**
- Produces:
  - `spawnService(o: { command: string; args: string[]; cwd: string; priority: Priority; cpus?: number; out: Writable }): Promise<{ pid: number; child: ChildProcess }>` — `windowsHide`, stdout/err을 `out`으로 파이프, `os.setPriority`로 우선순위, `cpus` 있으면 PowerShell 1회성 스폰으로 affinity 마스크 적용
  - `killTree(pid: number): Promise<void>` — `taskkill /PID <pid> /T /F`
  - `isAlive(pid: number): boolean`
  - run.json 레지스트리: `recordStart(name, pid, path?)`, `recordStop(name, path?)`, `findOrphans(path?): { name: string; pid: number }[]`
- Consumes: `Priority` (types.ts), `ORCA_HOME` (config.ts)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/procctl.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { spawnService, killTree, isAlive, recordStart, recordStop, findOrphans } from '../src/procctl.js'
import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('procctl', () => {
  it('프로세스를 낮은 우선순위로 띄우고 트리째 죽인다', async () => {
    const out = new PassThrough()
    // 자식이 손자를 낳는 스크립트: killTree가 손자까지 정리해야 한다
    const script = "const { spawn } = require('node:child_process');" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);" +
      "console.log('CHILD:' + c.pid); setInterval(()=>{},1000)"
    const { pid } = await spawnService({
      command: process.execPath, args: ['-e', script],
      cwd: process.cwd(), priority: 'belowNormal', out,
    })
    expect(isAlive(pid)).toBe(true)

    // 손자 pid 수집
    let buf = ''
    out.on('data', d => { buf += String(d) })
    await sleep(1500)
    const grandchild = Number(buf.match(/CHILD:(\d+)/)?.[1])
    expect(grandchild).toBeGreaterThan(0)

    // 우선순위 확인 (PowerShell 1회성 — 테스트에서만)
    const cls = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PriorityClass`], { encoding: 'utf8' }).trim()
    expect(cls).toBe('BelowNormal')

    await killTree(pid)
    await sleep(500)
    expect(isAlive(pid)).toBe(false)
    expect(isAlive(grandchild)).toBe(false)
  }, 20000)

  it('run.json에 시작/중지를 기록하고 고아를 찾는다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    recordStart('svc-a', process.pid, file)      // 살아있는 pid
    recordStart('svc-b', 4000000, file)          // 존재하지 않는 pid
    expect(findOrphans(file)).toEqual([{ name: 'svc-a', pid: process.pid }])
    recordStop('svc-a', file)
    expect(findOrphans(file)).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/procctl.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/procctl.ts`

```ts
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Writable } from 'node:stream'
import type { Priority } from './types.js'
import { ORCA_HOME } from './config.js'

const run = promisify(execFile)
const RUN_PATH = join(ORCA_HOME, 'run.json')

const PRIO: Record<Priority, number> = {
  normal: os.constants.priority.PRIORITY_NORMAL,
  belowNormal: os.constants.priority.PRIORITY_BELOW_NORMAL,
  idle: os.constants.priority.PRIORITY_LOW,
}

export async function spawnService(o: {
  command: string; args: string[]; cwd: string
  priority: Priority; cpus?: number; out: Writable
}): Promise<{ pid: number; child: ChildProcess }> {
  const child = spawn(o.command, o.args, { cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid === undefined) throw new Error(`프로세스 시작 실패: ${o.command}`)
  child.stdout!.pipe(o.out, { end: false })
  child.stderr!.pipe(o.out, { end: false })
  try { os.setPriority(child.pid, PRIO[o.priority]) } catch { /* 이미 종료된 경우 */ }
  if (o.cpus && o.cpus > 0 && o.cpus < os.cpus().length) {
    const mask = (1 << o.cpus) - 1
    // 시작 시점 1회성 스폰 (Global Constraints에서 허용)
    run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).ProcessorAffinity=[IntPtr]${mask}`], { windowsHide: true }).catch(() => {})
  }
  return { pid: child.pid, child }
}

export async function killTree(pid: number): Promise<void> {
  try { await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* 이미 종료 */ }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readRun(path: string): Record<string, number> {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}
function writeRun(r: Record<string, number>, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(r, null, 2))
}

export function recordStart(name: string, pid: number, path = RUN_PATH): void {
  const r = readRun(path); r[name] = pid; writeRun(r, path)
}
export function recordStop(name: string, path = RUN_PATH): void {
  const r = readRun(path); delete r[name]; writeRun(r, path)
}
/** run.json에 남아 있고 실제로 살아 있는 프로세스 (이전 세션의 잔재) */
export function findOrphans(path = RUN_PATH): { name: string; pid: number }[] {
  return Object.entries(readRun(path))
    .filter(([, pid]) => isAlive(pid))
    .map(([name, pid]) => ({ name, pid }))
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/procctl.test.ts`
Expected: PASS (2 passed). 트리킬 테스트가 타임아웃이면 sleep 대기값을 늘려본다.

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: 프로세스 spawn/우선순위/affinity/트리킬 및 run.json 레지스트리"
```

---

### Task 6: 로그 기록 (logs)

**Files:**
- Create: `src/logs.ts`
- Test: `test/logs.test.ts`

**Interfaces:**
- Produces: `class LogWriter { constructor(file: string, maxBytes?: number); stream(): Writable; close(): void }` — append 모드, 생성 시 기존 파일이 maxBytes 초과면 `<file>.1`로 교체 롤링(1회). `tailLines(file: string, n: number): string[]` — 마지막 n줄 (최대 256KB만 읽음). `logPathFor(name: string): string` — `~\.orca\logs\<name>.log`
- Consumes: `ORCA_HOME` (config.ts)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/logs.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { LogWriter, tailLines } from '../src/logs.js'
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = () => mkdtempSync(join(tmpdir(), 'orca-log-'))

describe('logs', () => {
  it('스트림으로 쓰고 tail로 읽는다', async () => {
    const file = join(dir(), 'a.log')
    const w = new LogWriter(file)
    w.stream().write('line1\nline2\nline3\n')
    await new Promise(r => setTimeout(r, 100))
    w.close()
    expect(tailLines(file, 2)).toEqual(['line2', 'line3'])
  })

  it('maxBytes 초과 파일은 생성 시 .1로 롤링된다', () => {
    const file = join(dir(), 'b.log')
    writeFileSync(file, 'x'.repeat(100))
    const w = new LogWriter(file, 50)
    w.close()
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(statSync(file).size).toBe(0)
  })

  it('없는 파일 tail은 빈 배열', () => {
    expect(tailLines(join(dir(), 'none.log'), 5)).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/logs.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/logs.ts`

```ts
import { createWriteStream, statSync, renameSync, rmSync, readSync, openSync, closeSync, mkdirSync, type WriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Writable } from 'node:stream'
import { ORCA_HOME } from './config.js'

const MAX_BYTES = 10 * 1024 * 1024
const TAIL_READ = 256 * 1024

export function logPathFor(name: string): string {
  return join(ORCA_HOME, 'logs', `${name}.log`)
}

export class LogWriter {
  private ws: WriteStream
  constructor(file: string, maxBytes = MAX_BYTES) {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > maxBytes) {
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      }
    } catch { /* 파일 없음 */ }
    this.ws = createWriteStream(file, { flags: 'a' })
  }
  stream(): Writable { return this.ws }
  close(): void { this.ws.end() }
}

export function tailLines(file: string, n: number): string[] {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return [] }
  try {
    const size = statSync(file).size
    const len = Math.min(size, TAIL_READ)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split(/\r?\n/).filter(l => l.length > 0)
    return lines.slice(-n)
  } finally { closeSync(fd) }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/logs.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: 롤링 로그 기록 및 tail 읽기"
```

---

### Task 7: 헬스체크 (health) + 더미 서버 픽스처

**Files:**
- Create: `src/health.ts`, `test/fixtures/dummy-server.mjs`
- Test: `test/health.test.ts`

**Interfaces:**
- Produces:
  - `httpUp(url: string, timeoutMs?: number): Promise<boolean>` — 2xx면 true, 타임아웃 기본 2000ms, 실패 시 false (throw 금지)
  - `portListening(port: number, timeoutMs?: number): Promise<boolean>` — localhost TCP 연결 성공 여부
  - `test/fixtures/dummy-server.mjs` — `node dummy-server.mjs <port>`로 실행, `/health`에 200 응답. Task 9·15의 통합 테스트도 이 픽스처를 쓴다.
- Consumes: 없음 (Node 20 내장 fetch, node:net)

- [ ] **Step 1: 더미 서버 픽스처 작성** — `test/fixtures/dummy-server.mjs`

```js
// 사용: node dummy-server.mjs <port>  — 1초 내에 뜨는 더미 HTTP 서버
import { createServer } from 'node:http'
const port = Number(process.argv[2])
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('OK') }
  else { res.writeHead(404); res.end() }
}).listen(port, () => console.log(`dummy listening ${port}`))
```

- [ ] **Step 2: 실패하는 테스트 작성** — `test/health.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { httpUp, portListening } from '../src/health.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const PORT = 45810
let child: ChildProcess

beforeAll(async () => {
  child = spawn(process.execPath, [FIXTURE, String(PORT)], { windowsHide: true })
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
})
afterAll(() => { child.kill() })

describe('health', () => {
  it('떠 있는 서버의 /health는 true', async () => {
    expect(await httpUp(`http://localhost:${PORT}/health`)).toBe(true)
  })
  it('404 경로는 false', async () => {
    expect(await httpUp(`http://localhost:${PORT}/nope`)).toBe(false)
  })
  it('닫힌 포트는 false (throw하지 않음)', async () => {
    expect(await httpUp('http://localhost:1/health', 500)).toBe(false)
  })
  it('portListening: 리슨 중 true / 닫힌 포트 false', async () => {
    expect(await portListening(PORT)).toBe(true)
    expect(await portListening(1)).toBe(false)
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm test test/health.test.ts`
Expected: FAIL — `src/health.js` 없음

- [ ] **Step 4: 구현** — `src/health.ts`

```ts
import net from 'node:net'

export async function httpUp(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch { return false }
}

export function portListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm test test/health.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 6: 커밋**

```powershell
git add -A; git commit -m "feat: HTTP/포트 헬스체크 및 더미 서버 픽스처"
```

---

### Task 8: spring 프리셋 (spring)

**Files:**
- Create: `src/spring.ts`
- Test: `test/spring.test.ts`

**Interfaces:**
- Produces:
  - `javaArgs(def: ServiceDef, jar: string): string[]` — `['-Xmx<heapMb>m','-XX:MaxMetaspaceSize=256m','-XX:ActiveProcessorCount=<cpus>','-XX:+UseSerialGC', ...def.jvmArgs, '-jar', jar]`
  - `findBootJar(dir: string, module?: string): string` — `<dir>[\<module>]\build\libs`에서 `-plain.jar` 제외 최신 `.jar`, 없으면 throw
  - `buildJar(def: ServiceDef, out: Writable): Promise<string>` — `<dir>\gradlew.bat <target> -x test` 실행(target은 module 있으면 `:<module>:bootJar` 없으면 `bootJar`), 출력은 `out`으로, 종료코드≠0이면 `Error('빌드 실패: <name> — 로그를 확인하세요')` throw. 성공 시 jar 경로 반환.
  - `gradleStop(dir: string): Promise<void>` — `gradlew.bat --stop`, 실패 무시
- Consumes: `ServiceDef` (types.ts)

- [ ] **Step 1: 실패하는 테스트 작성** — `test/spring.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { javaArgs, findBootJar } from '../src/spring.js'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServiceDef } from '../src/types.js'

const def: ServiceDef = {
  name: 'eis', kind: 'spring', dir: 'C:\\work\\eis', port: 8081,
  heapMb: 512, cpus: 2, priority: 'belowNormal', jvmArgs: ['-Dspring.profiles.active=local'],
}

describe('spring', () => {
  it('javaArgs가 자원 제한 플래그를 만든다', () => {
    expect(javaArgs(def, 'C:\\x\\app.jar')).toEqual([
      '-Xmx512m', '-XX:MaxMetaspaceSize=256m', '-XX:ActiveProcessorCount=2',
      '-XX:+UseSerialGC', '-Dspring.profiles.active=local', '-jar', 'C:\\x\\app.jar',
    ])
  })

  it('findBootJar: -plain 제외 최신 jar를 고른다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sp-'))
    const libs = join(dir, 'eis-server', 'build', 'libs')
    mkdirSync(libs, { recursive: true })
    writeFileSync(join(libs, 'eis-0.1.jar'), 'old')
    writeFileSync(join(libs, 'eis-0.2.jar'), 'new')
    writeFileSync(join(libs, 'eis-0.2-plain.jar'), 'plain')
    const old = Date.now() / 1000 - 100
    utimesSync(join(libs, 'eis-0.1.jar'), old, old)
    expect(findBootJar(dir, 'eis-server')).toBe(join(libs, 'eis-0.2.jar'))
  })

  it('findBootJar: jar 없으면 throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sp-'))
    expect(() => findBootJar(dir)).toThrowError(/jar/)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/spring.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/spring.ts`

```ts
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import type { ServiceDef } from './types.js'

export function javaArgs(def: ServiceDef, jar: string): string[] {
  return [
    `-Xmx${def.heapMb}m`,
    '-XX:MaxMetaspaceSize=256m',
    `-XX:ActiveProcessorCount=${def.cpus}`,
    '-XX:+UseSerialGC',
    ...def.jvmArgs,
    '-jar', jar,
  ]
}

export function findBootJar(dir: string, module?: string): string {
  const libs = module ? join(dir, module, 'build', 'libs') : join(dir, 'build', 'libs')
  let files: string[] = []
  try { files = readdirSync(libs) } catch { /* 폴더 없음 → 아래에서 throw */ }
  const jars = files.filter(f => f.endsWith('.jar') && !f.endsWith('-plain.jar'))
  if (jars.length === 0) throw new Error(`jar를 찾을 수 없습니다: ${libs} — 빌드가 실행됐는지 확인`)
  jars.sort((a, b) => statSync(join(libs, b)).mtimeMs - statSync(join(libs, a)).mtimeMs)
  return join(libs, jars[0])
}

function runGradle(dir: string, args: string[], out?: Writable): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(dir, 'gradlew.bat'), args, { cwd: dir, windowsHide: true, shell: true })
    if (out) { child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false }) }
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

export async function buildJar(def: ServiceDef, out: Writable): Promise<string> {
  const target = def.module ? `:${def.module}:bootJar` : 'bootJar'
  const code = await runGradle(def.dir, [target, '-x', 'test'], out)
  if (code !== 0) throw new Error(`빌드 실패: ${def.name} — 로그를 확인하세요`)
  return findBootJar(def.dir, def.module)
}

export async function gradleStop(dir: string): Promise<void> {
  try { await runGradle(dir, ['--stop']) } catch { /* 데몬 없음 등은 무시 */ }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/spring.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: spring 프리셋 - bootJar 빌드, jar 탐색, 자원 제한 java 인자"
```

---

### Task 9: 수퍼바이저 (supervisor)

**Files:**
- Create: `src/supervisor.ts`
- Test: `test/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 2~8 전부 — `loadCache/saveCache/needsRebuild`, `whoHoldsPort`, `spawnService/killTree/recordStart/recordStop`, `LogWriter/logPathFor`, `httpUp/portListening`, `javaArgs/findBootJar/buildJar/gradleStop`
- Produces:
  - `class Supervisor extends EventEmitter` — 생성자 `(cfg: Config, opts?: { logDir?: string })`. `logDir` 지정 시 로그를 그 밑에 씀(테스트용), 기본은 `logPathFor`.
  - `states(): ServiceState[]` (설정 순서 유지), `start(name): Promise<void>`, `stop(name): Promise<void>`, `startAll(): Promise<void>`, `stopAll(): Promise<void>`, `pids(): Map<string, number>`
  - 상태 변화마다 `emit('change')`. 절대 throw로 죽지 않고 실패는 해당 서비스의 `status: 'ERROR'` + `error` 메시지로 기록.
- 동작 규칙:
  - `start`: (spring & needsRebuild → BUILDING·buildJar·캐시 갱신) → 포트 점유 검사(점유 시 ERROR, `error`에 pid/exe) → spawn(STARTING) → 1초 간격 헬스 폴링(health URL 있으면 httpUp, 없으면 portListening, 최대 120초) → UP. 프로세스 exit 시: stop으로 죽였으면 DOWN, 아니면 CRASHED.
  - `startAll`: **순차** 실행(빌드 CPU 폭주 방지 — 절약이 목적). 끝나면 spring 서비스들의 고유 dir마다 `gradleStop` 1회 (스펙: 데몬 잔류 방지).
  - `stopAll`: 모든 실행 중 서비스 `killTree` + recordStop.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/supervisor.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { Supervisor } from '../src/supervisor.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { Config } from '../src/types.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')

function cfg(port1: number, port2: number): Config {
  const base = { kind: 'command' as const, dir: process.cwd(), heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
  return {
    services: [
      { ...base, name: 'dummy-a', run: `node "${FIXTURE}" ${port1}`, port: port1, health: `http://localhost:${port1}/health` },
      { ...base, name: 'dummy-b', run: `node "${FIXTURE}" ${port2}`, port: port2 },   // health 없음 → 포트 판정
    ],
  }
}

let sup: Supervisor
afterEach(async () => { await sup?.stopAll() })

describe('supervisor', () => {
  it('startAll로 전부 UP, stopAll로 전부 DOWN', async () => {
    sup = new Supervisor(cfg(45821, 45822), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.startAll()
    expect(sup.states().map(s => s.status)).toEqual(['UP', 'UP'])
    await sup.stopAll()
    expect(sup.states().map(s => s.status)).toEqual(['DOWN', 'DOWN'])
  }, 30000)

  it('포트가 점유돼 있으면 ERROR + 점유자 정보', async () => {
    const blocker: Server = createServer(() => {})
    await new Promise<void>(r => blocker.listen(45823, () => r()))
    sup = new Supervisor(cfg(45823, 45824), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const st = sup.states()[0]
    expect(st.status).toBe('ERROR')
    expect(st.error).toMatch(/포트/)
    expect(st.error).toMatch(String(process.pid))
    blocker.close()
  }, 15000)

  it('외부에서 죽으면 CRASHED로 표시된다', async () => {
    sup = new Supervisor(cfg(45825, 45826), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const pid = sup.pids().get('dummy-a')!
    process.kill(pid)
    await new Promise(r => setTimeout(r, 1500))
    expect(sup.states()[0].status).toBe('CRASHED')
  }, 15000)
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/supervisor.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/supervisor.ts`

```ts
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Config, ServiceDef, ServiceState } from './types.js'
import { whoHoldsPort } from './ports.js'
import { loadCache, saveCache, needsRebuild } from './buildCache.js'
import { spawnService, killTree, recordStart, recordStop } from './procctl.js'
import { LogWriter, logPathFor } from './logs.js'
import { httpUp, portListening } from './health.js'
import { buildJar, findBootJar, javaArgs, gradleStop } from './spring.js'

const HEALTH_INTERVAL = 1000
const HEALTH_TIMEOUT = 120_000

interface Entry {
  state: ServiceState
  child?: ChildProcess
  log?: LogWriter
  stopping: boolean
}

export class Supervisor extends EventEmitter {
  private entries = new Map<string, Entry>()
  private logDir?: string

  constructor(cfg: Config, opts?: { logDir?: string }) {
    super()
    this.logDir = opts?.logDir
    for (const def of cfg.services) {
      this.entries.set(def.name, { state: { def, status: 'DOWN' }, stopping: false })
    }
  }

  states(): ServiceState[] { return [...this.entries.values()].map(e => e.state) }
  pids(): Map<string, number> {
    const m = new Map<string, number>()
    for (const [n, e] of this.entries) if (e.state.pid && e.state.status !== 'DOWN') m.set(n, e.state.pid)
    return m
  }

  private set(e: Entry, patch: Partial<ServiceState>): void {
    Object.assign(e.state, patch)
    this.emit('change')
  }
  private logFile(name: string): string {
    return this.logDir ? join(this.logDir, `${name}.log`) : logPathFor(name)
  }

  async start(name: string): Promise<void> {
    const e = this.entries.get(name)
    if (!e || e.state.status === 'UP' || e.state.status === 'STARTING' || e.state.status === 'BUILDING') return
    const def = e.state.def
    e.stopping = false
    e.log = new LogWriter(this.logFile(name))
    try {
      let command: string, args: string[]
      if (def.kind === 'spring') {
        const cache = loadCache()
        if (needsRebuild(def.dir, cache[name])) {
          this.set(e, { status: 'BUILDING', error: undefined })
          const jar = await buildJar(def, e.log.stream())
          cache[name] = { builtAt: Date.now(), jar }
          saveCache(cache)
        }
        const jar = cache[name]?.jar ?? findBootJar(def.dir, def.module)
        command = 'java'; args = javaArgs(def, jar)
      } else {
        command = 'cmd'; args = ['/c', def.run!]
      }

      const holder = await whoHoldsPort(def.port)
      if (holder) {
        this.set(e, { status: 'ERROR', error: `포트 ${def.port} 점유 중: ${holder.exe} (PID ${holder.pid})` })
        return
      }

      const { pid, child } = await spawnService({
        command, args, cwd: def.dir, priority: def.priority,
        cpus: def.kind === 'command' && def.cpus > 0 ? def.cpus : undefined, out: e.log.stream(),
      })
      e.child = child
      recordStart(name, pid)
      this.set(e, { status: 'STARTING', pid, error: undefined })

      child.once('exit', () => {
        recordStop(name)
        e.log?.close()
        this.set(e, e.stopping ? { status: 'DOWN', pid: undefined } : { status: 'CRASHED' })
      })

      const deadline = Date.now() + HEALTH_TIMEOUT
      while (Date.now() < deadline && e.state.status === 'STARTING') {
        const up = def.health ? await httpUp(def.health) : await portListening(def.port)
        if (up) { this.set(e, { status: 'UP' }); return }
        await new Promise(r => setTimeout(r, HEALTH_INTERVAL))
      }
      if (e.state.status === 'STARTING') {
        this.set(e, { status: 'ERROR', error: `${HEALTH_TIMEOUT / 1000}초 내에 헬스체크를 통과하지 못했습니다` })
      }
    } catch (err) {
      e.log?.close()
      this.set(e, { status: 'ERROR', error: (err as Error).message })
    }
  }

  async stop(name: string): Promise<void> {
    const e = this.entries.get(name)
    if (!e || !e.state.pid || e.state.status === 'DOWN') return
    e.stopping = true
    await killTree(e.state.pid)
  }

  async startAll(): Promise<void> {
    // 순차 시작: 동시 빌드로 CPU를 폭주시키지 않는다 (절약이 목적)
    for (const name of this.entries.keys()) await this.start(name)
    const springDirs = new Set(
      [...this.entries.values()].filter(e => e.state.def.kind === 'spring').map(e => e.state.def.dir),
    )
    for (const dir of springDirs) await gradleStop(dir)   // 스펙: 데몬 잔류 방지
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(n => this.stop(n)))
    // exit 이벤트가 DOWN으로 바꿀 때까지 잠깐 대기
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && [...this.entries.values()].some(e => e.stopping && e.state.status !== 'DOWN')) {
      await new Promise(r => setTimeout(r, 100))
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/supervisor.test.ts`
Expected: PASS (3 passed). 전체 스위트도 확인: `pnpm test` → 모두 PASS

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: 서비스 상태머신 수퍼바이저 (빌드-포트검사-기동-헬스판정)"
```

---

### Task 10: 자원 수집 (stats + sysinfo)

**Files:**
- Create: `assets/stats-helper.ps1`, `src/stats.ts`, `src/sysinfo.ts`
- Test: `test/stats.test.ts`

**Interfaces:**
- Produces:
  - `class StatsCollector { start(): void; stop(): void; helperPid(): number | undefined; sample(pids: (number | undefined)[]): Promise<Map<number, ProcStat>> }` — undefined 항목은 무시(호출부가 `helperPid()`를 그대로 넘길 수 있게), `interface ProcStat { pid: number; cpuPercent: number; rssBytes: number }` — **장수명 PowerShell 헬퍼 1개**와 stdin/stdout 요청-응답. `sample()` 호출 없으면 헬퍼는 유휴(자체 타이머 없음). cpuPercent는 두 샘플 간 CPU시간 차이를 전체 코어 수로 정규화.
  - `sampleSystem(): { cpuPercent: number; usedBytes: number; totalBytes: number }` (sysinfo.ts) — `os.cpus()` 틱 델타, 프로세스 스폰 없음. 첫 호출은 cpuPercent 0.
- Consumes: 없음
- 제약: Global Constraints의 "폴링마다 프로세스 스폰 금지"가 이 태스크의 핵심. 헬퍼는 `start()`에서 한 번만 스폰된다.

- [ ] **Step 1: 헬퍼 스크립트 작성** — `assets/stats-helper.ps1`

```powershell
# stdin으로 "pid,pid,..." 한 줄을 받으면 각 프로세스의 누적 CPU시간(ms)/RSS를 JSON 한 줄로 응답.
# 자체 타이머 없음 — 러너가 캐던스를 소유한다. 'exit' 또는 EOF로 종료.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  $result = @()
  foreach ($token in ($line -split ',')) {
    if ($token -match '^\d+$') {
      try {
        $p = Get-Process -Id ([int]$token) -ErrorAction Stop
        $result += [pscustomobject]@{ pid = $p.Id; cpuMs = [long]$p.TotalProcessorTime.TotalMilliseconds; rss = [long]$p.WorkingSet64 }
      } catch {}
    }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `test/stats.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { StatsCollector } from '../src/stats.js'
import { sampleSystem } from '../src/sysinfo.js'
import { isAlive } from '../src/procctl.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('stats', () => {
  it('자기 자신의 RSS를 수집하고, 헬퍼는 샘플 간에 재스폰되지 않는다', async () => {
    const c = new StatsCollector()
    c.start()
    const helper1 = c.helperPid()
    const m1 = await c.sample([process.pid])
    expect(m1.get(process.pid)!.rssBytes).toBeGreaterThan(10 * 1024 * 1024)
    await sleep(500)
    const m2 = await c.sample([process.pid])
    expect(m2.get(process.pid)!.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(c.helperPid()).toBe(helper1)          // 장수명 1개 — 재스폰 금지
    const hp = helper1!
    c.stop()
    await sleep(1000)
    expect(isAlive(hp)).toBe(false)              // stop이 헬퍼를 정리
  }, 20000)

  it('죽은 pid는 결과에서 빠진다', async () => {
    const c = new StatsCollector()
    c.start()
    const m = await c.sample([process.pid, 4000000])
    expect(m.has(process.pid)).toBe(true)
    expect(m.has(4000000)).toBe(false)
    c.stop()
  }, 15000)

  it('sampleSystem: 두 번째 호출부터 0~100 사이 CPU%', async () => {
    sampleSystem()
    await sleep(300)
    const s = sampleSystem()
    expect(s.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(s.cpuPercent).toBeLessThanOrEqual(100)
    expect(s.totalBytes).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm test test/stats.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`src/sysinfo.ts`:

```ts
import os from 'node:os'

export interface SysSample { cpuPercent: number; usedBytes: number; totalBytes: number }

let prev: { idle: number; total: number } | undefined

/** os.cpus() 틱 델타로 시스템 전체 CPU% — 프로세스 스폰 없음, 비용 무시 가능 */
export function sampleSystem(): SysSample {
  let idle = 0, total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  let cpuPercent = 0
  if (prev && total > prev.total) cpuPercent = 100 * (1 - (idle - prev.idle) / (total - prev.total))
  prev = { idle, total }
  return { cpuPercent: Math.max(0, cpuPercent), usedBytes: os.totalmem() - os.freemem(), totalBytes: os.totalmem() }
}
```

`src/stats.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export interface ProcStat { pid: number; cpuPercent: number; rssBytes: number }

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'stats-helper.ps1')
const REPLY_TIMEOUT = 2000

export class StatsCollector {
  private child?: ChildProcess
  private rl?: Interface
  private prev = new Map<number, { cpuMs: number; at: number }>()

  start(): void {
    if (this.child) return
    this.child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.rl = createInterface({ input: this.child.stdout! })
    this.child.once('exit', () => { this.child = undefined })
  }

  stop(): void {
    try { this.child?.stdin?.write('exit\n') } catch { /* 이미 닫힘 */ }
    this.child?.kill()
    this.child = undefined
    this.prev.clear()
  }

  helperPid(): number | undefined { return this.child?.pid }

  async sample(pids: (number | undefined)[]): Promise<Map<number, ProcStat>> {
    const out = new Map<number, ProcStat>()
    const list = pids.filter((p): p is number => p !== undefined)
    if (!this.child || !this.rl || list.length === 0) return out
    const reply = new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), REPLY_TIMEOUT)
      this.rl!.once('line', l => { clearTimeout(t); resolve(l) })
    })
    this.child.stdin!.write(list.join(',') + '\n')
    const raw = await reply
    if (raw === null) return out
    let rows: { pid: number; cpuMs: number; rss: number }[] = []
    try { rows = JSON.parse(raw) } catch { return out }
    const now = Date.now()
    const cores = os.cpus().length
    for (const r of rows) {
      const p = this.prev.get(r.pid)
      let cpuPercent = 0
      if (p && now > p.at) cpuPercent = ((r.cpuMs - p.cpuMs) / (now - p.at)) * 100 / cores
      this.prev.set(r.pid, { cpuMs: r.cpuMs, at: now })
      out.set(r.pid, { pid: r.pid, cpuPercent: Math.max(0, cpuPercent), rssBytes: r.rss })
    }
    return out
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm test test/stats.test.ts`
Expected: PASS (3 passed). JSON 파싱 실패가 나면 헬퍼 출력을 직접 확인: `powershell -NoProfile -File assets/stats-helper.ps1` 실행 후 자기 PID를 입력해 한 줄 JSON이 나오는지 본다.

- [ ] **Step 6: 커밋**

```powershell
git add -A; git commit -m "feat: 장수명 PS 헬퍼 기반 배치 자원 수집 및 시스템 CPU/RAM 샘플링"
```

---

### Task 11: TUI 기반 (screen + keys)

**Files:**
- Create: `src/tui/screen.ts`, `src/tui/keys.ts`
- Test: `test/tui.test.ts`

**Interfaces:**
- Produces:
  - `parseKey(b: Buffer): Key`, `type Key = 'up'|'down'|'enter'|'esc'|'s'|'a'|'l'|'m'|'q'|'other'` — Ctrl+C(`\x03`)는 'q'로 매핑
  - `renderDiff(prev: string[], next: string[]): string` — 바뀐 줄만 `ESC[<row>;1H` + `ESC[2K` + 새 내용으로 만든 ANSI 문자열 (순수 함수)
  - `class Screen { enter(): void; exit(): void; render(lines: string[]): void; reset(): void }` — alt buffer(`?1049h`)·커서 숨김·raw mode 진입/복원. `render`는 내부에 이전 프레임을 들고 renderDiff 결과만 stdout에 쓴다. `reset`은 화면 전환 시 전체 클리어.
- Consumes: 없음

- [ ] **Step 1: 실패하는 테스트 작성** — `test/tui.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseKey } from '../src/tui/keys.js'
import { renderDiff } from '../src/tui/screen.js'

describe('keys', () => {
  it('방향키/문자키/Ctrl+C를 파싱한다', () => {
    expect(parseKey(Buffer.from('\x1b[A'))).toBe('up')
    expect(parseKey(Buffer.from('\x1b[B'))).toBe('down')
    expect(parseKey(Buffer.from('\x1b'))).toBe('esc')
    expect(parseKey(Buffer.from('s'))).toBe('s')
    expect(parseKey(Buffer.from('Q'))).toBe('q')
    expect(parseKey(Buffer.from('\x03'))).toBe('q')
    expect(parseKey(Buffer.from('z'))).toBe('other')
  })
})

describe('renderDiff', () => {
  it('바뀐 줄만 커서이동+클리어와 함께 출력한다', () => {
    const out = renderDiff(['a', 'b', 'c'], ['a', 'B', 'c'])
    expect(out).toBe('\x1b[2;1H\x1b[2KB')
  })
  it('줄이 늘어나면 새 줄을, 줄어들면 빈 줄을 그린다', () => {
    expect(renderDiff(['a'], ['a', 'b'])).toBe('\x1b[2;1H\x1b[2Kb')
    expect(renderDiff(['a', 'b'], ['a'])).toBe('\x1b[2;1H\x1b[2K')
  })
  it('동일 프레임은 빈 문자열', () => {
    expect(renderDiff(['a'], ['a'])).toBe('')
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/tui.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/tui/keys.ts`:

```ts
export type Key = 'up' | 'down' | 'enter' | 'esc' | 's' | 'a' | 'l' | 'm' | 'q' | 'other'

export function parseKey(b: Buffer): Key {
  const s = b.toString('utf8')
  if (s === '\x1b[A') return 'up'
  if (s === '\x1b[B') return 'down'
  if (s === '\r') return 'enter'
  if (s === '\x1b') return 'esc'
  if (s === '\x03') return 'q'   // Ctrl+C도 정상 종료 경로로
  const c = s.toLowerCase()
  if (c === 's' || c === 'a' || c === 'l' || c === 'm' || c === 'q') return c
  return 'other'
}
```

`src/tui/screen.ts`:

```ts
export function renderDiff(prev: string[], next: string[]): string {
  let out = ''
  const rows = Math.max(prev.length, next.length)
  for (let i = 0; i < rows; i++) {
    if (prev[i] === next[i]) continue
    out += `\x1b[${i + 1};1H\x1b[2K` + (next[i] ?? '')
  }
  return out
}

export class Screen {
  private prev: string[] = []
  enter(): void {
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J')
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
  }
  exit(): void {
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    process.stdout.write('\x1b[?25h\x1b[?1049l')
  }
  render(lines: string[]): void {
    const out = renderDiff(this.prev, lines)
    if (out) process.stdout.write(out)
    this.prev = [...lines]
  }
  reset(): void {
    this.prev = []
    process.stdout.write('\x1b[2J')
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/tui.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: 커밋**

```powershell
git add -A; git commit -m "feat: ANSI diff 렌더러와 키 입력 파서"
```

---

### Task 12: 대시보드 조립 (dashboard + logView + app + cli)

**Files:**
- Create: `src/tui/dashboard.ts`, `src/tui/logView.ts`, `src/app.ts`
- Modify: `src/cli.ts` (전면 교체)
- Test: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: `Supervisor`(9), `StatsCollector`(10), `sampleSystem`(10), `Screen/parseKey`(11), `tailLines/logPathFor`(6), `findOrphans/killTree`(5), `loadConfig/ConfigError`(2)
- Produces:
  - `dashboardLines(states: ServiceState[], sys: SysSample, sel: number, statsOn: boolean, width?: number): string[]` (순수)
  - `fmtBytes(n?: number): string` — GB는 소수 1자리, MB는 정수, undefined는 `-`
  - `logViewLines(name: string, file: string, rows: number, offset: number, width?: number): string[]` (순수 — tailLines만 IO)
  - `runApp(cfg: Config): Promise<void>` — 고아 정리 프롬프트 → TUI 루프. 3초 tick에서 stats 배치 샘플+redraw, supervisor 'change'마다 redraw
  - `cli.ts`: `#!/usr/bin/env node` 셔뱅으로 시작(tsc가 보존, npm 전역 설치 시 필요). `--version` | `<그룹>` 인자 → 그룹 필터 대시보드 | 인자 없음 → 전체 대시보드. `add`/`setup` 분기는 Task 13/14에서 추가.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/dashboard.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { dashboardLines, fmtBytes } from '../src/tui/dashboard.js'
import type { ServiceState } from '../src/types.js'

const st = (over: Partial<ServiceState['def']> & { status: ServiceState['status']; rssBytes?: number; error?: string }): ServiceState => ({
  def: { name: over.name ?? 'svc', kind: 'command', dir: 'C:\\x', port: over.port ?? 8080, heapMb: 0, cpus: 0, priority: 'normal', jvmArgs: [], run: 'r' },
  status: over.status, rssBytes: over.rssBytes, error: over.error,
})

describe('dashboard', () => {
  it('fmtBytes 단위 변환', () => {
    expect(fmtBytes(undefined)).toBe('-')
    expect(fmtBytes(500 * 1024 * 1024)).toBe('500MB')
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe('1.5GB')
  })

  it('상태·포트·선택 표시가 들어간다', () => {
    const lines = dashboardLines(
      [st({ name: 'eis', status: 'UP', rssBytes: 480 * 1024 ** 2, port: 8081 }), st({ name: 'gw', status: 'DOWN', port: 9000 })],
      { cpuPercent: 41, usedBytes: 18 * 1024 ** 3, totalBytes: 63 * 1024 ** 3 },
      1, true,
    )
    expect(lines[0]).toContain('CPU 41%')
    const eisRow = lines.find(l => l.includes('eis'))!
    expect(eisRow).toContain('UP')
    expect(eisRow).toContain('8081')
    expect(eisRow).toContain('480MB')
    const gwRow = lines.find(l => l.includes('gw'))!
    expect(gwRow.startsWith('>')).toBe(true)      // sel=1 표시
  })

  it('ERROR 상태는 error 메시지를 노출한다', () => {
    const lines = dashboardLines([st({ name: 'bad', status: 'ERROR', error: '포트 8080 점유 중: java.exe (PID 7)' })],
      { cpuPercent: 0, usedBytes: 0, totalBytes: 1 }, 0, false)
    expect(lines.find(l => l.includes('bad'))).toContain('포트 8080 점유 중')
  })

  it('수집 꺼짐이면 헤더에 표시된다', () => {
    const lines = dashboardLines([], { cpuPercent: 0, usedBytes: 0, totalBytes: 1 }, 0, false)
    expect(lines[0]).toContain('수집 꺼짐')
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/dashboard.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/tui/dashboard.ts`:

```ts
import type { ServiceState } from '../types.js'
import type { SysSample } from '../sysinfo.js'

const ICON: Record<string, string> = { UP: '●', STARTING: '◐', BUILDING: '◔', DOWN: '○', CRASHED: '✖', ERROR: '✖' }

export function fmtBytes(n?: number): string {
  if (n === undefined) return '-'
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB'
  return Math.round(n / 1024 ** 2) + 'MB'
}

export function dashboardLines(states: ServiceState[], sys: SysSample, sel: number, statsOn: boolean, width = 100): string[] {
  const head = ` ORCA RUNNER   CPU ${sys.cpuPercent.toFixed(0)}%  RAM ${fmtBytes(sys.usedBytes)}/${fmtBytes(sys.totalBytes)}${statsOn ? '' : '  [수집 꺼짐]'}`
  const sep = ' ' + '─'.repeat(Math.max(10, width - 2))
  const rows = states.map((s, i) => {
    const cur = i === sel ? '>' : ' '
    const name = s.def.name.padEnd(16).slice(0, 16)
    const port = String(s.def.port).padStart(5)
    const status = s.status.padEnd(9)
    const mem = statsOn ? fmtBytes(s.rssBytes).padStart(8) : ''
    const cpu = statsOn && s.cpuPercent !== undefined ? (s.cpuPercent.toFixed(0) + '%').padStart(5) : ''
    const err = s.error ? '  ' + s.error : ''
    return `${cur}${ICON[s.status] ?? '?'} ${name} :${port} ${status}${mem}${cpu}${err}`.slice(0, width)
  })
  const help = ' [↑↓]선택 [s]시작/중지 [a]전체시작 [l]로그 [m]수집 [q]종료'
  return [head, sep, ...rows, sep, help]
}
```

`src/tui/logView.ts`:

```ts
import { tailLines } from '../logs.js'

export function logViewLines(name: string, file: string, rows: number, offset: number, width = 160): string[] {
  const all = tailLines(file, 500)
  const end = Math.max(0, all.length - offset)
  const start = Math.max(0, end - (rows - 1))
  const view = all.slice(start, end).map(l => l.slice(0, width))
  return [` LOG: ${name}  (↑↓ 스크롤, Esc 복귀)`, ...view]
}
```

`src/app.ts`:

```ts
import { createInterface } from 'node:readline/promises'
import { Supervisor } from './supervisor.js'
import { StatsCollector } from './stats.js'
import { sampleSystem } from './sysinfo.js'
import { Screen } from './tui/screen.js'
import { parseKey } from './tui/keys.js'
import { dashboardLines } from './tui/dashboard.js'
import { logViewLines } from './tui/logView.js'
import { logPathFor } from './logs.js'
import { findOrphans, killTree } from './procctl.js'
import type { Config } from './types.js'

export async function runApp(cfg: Config): Promise<void> {
  // 이전 세션의 고아 프로세스 정리 (TUI 진입 전 일반 콘솔에서)
  const orphans = findOrphans()
  if (orphans.length > 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('이전 세션이 남긴 프로세스가 있습니다:')
    for (const o of orphans) console.log(`  - ${o.name} (PID ${o.pid})`)
    const ans = await rl.question('정리할까요? [y/N] ')
    rl.close()
    if (ans.trim().toLowerCase() === 'y') for (const o of orphans) await killTree(o.pid)
  }

  const sup = new Supervisor(cfg)
  const stats = new StatsCollector()
  const screen = new Screen()
  let statsOn = true
  let sel = 0
  let view: 'dash' | 'log' = 'dash'
  let logOffset = 0
  stats.start()

  const draw = () => {
    const states = sup.states()
    const width = process.stdout.columns || 100
    if (view === 'dash') {
      screen.render(dashboardLines(states, sampleSystem(), sel, statsOn, width))
    } else {
      const name = states[sel].def.name
      screen.render(logViewLines(name, logPathFor(name), process.stdout.rows || 30, logOffset, width))
    }
  }

  sup.on('change', draw)

  const tick = setInterval(async () => {          // 3초 배치 샘플 — 유일한 주기 작업
    if (statsOn) {
      const m = await stats.sample([...sup.pids().values()])
      for (const s of sup.states()) {
        const st = s.pid ? m.get(s.pid) : undefined
        s.cpuPercent = st?.cpuPercent
        s.rssBytes = st?.rssBytes
      }
    }
    draw()
  }, 3000)

  const quit = async () => {
    clearInterval(tick)
    stats.stop()
    screen.exit()
    console.log('서비스를 정리하는 중...')
    await sup.stopAll()
    process.exit(0)
  }
  process.on('SIGINT', () => { void quit() })

  screen.enter()
  draw()
  process.stdin.on('data', (b: Buffer) => {
    const k = parseKey(b)
    const n = sup.states().length
    if (view === 'log') {
      if (k === 'esc' || k === 'l') { view = 'dash'; screen.reset() }
      else if (k === 'up') logOffset++
      else if (k === 'down') logOffset = Math.max(0, logOffset - 1)
      else if (k === 'q') { void quit(); return }
      draw()
      return
    }
    switch (k) {
      case 'up': sel = (sel + n - 1) % n; break
      case 'down': sel = (sel + 1) % n; break
      case 's': {
        const s = sup.states()[sel]
        if (s.status === 'UP' || s.status === 'STARTING' || s.status === 'BUILDING') void sup.stop(s.def.name)
        else void sup.start(s.def.name)
        break
      }
      case 'a': void sup.startAll(); break
      case 'l': view = 'log'; logOffset = 0; screen.reset(); break
      case 'm':
        statsOn = !statsOn
        if (statsOn) stats.start(); else stats.stop()
        for (const s of sup.states()) { s.cpuPercent = undefined; s.rssBytes = undefined }
        break
      case 'q': void quit(); return
    }
    draw()
  })
}
```

`src/cli.ts` (전면 교체):

```ts
#!/usr/bin/env node
import { loadConfig, ConfigError } from './config.js'
import { runApp } from './app.js'

export const VERSION = '0.1.0'

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === '--version') { console.log(VERSION); return }
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test`
Expected: 전체 PASS (Task 1의 cli 테스트도 여전히 통과해야 한다 — `--version` 경로 유지 확인)

- [ ] **Step 5: 수동 검증 — 실제 TUI 확인**

`%USERPROFILE%\.orca\services.yaml`을 임시로 만든다 (`<repo>`는 저장소 절대경로로 치환):

```yaml
services:
  demo-a:
    kind: command
    dir: C:\Users\jslim\orca\runner
    run: node "<repo>\test\fixtures\dummy-server.mjs" 46001
    port: 46001
    health: http://localhost:46001/health
  demo-b:
    kind: command
    dir: C:\Users\jslim\orca\runner
    run: node "<repo>\test\fixtures\dummy-server.mjs" 46002
    port: 46002
```

Run: `pnpm dev` — 확인 항목:
1. 대시보드가 뜨고 두 서비스가 DOWN으로 보인다
2. `a` → 순차로 STARTING→UP, 3초 뒤 메모리/CPU 수치 표시
3. `↑↓`로 선택 이동, `s`로 개별 중지→DOWN
4. `l` → 로그 뷰에 dummy 출력, `Esc` 복귀
5. `m` → 헤더에 [수집 꺼짐], 수치 사라짐. 작업관리자에서 powershell 헬퍼가 사라졌는지 확인
6. `q` → 서비스 정리 후 원래 터미널 복귀. 작업관리자에 node dummy가 안 남았는지 확인
7. 대시보드 중 강제로 창을 닫고 다시 `pnpm dev` → 고아 감지 프롬프트 → y로 정리 확인

- [ ] **Step 6: 커밋**

```powershell
git add -A; git commit -m "feat: TUI 대시보드/로그 뷰와 CLI 연결"
```

---

### Task 13: 대화형 등록 (orca add)

**Files:**
- Create: `src/add.ts`
- Modify: `src/cli.ts` (add 분기 추가)
- Test: `test/add.test.ts`

**Interfaces:**
- Consumes: `loadConfigFromString`(2 — 검증용), `CONFIG_PATH/ORCA_HOME`(2)
- Produces:
  - `appendService(src: string, s: NewService): string` (순수) — 기존 YAML 텍스트에 서비스 추가, **주석 보존**(yaml 라이브러리 Document API 사용), 중복 이름이면 throw. `interface NewService { name: string; group?: string; kind: 'spring'|'command'; dir: string; module?: string; run?: string; port: number; health?: string }`
  - `runAdd(): Promise<void>` — readline 대화형으로 필드를 물어 `CONFIG_PATH`에 반영. 쓰기 전에 결과 전체를 `loadConfigFromString`으로 검증해 깨진 설정이 저장되는 것을 막는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/add.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { appendService } from '../src/add.js'
import { loadConfigFromString } from '../src/config.js'

describe('appendService', () => {
  it('빈 파일에서 유효한 설정을 만든다', () => {
    const out = appendService('', { name: 'eis', kind: 'spring', dir: 'C:\\work\\eis', port: 8081 })
    const cfg = loadConfigFromString(out)
    expect(cfg.services[0].name).toBe('eis')
    expect(cfg.services[0].heapMb).toBe(512)
  })

  it('기존 서비스와 주석을 보존한다', () => {
    const src = '# 내 서비스들\nservices:\n  gw:\n    kind: command\n    dir: C:\\gw\n    run: r.cmd\n    port: 9000\n'
    const out = appendService(src, { name: 'eis', kind: 'spring', dir: 'C:\\eis', port: 8081, group: 'tspay' })
    expect(out).toContain('# 내 서비스들')
    const cfg = loadConfigFromString(out)
    expect(cfg.services.map(s => s.name).sort()).toEqual(['eis', 'gw'])
    expect(cfg.services.find(s => s.name === 'eis')!.group).toBe('tspay')
  })

  it('중복 이름은 throw', () => {
    const src = 'services:\n  eis:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n'
    expect(() => appendService(src, { name: 'eis', kind: 'command', dir: 'C:\\y', run: 'r', port: 2 })).toThrowError(/이미/)
  })

  it('command인데 run이 없으면 검증 단계에서 걸러진다', () => {
    const out = appendService('', { name: 'bad', kind: 'command', dir: 'C:\\x', port: 1 })
    expect(() => loadConfigFromString(out)).toThrowError()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/add.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/add.ts`

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseDocument } from 'yaml'
import { CONFIG_PATH, ORCA_HOME, loadConfigFromString, ConfigError } from './config.js'

export interface NewService {
  name: string; group?: string; kind: 'spring' | 'command'
  dir: string; module?: string; run?: string; port: number; health?: string
}

export function appendService(src: string, s: NewService): string {
  const doc = parseDocument(src.trim() === '' ? 'services: {}\n' : src)
  if (doc.hasIn(['services', s.name])) throw new Error(`'${s.name}'은(는) 이미 등록돼 있습니다`)
  if (!doc.hasIn(['services'])) doc.setIn(['services'], doc.createNode({}))
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
    if (e instanceof ConfigError || e instanceof Error) console.error(`등록 실패: ${e.message}`)
  } finally { rl.close() }
}
```

`src/cli.ts`의 `main()` 첫 부분, `--version` 분기 다음에 추가:

```ts
  if (arg === 'add') { const { runAdd } = await import('./add.js'); await runAdd(); return }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test test/add.test.ts` 그리고 전체 `pnpm test`
Expected: PASS

- [ ] **Step 5: 수동 검증**

Run: `pnpm dev add` — 질문에 답해서 등록 → `%USERPROFILE%\.orca\services.yaml`에 반영됐는지, `pnpm dev`로 목록에 보이는지 확인

- [ ] **Step 6: 커밋**

```powershell
git add -A; git commit -m "feat: orca add 대화형 서비스 등록"
```

---

### Task 14: 최초 튜닝 (orca setup)

**Files:**
- Create: `src/setup.ts`
- Modify: `src/cli.ts` (setup 분기 추가)
- Test: `test/setup.test.ts`

**Interfaces:**
- Consumes: `loadConfig`(2)
- Produces:
  - `adviseGradleProps(props: string): string[]` (순수) — gradle.properties 내용을 보고 권장 사항 문자열 목록 (변경은 하지 않음, 스펙: 안내만)
  - `exclusionPaths(serviceDirs: string[]): string[]` (순수) — Defender 예외 대상: 서비스 dir들 + `~\.gradle` (+ 존재하면 pnpm 스토어 경로. 이건 순수성 위해 인자로 받지 말고 runSetup에서 합친다)
  - `runSetup(): Promise<void>` — 예외 목록 출력 → y/N 확인 → 관리자 권한 PowerShell로 `Add-MpPreference -ExclusionPath` 실행(UAC 창 1회), java/node 버전 출력, spring 서비스별 gradle.properties 권장 사항 출력

- [ ] **Step 1: 실패하는 테스트 작성** — `test/setup.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { adviseGradleProps } from '../src/setup.js'

describe('adviseGradleProps', () => {
  it('데몬 힙이 2g 초과면 권고한다', () => {
    const a = adviseGradleProps('org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g\n')
    expect(a.some(x => x.includes('4g'))).toBe(true)
  })
  it('2g 이하면 힙 권고 없음', () => {
    const a = adviseGradleProps('org.gradle.jvmargs=-Xmx2g\n')
    expect(a.some(x => x.includes('데몬 힙'))).toBe(false)
  })
  it('병렬 워커 무제한이면 권고한다', () => {
    expect(adviseGradleProps('').some(x => x.includes('max-workers'))).toBe(true)
    expect(adviseGradleProps('org.gradle.workers.max=8\n').some(x => x.includes('max-workers'))).toBe(false)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test test/setup.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/setup.ts`

```ts
import { readFileSync, existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadConfig, ConfigError } from './config.js'

const run = promisify(execFile)

export function adviseGradleProps(props: string): string[] {
  const advices: string[] = []
  const xmx = props.match(/org\.gradle\.jvmargs\s*=.*?-Xmx(\d+)([gGmM])/)
  if (xmx) {
    const mb = Number(xmx[1]) * (xmx[2].toLowerCase() === 'g' ? 1024 : 1)
    if (mb > 2048) advices.push(`Gradle 데몬 힙이 ${xmx[1]}${xmx[2]}입니다 — 로컬 빌드는 2g 이하 권장 (org.gradle.jvmargs)`)
  }
  if (!/org\.gradle\.workers\.max\s*=/.test(props)) {
    advices.push('org.gradle.workers.max 미설정 — 코어 수만큼 병렬 빌드가 돌 수 있습니다. 4~8 권장 (max-workers)')
  }
  return advices
}

export function exclusionPaths(serviceDirs: string[]): string[] {
  return [...new Set([...serviceDirs, join(homedir(), '.gradle')])]
}

export async function runSetup(): Promise<void> {
  let dirs: string[] = []
  let springDirs: string[] = []
  try {
    const cfg = loadConfig()
    dirs = cfg.services.map(s => s.dir)
    springDirs = [...new Set(cfg.services.filter(s => s.kind === 'spring').map(s => s.dir))]
  } catch (e) {
    if (e instanceof ConfigError) console.log('(설정이 없어 등록된 서비스 경로는 건너뜁니다)')
  }
  const paths = exclusionPaths(dirs)
  try {
    const { stdout } = await run('pnpm', ['store', 'path'], { windowsHide: true, shell: true })
    if (stdout.trim()) paths.push(stdout.trim())
  } catch { /* pnpm 없으면 생략 */ }

  console.log('Windows Defender 실시간 검사 예외로 등록할 경로:')
  for (const p of paths) console.log(`  - ${p}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = (await rl.question('등록할까요? 관리자 권한 창이 뜹니다 [y/N] ')).trim().toLowerCase()
  rl.close()
  if (ans === 'y') {
    const list = paths.map(p => `'${p}'`).join(',')
    // UAC 승격 1회로 전체 등록
    spawn('powershell', ['-NoProfile', '-Command',
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command Add-MpPreference -ExclusionPath ${list}'`,
    ], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    console.log('관리자 권한 창에서 등록을 승인해주세요.')
  }

  for (const cmd of [['java', '-version'], ['node', '-v']] as const) {
    try {
      const { stdout, stderr } = await run(cmd[0], [cmd[1]], { windowsHide: true, shell: true })
      console.log(`${cmd[0]}: ${(stdout + stderr).split(/\r?\n/)[0]}`)
    } catch { console.log(`${cmd[0]}: 찾을 수 없음 — PATH 확인 필요`) }
  }

  for (const dir of springDirs) {
    const gp = join(dir, 'gradle.properties')
    if (!existsSync(gp)) continue
    const advices = adviseGradleProps(readFileSync(gp, 'utf8'))
    if (advices.length > 0) {
      console.log(`\n${gp}:`)
      for (const a of advices) console.log(`  ! ${a}`)
    }
  }
  console.log('\nsetup 완료. (프로젝트 파일은 수정하지 않았습니다 — 권장 사항만 안내)')
}
```

`src/cli.ts`의 `add` 분기 다음에 추가:

```ts
  if (arg === 'setup') { const { runSetup } = await import('./setup.js'); await runSetup(); return }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test`
Expected: 전체 PASS

- [ ] **Step 5: 수동 검증**

Run: `pnpm dev setup` — 예외 목록이 맞는지 확인, `y` 입력 시 UAC 창이 뜨고 승인 후 `Get-MpPreference | Select -Expand ExclusionPath`(관리자 PowerShell)에 경로가 추가됐는지 확인. java/node 버전 줄과 gradle.properties 권고가 출력되는지 확인.

- [ ] **Step 6: 커밋**

```powershell
git add -A; git commit -m "feat: orca setup - Defender 예외 등록 및 환경 점검"
```

---

### Task 15: 자원 예산 검증 + 설치 문서

**Files:**
- Create: `scripts/measure-budget.mjs`, `README.md`

**Interfaces:**
- Consumes: 빌드 산출물 `dist/supervisor.js`, `dist/stats.js` (사전 `pnpm build` 필요), `test/fixtures/dummy-server.mjs`
- Produces: 예산(평균 CPU ≤1%, RAM ≤150MB) 검증 스크립트. 초과 시 exit 1. README에 측정 결과 기록.

- [ ] **Step 1: 측정 스크립트 작성** — `scripts/measure-budget.mjs`

```js
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
```

- [ ] **Step 2: 빌드 후 측정 실행**

Run: `pnpm build; if ($?) { node scripts/measure-budget.mjs }`
Expected: `✔ 예산 통과`, exit 0.
초과 시 대응 순서(스펙의 예산은 완료 조건):
1. RAM 초과가 PS 헬퍼 때문이면 → 헬퍼가 유휴일 때도 큰지 확인. 60MB 이상이면 `stats.ts`의 헬퍼 spawn 인자에 `-Version 5.1` 제거·`-NonInteractive` 추가를 시도하고 재측정
2. CPU 초과면 → tick 간격을 3초→5초로 늘리고 재측정 (dashboard의 도움말 문구는 그대로)
3. 그래도 초과면 수치와 함께 사용자에게 보고하고 예산 재협상 (임의로 예산을 바꾸지 않는다)

- [ ] **Step 3: README 작성** — `README.md`

````markdown
# orca

Windows에서 로컬 개발 의존성 서비스들을 자원 아껴서 백그라운드로 띄우는 TUI 러너.
직접 개발 중인 서비스는 IDE로 띄우고, 나머지 "떠 있기만 하면 되는" 것들을 orca에 맡긴다.

## 설치

```powershell
pnpm install
pnpm build
npm install -g .     # 이후 어디서든 `orca`
```

## 사용

```powershell
orca setup           # 최초 1회: Defender 예외 등록, 환경 점검
orca add             # 서비스 등록 (대화형) → ~\.orca\services.yaml
orca                 # 전체 대시보드
orca <그룹>          # 그룹만
```

대시보드 키: `↑↓` 선택 · `s` 시작/중지 · `a` 전체 시작 · `l` 로그 · `m` 수집 on/off · `q` 종료(전체 정리)

## 동작 방식

- spring 서비스: `gradlew bootJar`(소스 변경 없으면 캐시) → `java -jar` + `-Xmx512m` + 2코어 인식 + BelowNormal 우선순위. 빌드 후 Gradle 데몬은 `--stop`으로 정리.
- command 서비스: 임의 명령 + 낮은 우선순위 (+ 선택적 CPU affinity)
- 로그: `~\.orca\logs\<이름>.log` (10MB 롤링)
- 자원 수집: 장수명 PowerShell 헬퍼 1개에 3초마다 일괄 요청. `m`으로 완전히 끌 수 있음.

## 자원 예산

러너 자체는 평균 CPU 1% 이하, RAM 150MB 이하를 유지한다. 검증:

```powershell
pnpm build; node scripts/measure-budget.mjs
```

최근 측정: (Task 15에서 실제 출력으로 채운다 — 예: CPU 0.4%, RAM 118MB, 2026-08-14, 32코어/64GB 머신)
````

- [ ] **Step 4: README의 "최근 측정"을 Step 2의 실제 출력 수치로 교체**

측정값을 그대로 옮겨 적는다. 측정 없이 수치를 적지 않는다.

- [ ] **Step 5: 전체 테스트 최종 확인**

Run: `pnpm test`
Expected: 전체 PASS

- [ ] **Step 6: 커밋**

```powershell
git add -A; git commit -m "test: 자원 예산 측정 스크립트 및 README"
```

---

## 계획 셀프리뷰 결과 (작성자 기록)

스펙 대비 커버리지 점검:
- 전역 설정/그룹/`orca add` → Task 2, 12, 13
- spring/command 프리셋, 힙·코어·우선순위 제한, jar 캐시, `gradlew --stop` → Task 4, 5, 8, 9
- 포트 충돌 감지(점유자 표시), 트리 종료, 고아 감지, 크래시 자동재시작 안 함 → Task 3, 5, 9, 12
- 로그 파일 상시 기록 + 10MB 롤링 + 로그 뷰(스크롤) → Task 6, 12
- 헬스체크(HTTP/포트, 10초 간격이 아닌 STARTING 중 1초 폴링 + UP 이후는 tick에서 미확인) → **의도적 단순화**: 스펙의 "10초 간격 헬스체크"는 UP 이후 감시용이었으나, UP 이후 죽음은 프로세스 exit 이벤트가 즉시 잡으므로 주기 헬스체크는 생략(오히려 예산 절약). 스펙과 다른 점이니 리뷰 시 인지할 것.
- 수집 예산(1%/150MB)·배치 샘플링·스폰 금지·`m` 토글 → Task 10, 12, 15
- `orca setup`(Defender/버전/gradle.properties 안내) → Task 14
- 자원 예산 측정 → Task 15
