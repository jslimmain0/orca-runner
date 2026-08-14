# orca 사용성 개선 (P0+P1) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 7관점 사용성 협의회가 합의한 P0 5건 + P1 8건을 기존 orca 코드베이스에 증분 구현한다.

**Architecture:** 기존 모듈 구조 유지. supervisor/dashboard/app을 중심으로 한 소규모 증분 + 신규 파일 3개(status.ts, remove.ts, headless.ts, session.ts). 모든 변경은 새 주기 작업을 추가하지 않는다(자원 예산 보존) — 유일한 예외는 P1-4의 SKIP 포트 확인으로, 기존 3초 tick에 편승한다.

**Tech Stack:** 기존과 동일 — Node 20+/TypeScript NodeNext ESM, 런타임 의존성 `yaml` 하나, vitest.

**Spec:** `docs/superpowers/reviews/2026-08-15-usability-council.md` — 각 항목의 "반대 해소" 조건은 구현 요건이다. 태스크마다 해당 스펙 항목 id를 표기한다.

## Global Constraints

- 자원 예산 유지: 러너 CPU 평균 ≤1%, RAM ≤150MB. **새 setInterval/타이머 추가 금지** (P1-4의 portListening은 기존 3초 tick 안에서만).
- 상태 텍스트는 항상 1차 신호 — 색상/아이콘은 가속 장치. `NO_COLOR` 환경변수 존재 또는 non-TTY면 색 비활성.
- 아이콘은 KS X 1001 안전 글리프만: UP `●`, STARTING `▲`, BUILDING `■`, DOWN `○`, CRASHED `×`, ERROR `!`, SKIP `◇`.
- 예약어(고정): `add, setup, status, up, down, start, stop, remove, groups, help`. 그룹명으로 등록 금지.
- CLI exit code 계약: 성공 0, 실패/불일치 1. `--json` 출력은 텍스트 출력과 같은 판정 로직을 공유한다.
- 인자 없는 `orca`는 항상 전체 서비스 (기각된 DD-4 재도입 금지).
- 에러 메시지 스타일 기존 유지(한국어, 파일·줄 번호 포함은 config 계열).
- 커밋: conventional commits. 각 태스크 완료 시 `pnpm test` 전체 + `./node_modules/.bin/tsc --noEmit` 클린 필수.
- run.json 스키마 v2 (Task 6에서 도입): `{ [name]: { pid: number, owner: number } }` — owner는 관리 orca 세션의 PID, `0`은 headless(의도적 분리), 레거시 숫자값은 `{ pid: n, owner: -1 }`로 정규화(-1 = 소유자 불명 → 고아 후보).
- 저장소 루트 `C:\Users\jslim\orca\runner`, 브랜치는 SDD 컨트롤러가 준비.

## File Structure

```
수정: src/supervisor.ts   (Task 1,2,3,10,13 — writeExitReason/startedAt/stopAll반환/skip/startMany)
수정: src/health.ts       (Task 1 — httpProbe)
수정: src/tui/dashboard.ts(Task 1,2,3,9,10,13 — 말줄임/색·경과시간/확인문구/번호/SKIP/배너)
수정: src/app.ts          (Task 3,8,9,10,13 — q안전화·리포트/로그상한/키/x/u·세션저장)
수정: src/add.ts          (Task 4,7 — 인터뷰 개선/예약어 그룹 거부)
수정: src/config.ts       (Task 4,5,7 — 이름 검증/타입 검증/RESERVED_WORDS)
수정: src/procctl.ts      (Task 3,6 — killTree 결과/run.json v2·소유)
수정: src/cli.ts          (Task 6,7,11,12 — status/help·groups/remove/up·down·start·stop)
수정: src/tui/logView.ts  (Task 8 — maxOffset/헤더/빈 로그)
수정: src/tui/keys.ts     (Task 9,13 — r/enter 활용/u)
수정: src/types.ts        (Task 2,10 — startedAt/skipped·skipPortUp)
생성: src/status.ts       (Task 6)
생성: src/remove.ts       (Task 11)
생성: src/headless.ts     (Task 12, Task 13에서 수정)
생성: src/session.ts      (Task 13)
수정: README.md           (Task 13)
테스트: 각 태스크가 대응 test/*.test.ts 수정/추가
```

의존: Task 2는 1 뒤(대시보드 말줄임 위에 색 입힘), Task 3은 2 뒤(help 줄 오버라이드), Task 9·10·13은 3 뒤(확인/배너 키 게이트), Task 12는 6·7 뒤(소유 판정·예약어), Task 13은 12 뒤(headless up 기본 대상). Task 4·5·8·11은 비교적 독립.

---

### Task 1: 빨간 상태 진단 3종 세트 (스펙 P0-2)

**Files:**
- Modify: `src/health.ts`, `src/supervisor.ts`, `src/tui/dashboard.ts`
- Test: `test/health.test.ts`, `test/supervisor.test.ts`, `test/dashboard.test.ts`

**Interfaces:**
- Consumes: 기존 Supervisor/LogWriter/dashboardLines.
- Produces:
  - `health.ts`: `httpProbe(url, timeoutMs=2000): Promise<{ ok: boolean; detail: string }>` — ok=res.ok, detail은 `HTTP 200` / `HTTP 503` / `연결 거부` / `응답 시간 초과(2000ms)` / 기타 err.message. 기존 `httpUp`은 `(await httpProbe(url, t)).ok`로 재구현(시그니처 유지).
  - `dashboard.ts`: `truncateRow(row: string, width: number): string` — row.length > width면 `row.slice(0, width - 1) + '…'`, 아니면 그대로. (Task 2가 색 입히기 전에 이 평문 단계에서 적용)
  - supervisor: ERROR/CRASHED 전이 시 로그 파일 마지막에 `[ORCA] <ISO시각> ERROR: <사유>` 한 줄 기록. exit 핸들러는 `(code, signal)`을 받아 CRASHED의 error 필드를 `프로세스 종료 (code 1)` 또는 `시그널 SIGTERM로 종료` 형태로 세팅.

- [ ] **Step 1: 실패하는 테스트 추가**

`test/health.test.ts`에 추가:

```ts
import { httpProbe } from '../src/health.js'   // 상단 import에 병합

  it('httpProbe: 정상 응답은 ok=true, detail=HTTP 200', async () => {
    const r = await httpProbe(`http://localhost:${PORT}/health`)
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('HTTP 200')
  })
  it('httpProbe: 404는 ok=false, detail=HTTP 404', async () => {
    const r = await httpProbe(`http://localhost:${PORT}/nope`)
    expect(r).toEqual({ ok: false, detail: 'HTTP 404' })
  })
  it('httpProbe: 닫힌 포트는 연결 거부 detail', async () => {
    const r = await httpProbe('http://localhost:1/health', 500)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/연결 거부|fetch failed|시간 초과/)
  })
```

`test/supervisor.test.ts`에 추가 (기존 헬퍼 재사용, logDir는 mkdtempSync로):

```ts
import { readFileSync } from 'node:fs'

  it('포트 점유 ERROR 시 로그 파일에 [ORCA] ERROR 사유가 남는다', async () => {
    const blocker = createServer(() => {})
    await new Promise<void>(r => blocker.listen(45833, () => r()))
    const logDir = mkdtempSync(join(tmpdir(), 'orca-sv-'))
    sup = new Supervisor(cfg(45833, 45834), { logDir })
    await sup.start('dummy-a')
    const log = readFileSync(join(logDir, 'dummy-a.log'), 'utf8')
    expect(log).toMatch(/\[ORCA\] .+ ERROR: 포트 45833 점유 중/)
    blocker.close()
  }, 15000)

  it('CRASHED 시 종료 코드/시그널이 error 필드와 로그에 남는다', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'orca-sv-'))
    sup = new Supervisor(cfg(45835, 45836), { logDir })
    await sup.start('dummy-a')
    const pid = sup.pids().get('dummy-a')!
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    await new Promise(r => setTimeout(r, 1500))
    const st = sup.states()[0]
    expect(st.status).toBe('CRASHED')
    expect(st.error).toMatch(/프로세스 종료|시그널/)
    const log = readFileSync(join(logDir, 'dummy-a.log'), 'utf8')
    expect(log).toMatch(/\[ORCA\] .+ ERROR: (프로세스 종료|시그널)/)
  }, 15000)
```

`test/dashboard.test.ts`에 추가:

```ts
import { truncateRow } from '../src/tui/dashboard.js'   // import에 병합

  it('truncateRow: 폭 초과 시 말줄임', () => {
    expect(truncateRow('abcdef', 4)).toBe('abc…')
    expect(truncateRow('abc', 4)).toBe('abc')
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/health.test.ts test/dashboard.test.ts` → FAIL (httpProbe/truncateRow 없음)

- [ ] **Step 3: 구현**

`src/health.ts` — httpUp을 httpProbe 기반으로 교체:

```ts
export async function httpProbe(url: string, timeoutMs = 2000): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, detail: `HTTP ${res.status}` }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    if (e.name === 'TimeoutError') return { ok: false, detail: `응답 시간 초과(${timeoutMs}ms)` }
    if (e.cause?.code === 'ECONNREFUSED') return { ok: false, detail: '연결 거부' }
    return { ok: false, detail: e.message }
  }
}

export async function httpUp(url: string, timeoutMs = 2000): Promise<boolean> {
  return (await httpProbe(url, timeoutMs)).ok
}
```

`src/supervisor.ts`:
1. private 헬퍼 추가 (set/logFile 옆):
```ts
  /** ERROR/CRASHED 사유를 서비스 로그 마지막 줄에 남긴다 — "빨간 상태 → l" 루프의 연결고리 */
  private noteToLog(e: Entry, reason: string): void {
    try { e.log?.stream().write(`[ORCA] ${new Date().toISOString()} ERROR: ${reason}\n`) } catch { /* 스트림 닫힘 */ }
  }
```
2. 포트 점유 분기(현재 79-84행): `e.log?.close()` **앞에** `this.noteToLog(e, \`포트 ${def.port} 점유 중: ${holder.exe} (PID ${holder.pid})\`)`.
3. exit 핸들러(현재 94-101행): `child.once('exit', (code, signal) => { ... })`로 시그니처 변경. CRASHED 분기 직전에 사유 생성:
```ts
        const reason = signal ? `시그널 ${signal}로 종료` : `프로세스 종료 (code ${code ?? '?'})`
        if (!e.stopping && e.state.status !== 'ERROR') this.noteToLog(e, reason)
```
CRASHED 전이를 `{ status: 'CRASHED', pid: undefined, error: reason }`으로 변경 (stopping이면 기존대로 DOWN, error 유지 안 함).
4. 헬스 타임아웃(현재 113-116행): 루프 안에서 마지막 프로브 결과를 기억하도록 수정 —
```ts
      let lastDetail = ''
      const deadline = Date.now() + this.healthTimeoutMs
      while (Date.now() < deadline && cur() === 'STARTING') {
        if (def.health) {
          const p = await httpProbe(def.health)
          lastDetail = p.detail
          if (p.ok && cur() === 'STARTING') { this.set(e, { status: 'UP' }); return }
        } else {
          const up = await portListening(def.port)
          lastDetail = up ? '' : `포트 ${def.port} 리슨 없음`
          if (up && cur() === 'STARTING') { this.set(e, { status: 'UP' }); return }
        }
        await new Promise(r => setTimeout(r, HEALTH_INTERVAL))
      }
      if (cur() === 'STARTING') {
        const sec = this.healthTimeoutMs / 1000
        const reason = def.health
          ? `${sec}초 내 ${def.health} 확인 실패 (마지막: ${lastDetail}) — l로 로그 확인`
          : `${sec}초 내 포트 ${def.port} 리슨 확인 실패`
        this.noteToLog(e, reason)
        this.set(e, { status: 'ERROR', error: reason })
        if (e.state.pid) await killTree(e.state.pid)
      }
```
(import를 `httpProbe, portListening`으로 교체)
5. catch 블록(117-121행): ERROR 전이 직전 `this.noteToLog(e, (err as Error).message)` 추가 (e.log?.close()보다 앞).

`src/tui/dashboard.ts`:
```ts
export function truncateRow(row: string, width: number): string {
  return row.length > width ? row.slice(0, width - 1) + '…' : row
}
```
rows의 `.slice(0, width)`를 `truncateRow(행문자열, width)`로 교체.

- [ ] **Step 4: 통과 확인** — Run: `pnpm test` 전체 + `./node_modules/.bin/tsc --noEmit`. supervisor 기존 테스트(타임아웃 메시지 assertion이 있으면 새 문구로 갱신)가 깨지면 **새 메시지 형식에 맞춰 테스트 기대값 수정**.

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: ERROR/CRASHED 사유를 로그와 상태에 기록 (진단 루프 복원)"`

---

### Task 2: 대시보드 생동감 — 색·경과 시간·헤더 (스펙 P0-3)

**Files:**
- Modify: `src/types.ts`, `src/supervisor.ts`, `src/tui/dashboard.ts`, `src/app.ts`
- Test: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1의 truncateRow.
- Produces:
  - `types.ts` ServiceState에 `startedAt?: number` 추가 (현재 phase 진입 시각 ms).
  - `dashboardLines(states, sys, opts)` 로 시그니처 변경: `opts: { sel: number; statsOn: boolean; width?: number; now?: number; color?: boolean; helpOverride?: string }`. (helpOverride는 Task 3이 사용 — 여기서 미리 정의)
  - 아이콘 교체: `{ UP: '●', STARTING: '▲', BUILDING: '■', DOWN: '○', CRASHED: '×', ERROR: '!' }`
  - 상태 셀: BUILDING → `■ BUILDING 42s`, STARTING → 30초 이하 `▲ STARTING 7s`, 초과 시 `▲ STARTING 37s/120s`. BUILDING 행 뒤에 error가 없으면 ` (빌드는 수 분 걸릴 수 있음)` 힌트.
  - 색: 평문 행 조립·truncateRow 후 `colorizeRow(row, status, on)` 적용 — status 토큰과 아이콘만 감싼다.
  - 헤더: ` ORCA RUNNER   시스템 CPU {n}% · RAM {u}/{t}` + statsOn이면 ` · 서비스 {합계}` (Σ rssBytes), 수집 꺼짐이면 기존 `[수집 꺼짐]` 유지.

- [ ] **Step 1: 실패하는 테스트** — `test/dashboard.test.ts`를 새 시그니처로 재작성:

```ts
import { describe, it, expect } from 'vitest'
import { dashboardLines, fmtBytes, truncateRow, colorizeRow } from '../src/tui/dashboard.js'
import type { ServiceState } from '../src/types.js'

const st = (over: Partial<ServiceState['def']> & Partial<ServiceState> & { status: ServiceState['status'] }): ServiceState => ({
  def: { name: over.name ?? 'svc', kind: 'command', dir: 'C:\\x', port: over.port ?? 8080, heapMb: 0, cpus: 0, priority: 'normal', jvmArgs: [], run: 'r' },
  status: over.status, rssBytes: over.rssBytes, error: over.error, startedAt: over.startedAt, pid: over.pid,
})
const SYS = { cpuPercent: 41, usedBytes: 18 * 1024 ** 3, totalBytes: 63 * 1024 ** 3 }

describe('dashboard v2', () => {
  it('BUILDING 경과 시간과 힌트를 표시한다', () => {
    const lines = dashboardLines([st({ name: 'eis', status: 'BUILDING', startedAt: 100_000 })], SYS,
      { sel: 0, statsOn: false, now: 142_000, color: false })
    const row = lines.find(l => l.includes('eis'))!
    expect(row).toContain('BUILDING 42s')
    expect(row).toContain('빌드는 수 분')
  })
  it('STARTING 30초 초과 시에만 /120s 분모를 붙인다', () => {
    const mk = (elapsed: number) => dashboardLines([st({ status: 'STARTING', startedAt: 0 })], SYS,
      { sel: 0, statsOn: false, now: elapsed * 1000, color: false }).find(l => l.includes('STARTING'))!
    expect(mk(7)).toContain('STARTING 7s')
    expect(mk(7)).not.toContain('/120s')
    expect(mk(37)).toContain('STARTING 37s/120s')
  })
  it('헤더에 시스템 라벨과 서비스 합계 RAM이 표시된다', () => {
    const lines = dashboardLines([st({ status: 'UP', rssBytes: 500 * 1024 ** 2 }), st({ name: 'b', status: 'UP', rssBytes: 500 * 1024 ** 2 })],
      SYS, { sel: 0, statsOn: true, color: false })
    expect(lines[0]).toContain('시스템 CPU 41%')
    expect(lines[0]).toContain('서비스 1000MB')
  })
  it('colorizeRow: on이면 상태 토큰에 SGR, off면 평문 그대로', () => {
    const row = ' ● svc UP'
    expect(colorizeRow(row, 'UP', false)).toBe(row)
    const c = colorizeRow(row, 'UP', true)
    expect(c).toContain('\x1b[32m')
    expect(c).toContain('\x1b[0m')
  })
  it('아이콘이 상태별로 구분된다 (CRASHED × / ERROR !)', () => {
    const mk = (s: ServiceState['status']) => dashboardLines([st({ status: s })], SYS, { sel: 0, statsOn: false, color: false })[2]
    expect(mk('CRASHED')).toContain('×')
    expect(mk('ERROR')).toContain('!')
    expect(mk('STARTING')).toContain('▲')
  })
})
```
(기존 dashboard 테스트 케이스들은 새 시그니처 `{ sel, statsOn, color: false }`로 이관 — assertion 의미는 유지.)

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/dashboard.test.ts` → FAIL

- [ ] **Step 3: 구현** — `src/tui/dashboard.ts` 전면 교체:

```ts
import type { ServiceState, ServiceStatus } from '../types.js'
import type { SysSample } from '../sysinfo.js'

const ICON: Record<string, string> = { UP: '●', STARTING: '▲', BUILDING: '■', DOWN: '○', CRASHED: '×', ERROR: '!' }
const SGR: Record<string, string> = { UP: '\x1b[32m', STARTING: '\x1b[33m', BUILDING: '\x1b[33m', DOWN: '\x1b[2m', CRASHED: '\x1b[31m', ERROR: '\x1b[35m' }
const RESET = '\x1b[0m'

export function fmtBytes(n?: number): string {
  if (n === undefined) return '-'
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB'
  return Math.round(n / 1024 ** 2) + 'MB'
}

export function truncateRow(row: string, width: number): string {
  return row.length > width ? row.slice(0, width - 1) + '…' : row
}

/** 평문 행에서 아이콘+상태 구간만 SGR로 감싼다 — 상태 텍스트가 항상 1차 신호, 색은 가속 장치 */
export function colorizeRow(row: string, status: ServiceStatus, on: boolean): string {
  if (!on) return row
  const sgr = SGR[status]
  if (!sgr) return row
  const icon = ICON[status]
  const idx = row.indexOf(icon)
  if (idx === -1) return row
  const end = row.indexOf('  ', row.indexOf(status, idx))   // 상태 셀 끝(패딩 공백)까지
  const stop = end === -1 ? row.length : end
  return row.slice(0, idx) + sgr + row.slice(idx, stop) + RESET + row.slice(stop)
}

export interface DashOpts {
  sel: number; statsOn: boolean
  width?: number; now?: number; color?: boolean; helpOverride?: string
}

function statusCell(s: ServiceState, now: number): string {
  const elapsed = s.startedAt ? Math.max(0, Math.round((now - s.startedAt) / 1000)) : 0
  if (s.status === 'BUILDING') return `BUILDING ${elapsed}s`
  if (s.status === 'STARTING') return elapsed > 30 ? `STARTING ${elapsed}s/120s` : `STARTING ${elapsed}s`
  return s.status
}

export function dashboardLines(states: ServiceState[], sys: SysSample, opts: DashOpts): string[] {
  const width = opts.width ?? 100
  const now = opts.now ?? Date.now()
  const color = opts.color ?? false
  const svcSum = states.reduce((n, s) => n + (s.rssBytes ?? 0), 0)
  const head = ` ORCA RUNNER   시스템 CPU ${sys.cpuPercent.toFixed(0)}% · RAM ${fmtBytes(sys.usedBytes)}/${fmtBytes(sys.totalBytes)}`
    + (opts.statsOn ? (svcSum > 0 ? ` · 서비스 ${fmtBytes(svcSum)}` : '') : '  [수집 꺼짐]')
  const sep = ' ' + '─'.repeat(Math.max(10, width - 2))
  const rows = states.map((s, i) => {
    const cur = i === opts.sel ? '>' : ' '
    const name = s.def.name.padEnd(16).slice(0, 16)
    const port = String(s.def.port).padStart(5)
    const status = statusCell(s, now).padEnd(17)
    const mem = opts.statsOn ? fmtBytes(s.rssBytes).padStart(8) : ''
    const cpu = opts.statsOn && s.cpuPercent !== undefined ? (s.cpuPercent.toFixed(0) + '%').padStart(5) : ''
    const note = s.error ? '  ' + s.error : (s.status === 'BUILDING' ? '  (빌드는 수 분 걸릴 수 있음)' : '')
    const plain = truncateRow(`${cur}${ICON[s.status] ?? '?'} ${name} :${port} ${status}${mem}${cpu}${note}`, width)
    return colorizeRow(plain, s.status, color)
  })
  const help = opts.helpOverride ?? ' [↑↓]선택 [s]시작/중지 [a]전체시작 [l]로그 [m]수집 [q]종료'
  return [head, sep, ...rows, sep, help]
}
```

`src/types.ts` ServiceState에 `startedAt?: number` 추가.

`src/supervisor.ts`: BUILDING 전이 시 `{ status: 'BUILDING', error: undefined, startedAt: Date.now() }`, STARTING 전이 시 `{ status: 'STARTING', pid, error: undefined, startedAt: Date.now() }`, UP/DOWN/CRASHED/ERROR 전이 시 `startedAt: undefined`를 patch에 포함.

`src/app.ts` draw(): `dashboardLines(states, sampleSystem(), { sel, statsOn, width, color: process.stdout.isTTY === true && !process.env.NO_COLOR })`.

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. colorizeRow가 truncateRow **뒤에** 적용되므로 SGR이 잘리는 일이 없다 — 리뷰 포인트.

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: 대시보드 상태 색상·경과 시간·시스템/서비스 헤더 구분"`

---

### Task 3: `q` 안전화 + 종료 결과 리포트 (스펙 P0-1)

**Files:**
- Modify: `src/procctl.ts`, `src/supervisor.ts`, `src/app.ts`
- Test: `test/procctl.test.ts`, `test/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 2의 `DashOpts.helpOverride`.
- Produces:
  - `procctl.ts`: `killTree(pid): Promise<boolean>` — true = 종료 확인(taskkill 성공 또는 "프로세스 없음"=이미 죽음), false = 진짜 실패(권한 등). taskkill의 "not found"는 stderr에 `찾을 수 없습니다`/`not found`가 오거나 exit 128 — **exit code 128 또는 err.code === 128이면 true**, 그 외 오류는 false.
  - supervisor: `stopAll(): Promise<{ stopped: string[]; unconfirmed: { name: string; pid: number }[] }>` — stopped = 이번 호출로 DOWN 확인된 이름들, unconfirmed = 5초 내 DOWN 미확인 + pid 잔존.
  - app: 로그 뷰의 `q`는 Esc와 동일(종료 아님). 대시보드 `q`는 BUILDING/STARTING 진행 중일 때만 2단계 확인(helpOverride 문구), 그 외 즉시 종료. 종료 시 `✔ 서비스 N개 모두 종료 확인` 또는 `⚠ 종료 미확인: name (PID n) — 다음 orca 실행 시 고아 정리를 이용하세요` 출력. SIGINT는 확인 없이 즉시 종료(의도적 예외 — 주석 필수).

- [ ] **Step 1: 실패하는 테스트**

`test/procctl.test.ts`에 추가:

```ts
  it('killTree: 살아있는 프로세스는 true, 이미 죽은 pid도 true', async () => {
    const { pid } = await spawnService({
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: process.cwd(), priority: 'normal', out: new PassThrough(),
    })
    expect(await killTree(pid)).toBe(true)      // 실제 종료
    await sleep(300)
    expect(await killTree(pid)).toBe(true)      // 이미 죽음 = 확인된 것
    expect(await killTree(4000000)).toBe(true)  // 존재한 적 없음 = 이미 죽음 취급
  }, 15000)
```

`test/supervisor.test.ts`에 추가:

```ts
  it('stopAll이 종료 확인 결과를 반환한다', async () => {
    sup = new Supervisor(cfg(45841, 45842), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.startAll()
    const r = await sup.stopAll()
    expect(r.stopped.sort()).toEqual(['dummy-a', 'dummy-b'])
    expect(r.unconfirmed).toEqual([])
  }, 30000)
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/procctl.test.ts test/supervisor.test.ts` → FAIL (반환값 없음)

- [ ] **Step 3: 구현**

`src/procctl.ts` killTree 교체:

```ts
/** true = 트리 종료 확인(성공 또는 이미 죽음), false = 진짜 실패(권한 등) */
export async function killTree(pid: number): Promise<boolean> {
  try { await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); return true }
  catch (err) {
    const code = (err as { code?: number }).code
    if (code === 128) return true          // ERROR_WAIT_NO_CHILDREN: 프로세스 없음 = 이미 죽음
    return !isAlive(pid)                   // 그 외 오류라도 실제로 죽었으면 확인된 것
  }
}
```

`src/supervisor.ts` stopAll 교체:

```ts
  async stopAll(): Promise<{ stopped: string[]; unconfirmed: { name: string; pid: number }[] }> {
    const targets = [...this.entries.entries()]
      .filter(([, e]) => e.state.status !== 'DOWN' && (e.state.pid || e.buildChild?.pid))
      .map(([n]) => n)
    await Promise.all(targets.map(n => this.stop(n)))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && [...this.entries.values()].some(e => e.stopping && e.state.status !== 'DOWN')) {
      await new Promise(r => setTimeout(r, 100))
    }
    const stopped: string[] = []
    const unconfirmed: { name: string; pid: number }[] = []
    for (const n of targets) {
      const e = this.entries.get(n)!
      if (e.state.status === 'DOWN') stopped.push(n)
      else if (e.state.pid && isAlive(e.state.pid)) unconfirmed.push({ name: n, pid: e.state.pid })
      else stopped.push(n)   // pid 없거나 이미 죽음 = 확인
    }
    return { stopped, unconfirmed }
  }
```
(`isAlive`를 procctl import에 추가)

`src/app.ts`:
1. 상태 추가: `let confirmQuit = false`
2. draw()의 dash 분기에 helpOverride 전달:
```ts
      screen.render(dashboardLines(states, sampleSystem(), {
        sel, statsOn, width, color: process.stdout.isTTY === true && !process.env.NO_COLOR,
        helpOverride: confirmQuit ? ' ⚠ 빌드/기동 진행 중 — [q] 한 번 더 = 전체 종료, 다른 키 = 취소' : undefined,
      }))
```
3. quit() 종료부 교체 (`await sup.stopAll()` → 결과 리포트):
```ts
    const r = await sup.stopAll()
    if (r.unconfirmed.length === 0) console.log(`✔ 서비스 ${r.stopped.length}개 모두 종료 확인`)
    else for (const u of r.unconfirmed) console.log(`⚠ 종료 미확인: ${u.name} (PID ${u.pid}) — 다음 orca 실행 시 고아 정리를 이용하세요`)
```
4. 로그 뷰 키 처리: `else if (k === 'q') { void quit(); return }` 를 **제거**하고 첫 분기를 `if (k === 'esc' || k === 'l' || k === 'q') { view = 'dash'; screen.reset() }`로.
5. 대시보드 `case 'q'`:
```ts
      case 'q': {
        const busy = sup.states().some(s => s.status === 'BUILDING' || s.status === 'STARTING')
        if (busy && !confirmQuit) { confirmQuit = true; break }
        void quit(); return
      }
```
6. switch 진입 직전: `if (confirmQuit && k !== 'q') { confirmQuit = false; draw(); return }` — 확인 대기 중 다른 키는 취소만 하고 **행에 도달하지 않는다** (P1-5 요건 선반영).
7. SIGINT 핸들러에 주석: `// 외부 신호는 강제 종료 의사로 간주 — 2단계 확인을 의도적으로 생략한다 (협의회 P0-1 결정)`

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. Task 12(headless)가 `stopAll` 반환을 쓰므로 시그니처를 계획대로 유지.

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: q 안전화(로그뷰 재매핑·빌드중 2단계 확인)와 종료 결과 리포트"`

---

### Task 4: `orca add` 인터뷰 전면 개선 (스펙 P0-4)

**Files:**
- Modify: `src/add.ts`, `src/config.ts`
- Test: `test/add.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `loadConfigFromString`, `CONFIG_PATH`.
- Produces:
  - `add.ts`에 순수 검증 함수 export (대화 루프와 분리해 테스트 가능하게):
    - `validateName(name: string, existing: string[]): string | null` — null=통과, 아니면 에러 문구. 규칙: `/^[A-Za-z0-9._-]+$/` + 중복 시 `'x'은(는) 이미 등록돼 있습니다`.
    - `validatePort(input: string, cfg: { services: { name: string; port: number }[] }): { ok: true; port: number } | { ok: false; msg: string }` — 정수 1~65535, 중복 시 `포트 8081은 이미 eis-server가 쓰고 있습니다`.
    - `resolveGroup(input: string, existing: string[]): { value: string; needsConfirm?: string }` — trim, 대소문자만 다른 기존 그룹이 있으면 needsConfirm에 기존 그룹명.
  - `runAdd()`: 필드별 즉시 검증(실패한 필드만 재입력), 등록 후 `다른 서비스도 등록할까요? [y/N]` 루프(회차 헤더 `[N번째 서비스]`), **매 회차 CONFIG_PATH에서 디스크 재로드**, 종료 시 `이제 'orca'로 대시보드를 실행해 확인하세요` 출력. dir는 절대경로 필수 + 미존재 시 `경로가 존재하지 않습니다. 계속할까요? [y/N]` 확인.
  - `config.ts` loadConfigFromString: 서비스 키가 `/^[A-Za-z0-9._-]+$/` 불일치면 기존 fail() 패턴으로 줄 번호와 함께 거부 (YAML 직접 편집 방어).

- [ ] **Step 1: 실패하는 테스트**

`test/add.test.ts`에 추가:

```ts
import { validateName, validatePort, resolveGroup } from '../src/add.js'   // import 병합

describe('add validators', () => {
  it('validateName: 형식/중복', () => {
    expect(validateName('eis', [])).toBeNull()
    expect(validateName('', [])).toMatch(/잘못된 서비스 이름/)
    expect(validateName('bad name', [])).toMatch(/잘못된 서비스 이름/)
    expect(validateName('eis', ['eis'])).toMatch(/이미 등록/)
  })
  it('validatePort: 범위/중복에 점유 서비스명 명시', () => {
    const cfg = { services: [{ name: 'eis-server', port: 8081 }] }
    expect(validatePort('8082', cfg)).toEqual({ ok: true, port: 8082 })
    expect(validatePort('abc', cfg)).toMatchObject({ ok: false })
    expect(validatePort('0', cfg)).toMatchObject({ ok: false })
    const dup = validatePort('8081', cfg)
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.msg).toContain('eis-server')
  })
  it('resolveGroup: trim과 대소문자 통일 확인', () => {
    expect(resolveGroup(' tspay ', ['tspay'])).toEqual({ value: 'tspay' })
    expect(resolveGroup('Tspay', ['tspay'])).toEqual({ value: 'Tspay', needsConfirm: 'tspay' })
    expect(resolveGroup('infra', ['tspay'])).toEqual({ value: 'infra' })
  })
})
```

`test/config.test.ts`에 추가:

```ts
  it('잘못된 서비스 키 이름은 줄 번호와 함께 거부한다', () => {
    const bad = `services:\n  "bad name":\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n`
    expect(() => loadConfigFromString(bad, 'C:\\cfg.yaml')).toThrowError(/서비스 이름|이름/)
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/add.test.ts test/config.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/add.ts` — 검증 함수 추가 + runAdd 재작성:

```ts
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
```

runAdd 재작성 (핵심 구조 — 이 형태를 그대로 구현):

```ts
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
        if (go.toLowerCase() !== 'y') { console.log('이 서비스 등록을 건너뜁니다.'); if ((await ask('다른 서비스도 등록할까요? [y/N] ')).toLowerCase() === 'y') continue; break }
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
      if ((await ask('다른 서비스도 등록할까요? [y/N] ')).toLowerCase() !== 'y') break
    }
    console.log(`\n이제 'orca'로 대시보드를 실행해 확인하세요.`)
  } catch (e) {
    console.error(`등록 실패: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  } finally { rl.close() }
}
```
(import에 `existsSync` 추가. `loadConfigFromString` 반환의 group 접근을 위해 config의 Config 타입 그대로 사용해도 무방.)

`src/config.ts` — 서비스 루프 초입(kind 검사 앞)에:

```ts
    if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(at, `잘못된 서비스 이름: '${name}' (영문/숫자/._- 만 허용)`)
```

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. 기존 add 테스트(appendService)는 그대로 통과해야 한다.

- [ ] **Step 5: 수동 검증** — `pnpm dev add`로 1회: 잘못된 포트 입력 → 그 필드만 재질문되는지, 연속 등록 루프 동작 확인. (등록한 항목은 마지막에 services.yaml에서 수동 제거)

- [ ] **Step 6: 커밋** — `git add -A; git commit -m "feat: orca add 즉시 검증·연속 등록·그룹 힌트"`

---

### Task 5: 설정 타입 안전망 (스펙 P1-8)

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: 기존 fail(at, msg) 패턴.
- Produces: heapMb/cpus는 양의 정수(0 허용 — command 기본), jvmArgs는 문자열 배열, health/run/group/module은 문자열 — 위반 시 `파일 N행: name: 필드는 ...` 형식 ConfigError.

- [ ] **Step 1: 실패하는 테스트** — `test/config.test.ts`에 추가:

```ts
  it('heapMb가 숫자가 아니면 에러', () => {
    const bad = `services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    heapMb: many\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/heapMb/)
  })
  it('jvmArgs가 배열이 아니면 에러', () => {
    const bad = `services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    jvmArgs: -Dfoo\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/jvmArgs/)
  })
  it('cpus가 음수면 에러', () => {
    const bad = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n    cpus: -2\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/cpus/)
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/config.test.ts` → FAIL

- [ ] **Step 3: 구현** — `src/config.ts` 서비스 루프의 priority 검사 다음에 추가:

```ts
    const posInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0
    if (s.heapMb !== undefined && !posInt(s.heapMb)) fail(at, `${name}: heapMb는 0 이상의 정수여야 합니다`)
    if (s.cpus !== undefined && !posInt(s.cpus)) fail(at, `${name}: cpus는 0 이상의 정수여야 합니다`)
    if (s.jvmArgs !== undefined && (!Array.isArray(s.jvmArgs) || s.jvmArgs.some(a => typeof a !== 'string'))) {
      fail(at, `${name}: jvmArgs는 문자열 배열이어야 합니다 (예: jvmArgs: ["-Dspring.profiles.active=local"])`)
    }
    for (const f of ['health', 'run', 'group', 'module'] as const) {
      if (s[f] !== undefined && typeof s[f] !== 'string') fail(at, `${name}: ${f}은(는) 문자열이어야 합니다`)
    }
```

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: 설정 필드 타입 검증 (heapMb/cpus/jvmArgs 등)"`

---

### Task 6: `orca status [--json]` + 세션 소유 구분 (스펙 P0-5)

**Files:**
- Modify: `src/procctl.ts`, `src/supervisor.ts`, `src/app.ts`, `src/cli.ts`
- Create: `src/status.ts`
- Test: `test/procctl.test.ts`, `test/status.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `isAlive`, `httpUp`/`portListening`.
- Produces (run.json v2 — Global Constraints 참조):
  - `procctl.ts`:
    - `interface RunEntry { pid: number; owner: number }` export.
    - `readRunEntries(path?): Record<string, RunEntry>` export — 레거시 숫자값은 `{ pid: n, owner: -1 }`로 정규화.
    - `recordStart(name, pid, path?, owner = process.pid)` — v2 형태로 기록.
    - `findOrphans(path?)` — **owner가 죽었고**(owner<=0 포함, 단 owner===0 제외) pid가 살아있는 항목만.
    - `activeSessions(path?): { owner: number; services: { name: string; pid: number }[] }[]` — owner가 살아있는(0 제외) 세션 목록.
  - `status.ts`: `statusReport(opts: { cfg: Config; runPath?: string }): Promise<{ rows: { name: string; port: number; status: 'UP' | 'NO-RESPONSE' | 'DOWN'; pid?: number; owner?: string }[]; exitCode: number }>` — 판정: run 기록 pid 살아있음 + 프로브(health면 httpUp, 아니면 portListening) 통과 → UP; 살아있는데 프로브 실패 → NO-RESPONSE; 기록 없거나 죽음 → DOWN(죽은 기록은 표시만 DOWN, run.json은 건드리지 않음). owner 표기: `세션 12345` / `headless` / `불명`. exitCode: 등록 서비스 전부 UP이면 0, 아니면 1.
    `runStatus(json: boolean): Promise<void>` — statusReport를 텍스트 표/JSON으로 출력하고 `process.exitCode` 설정.
  - `cli.ts`: `if (arg === 'status') { ...; await runStatus(process.argv[3] === '--json'); return }` 분기 (add/setup 다음).
  - `app.ts` 고아 프롬프트 개선: `activeSessions()`가 비어있지 않으면 해당 서비스들은 `이미 다른 터미널(PID n)에서 관리 중: a, b — 상태만 보려면 orca status`로 안내만 하고 정리 프롬프트 대상에서 제외. 진짜 고아(findOrphans)만 기존 y/N.
  - supervisor: recordStart 호출은 시그니처 변경 없이 그대로 (owner 기본값 = process.pid).

- [ ] **Step 1: 실패하는 테스트**

`test/procctl.test.ts`의 기존 run.json 테스트를 v2로 교체 + 추가:

```ts
import { readRunEntries, activeSessions } from '../src/procctl.js'   // import 병합

  it('run.json v2: owner를 기록하고 레거시 숫자를 정규화한다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    writeFileSync(file, JSON.stringify({ legacy: 4000000 }))          // v1 레거시
    recordStart('svc-a', process.pid, file)                           // v2 (owner=현재 프로세스)
    const r = readRunEntries(file)
    expect(r['legacy']).toEqual({ pid: 4000000, owner: -1 })
    expect(r['svc-a']).toEqual({ pid: process.pid, owner: process.pid })
  })

  it('findOrphans: 소유 세션이 살아있으면 고아가 아니다', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    recordStart('mine', process.pid, file)                            // owner = 살아있는 나
    expect(findOrphans(file)).toEqual([])                             // 고아 아님
    expect(activeSessions(file)).toEqual([{ owner: process.pid, services: [{ name: 'mine', pid: process.pid }] }])
  })

  it('findOrphans: owner가 죽었고 pid가 살아있으면 고아, owner=0(headless)은 제외', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-run-')), 'run.json')
    writeFileSync(file, JSON.stringify({
      orphan: { pid: process.pid, owner: 4000000 },   // 죽은 소유자 + 살아있는 pid
      headless: { pid: process.pid, owner: 0 },        // 의도적 분리
      dead: { pid: 4000001, owner: 4000000 },          // pid도 죽음
    }))
    expect(findOrphans(file)).toEqual([{ name: 'orphan', pid: process.pid }])
  })
```
(writeFileSync import 필요)

`test/status.test.ts` 신규:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { statusReport } from '../src/status.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../src/types.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const PORT = 45851
let child: ChildProcess
beforeAll(async () => {
  child = spawn(process.execPath, [FIXTURE, String(PORT)], { windowsHide: true })
  await new Promise<void>(r => child.stdout!.once('data', () => r()))
})
afterAll(() => { child.kill() })

const base = { kind: 'command' as const, dir: process.cwd(), run: 'x', heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
const cfg: Config = { services: [
  { ...base, name: 'live', port: PORT, health: `http://localhost:${PORT}/health` },
  { ...base, name: 'gone', port: 45852 },
] }

describe('status', () => {
  it('살아있는 프로세스+프로브 통과=UP, 기록 없음=DOWN, exit 1', async () => {
    const runPath = join(mkdtempSync(join(tmpdir(), 'orca-st-')), 'run.json')
    writeFileSync(runPath, JSON.stringify({ live: { pid: child.pid, owner: 0 } }))
    const r = await statusReport({ cfg, runPath })
    const live = r.rows.find(x => x.name === 'live')!
    expect(live.status).toBe('UP')
    expect(live.owner).toBe('headless')
    expect(r.rows.find(x => x.name === 'gone')!.status).toBe('DOWN')
    expect(r.exitCode).toBe(1)
  })
  it('전부 UP이면 exit 0', async () => {
    const runPath = join(mkdtempSync(join(tmpdir(), 'orca-st-')), 'run.json')
    writeFileSync(runPath, JSON.stringify({ live: { pid: child.pid, owner: 0 } }))
    const one: Config = { services: [cfg.services[0]] }
    expect((await statusReport({ cfg: one, runPath })).exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/procctl.test.ts test/status.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/procctl.ts` — run.json 부분 교체:

```ts
export interface RunEntry { pid: number; owner: number }

export function readRunEntries(path = RUN_PATH): Record<string, RunEntry> {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
  const out: Record<string, RunEntry> = {}
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v === 'number') out[name] = { pid: v, owner: -1 }                       // v1 레거시
    else if (v && typeof v === 'object' && typeof (v as RunEntry).pid === 'number') {
      out[name] = { pid: (v as RunEntry).pid, owner: typeof (v as RunEntry).owner === 'number' ? (v as RunEntry).owner : -1 }
    }
  }
  return out
}
function writeRunEntries(r: Record<string, RunEntry>, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(r, null, 2))
}

export function recordStart(name: string, pid: number, path = RUN_PATH, owner = process.pid): void {
  const r = readRunEntries(path); r[name] = { pid, owner }; writeRunEntries(r, path)
}
export function recordStop(name: string, path = RUN_PATH): void {
  const r = readRunEntries(path); delete r[name]; writeRunEntries(r, path)
}
/** 소유 세션이 죽었고(단 headless=0 제외) 프로세스는 살아있는 항목 = 진짜 고아 */
export function findOrphans(path = RUN_PATH): { name: string; pid: number }[] {
  return Object.entries(readRunEntries(path))
    .filter(([, e]) => isAlive(e.pid) && e.owner !== 0 && !(e.owner > 0 && isAlive(e.owner)))
    .map(([name, e]) => ({ name, pid: e.pid }))
}
/** 살아있는 다른 orca 세션들이 관리 중인 서비스 */
export function activeSessions(path = RUN_PATH): { owner: number; services: { name: string; pid: number }[] }[] {
  const by = new Map<number, { name: string; pid: number }[]>()
  for (const [name, e] of Object.entries(readRunEntries(path))) {
    if (e.owner > 0 && e.owner !== process.pid && isAlive(e.owner) && isAlive(e.pid)) {
      if (!by.has(e.owner)) by.set(e.owner, [])
      by.get(e.owner)!.push({ name, pid: e.pid })
    }
  }
  return [...by.entries()].map(([owner, services]) => ({ owner, services }))
}
```
(기존 readRun/writeRun 제거. 기존 procctl 테스트의 `recordStart('svc-a', process.pid, file)` 호출부는 그대로 동작 — findOrphans의 svc-a는 owner=process.pid(살아있음)라 이제 고아가 아니므로, **기존 'run.json에 시작/중지를 기록하고 고아를 찾는다' 테스트는 v2 의미에 맞게 교체**한다: Step 1의 새 테스트들이 그 대체다. 낡은 테스트는 삭제.)

`src/status.ts` 신규:

```ts
import { loadConfig } from './config.js'
import { readRunEntries, isAlive } from './procctl.js'
import { httpUp, portListening } from './health.js'
import type { Config } from './types.js'

export interface StatusRow { name: string; port: number; status: 'UP' | 'NO-RESPONSE' | 'DOWN'; pid?: number; owner?: string }

export async function statusReport(opts: { cfg: Config; runPath?: string }): Promise<{ rows: StatusRow[]; exitCode: number }> {
  const entries = readRunEntries(opts.runPath as never ?? undefined)
  const rows: StatusRow[] = []
  for (const s of opts.cfg.services) {
    const rec = entries[s.name]
    const alive = rec !== undefined && isAlive(rec.pid)
    if (!alive) { rows.push({ name: s.name, port: s.port, status: 'DOWN' }); continue }
    const probeOk = s.health ? await httpUp(s.health) : await portListening(s.port)
    const owner = rec.owner === 0 ? 'headless' : rec.owner > 0 && isAlive(rec.owner) ? `세션 ${rec.owner}` : '불명'
    rows.push({ name: s.name, port: s.port, status: probeOk ? 'UP' : 'NO-RESPONSE', pid: rec.pid, owner })
  }
  return { rows, exitCode: rows.every(r => r.status === 'UP') ? 0 : 1 }
}

export async function runStatus(json: boolean): Promise<void> {
  const cfg = loadConfig()
  const { rows, exitCode } = await statusReport({ cfg })
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    for (const r of rows) {
      const pid = r.pid ? `pid ${r.pid}` : ''
      const owner = r.owner ? `(${r.owner})` : ''
      console.log(`${r.name.padEnd(16)} ${r.status.padEnd(12)} :${String(r.port).padStart(5)}  ${pid} ${owner}`.trimEnd())
    }
  }
  process.exitCode = exitCode
}
```
주의: `readRunEntries(opts.runPath as never ?? undefined)` 는 오타 유발 — 실제 구현은 `opts.runPath === undefined ? readRunEntries() : readRunEntries(opts.runPath)` 로 명확하게 쓸 것.

`src/cli.ts` — setup 분기 다음에:

```ts
  if (arg === 'status') {
    const { runStatus } = await import('./status.js')
    try { await runStatus(process.argv[3] === '--json') }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
```

`src/app.ts` 고아 블록 교체:

```ts
  const sessions = activeSessions()
  if (sessions.length > 0) {
    for (const s of sessions) {
      console.log(`이미 다른 터미널(PID ${s.owner})에서 관리 중: ${s.services.map(x => x.name).join(', ')} — 상태만 보려면 orca status`)
    }
  }
  const orphans = findOrphans()
  if (orphans.length > 0) {
    // ... 기존 프롬프트 그대로 ...
  }
```
(import에 activeSessions 추가)

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린 (supervisor 테스트는 recordStart 기본 owner로 계속 동작해야 함)

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: orca status(--json)와 run.json 세션 소유 구분"`

---

### Task 7: `--help` + 예약어 정책 + `orca groups` (스펙 P1-1)

**Files:**
- Modify: `src/config.ts`, `src/cli.ts`, `src/add.ts`
- Test: `test/cli-help.test.ts` (신규), `test/add.test.ts`

**Interfaces:**
- Consumes: 기존 loadConfig.
- Produces:
  - `config.ts`: `export const RESERVED_WORDS = ['add', 'setup', 'status', 'up', 'down', 'start', 'stop', 'remove', 'groups', 'help'] as const`
  - `cli.ts`: `export function helpText(): string` — 아래 정확한 구조. `export function groupSummary(cfg: Config): string[]` — `tspay (3개: eis-server, tspay-gw, bank-apr)` 형식. main()에서 `--help|-h|help` → helpText 출력, `groups` → groupSummary 출력(설정 없으면 ConfigError 메시지), 그룹 인자 trim, 그룹 미존재 시 `그룹 'x'이(가) 없습니다. 등록된 그룹: a, b`.
  - `add.ts`: 그룹 입력이 RESERVED_WORDS면 즉시 거부 (validateGroupName 함수).

helpText 내용 (정확히 이 구조 — 명령 목록은 이 시점 기준, Task 11/12 명령 포함해 미리 기재):

```
orca — 로컬 서비스 절약 실행기

처음이라면 (첫 10분):
  orca setup            최초 1회: Defender 예외 등록·환경 점검
  orca add              서비스 등록 (대화형)
  orca                  대시보드 실행

대시보드:
  orca [그룹]           전체 또는 그룹만 표시
  키: [↑↓]선택 [s]시작/중지 [a]전체시작 [l]로그 [m]수집 [q]종료

자동화·조회:
  orca status [--json]  TUI 없이 상태 확인 (전부 UP=exit 0)
  orca up [그룹]        headless 일괄 시작
  orca down [그룹] --yes  headless 일괄 종료 (--yes 없으면 대상만 표시)
  orca start|stop <이름>  개별 시작/종료
  orca groups           그룹 목록
  orca remove [이름]    서비스 등록 해제

예약어(그룹명 사용 불가): add setup status up down start stop remove groups help
```

- [ ] **Step 1: 실패하는 테스트**

`test/cli-help.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest'
import { helpText, groupSummary } from '../src/cli.js'
import type { Config } from '../src/types.js'

const base = { kind: 'command' as const, dir: 'C:\\x', run: 'r', heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }

describe('help/groups', () => {
  it('helpText: 첫 10분 경로와 자동화 섹션이 분리돼 있다', () => {
    const h = helpText()
    expect(h).toContain('처음이라면')
    expect(h).toContain('자동화·조회')
    expect(h).toContain('orca setup')
    expect(h).toContain('예약어')
  })
  it('groupSummary: 그룹별 서비스 수와 이름', () => {
    const cfg: Config = { services: [
      { ...base, name: 'a', port: 1, group: 'tspay' },
      { ...base, name: 'b', port: 2, group: 'tspay' },
      { ...base, name: 'c', port: 3 },
    ] }
    const g = groupSummary(cfg)
    expect(g.some(l => l.includes('tspay') && l.includes('2개') && l.includes('a'))).toBe(true)
    expect(g.some(l => l.includes('(그룹 없음)') && l.includes('c'))).toBe(true)
  })
})
```

`test/add.test.ts`에 추가:

```ts
import { validateGroupName } from '../src/add.js'   // import 병합

  it('validateGroupName: 예약어 그룹 거부', () => {
    expect(validateGroupName('tspay')).toBeNull()
    expect(validateGroupName('status')).toMatch(/예약어/)
    expect(validateGroupName('help')).toMatch(/예약어/)
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/cli-help.test.ts test/add.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/config.ts`에 `RESERVED_WORDS` export 추가 (위 목록 그대로).

`src/cli.ts` — helpText/groupSummary export + main 분기 확장:

```ts
import type { Config } from './types.js'
import { loadConfig, ConfigError, RESERVED_WORDS } from './config.js'

export function helpText(): string {
  return [
    'orca — 로컬 서비스 절약 실행기', '',
    '처음이라면 (첫 10분):',
    '  orca setup            최초 1회: Defender 예외 등록·환경 점검',
    '  orca add              서비스 등록 (대화형)',
    '  orca                  대시보드 실행', '',
    '대시보드:',
    '  orca [그룹]           전체 또는 그룹만 표시',
    '  키: [↑↓]선택 [s]시작/중지 [a]전체시작 [l]로그 [m]수집 [q]종료', '',
    '자동화·조회:',
    '  orca status [--json]  TUI 없이 상태 확인 (전부 UP=exit 0)',
    '  orca up [그룹]        headless 일괄 시작',
    '  orca down [그룹] --yes  headless 일괄 종료 (--yes 없으면 대상만 표시)',
    '  orca start|stop <이름>  개별 시작/종료',
    '  orca groups           그룹 목록',
    '  orca remove [이름]    서비스 등록 해제', '',
    `예약어(그룹명 사용 불가): ${RESERVED_WORDS.join(' ')}`,
  ].join('\n')
}

export function groupSummary(cfg: Config): string[] {
  const by = new Map<string, string[]>()
  for (const s of cfg.services) {
    const g = s.group ?? '(그룹 없음)'
    if (!by.has(g)) by.set(g, [])
    by.get(g)!.push(s.name)
  }
  return [...by.entries()].map(([g, names]) => `${g} (${names.length}개: ${names.join(', ')})`)
}
```

main() 분기 (`--version` 다음):

```ts
  if (arg === '--help' || arg === '-h' || arg === 'help') { console.log(helpText()); return }
  if (arg === 'groups') {
    try { for (const l of groupSummary(loadConfig())) console.log(l) }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
```

대시보드 진입부의 그룹 필터를 trim + 목록 안내로 교체:

```ts
    const group = arg?.trim()
    const services = group ? cfg.services.filter(s => s.group === group) : cfg.services
    if (services.length === 0) {
      if (group) {
        const known = [...new Set(cfg.services.map(s => s.group).filter(Boolean))]
        console.error(`그룹 '${group}'이(가) 없습니다.${known.length ? ` 등록된 그룹: ${known.join(', ')}` : ''}`)
      } else console.error('등록된 서비스가 없습니다')
      process.exitCode = 1
      return
    }
```

`src/add.ts`:

```ts
import { CONFIG_PATH, ORCA_HOME, loadConfigFromString, RESERVED_WORDS } from './config.js'

export function validateGroupName(g: string): string | null {
  return (RESERVED_WORDS as readonly string[]).includes(g) ? `'${g}'은(는) 예약어라 그룹명으로 쓸 수 없습니다` : null
}
```
runAdd의 그룹 처리에서 `resolveGroup` 적용 전에 `validateGroupName` 실패 시 재질문(askValid 패턴에 편입).

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. cli.ts는 top-level `void main()`이 있으므로 helpText import 시 main이 실행되지 않도록 **주의**: 현재 구조상 import만으로 main()이 돈다. 해결: `const arg = process.argv[2]`를 main 안으로 유지하고, 파일 끝을 `if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) void main()` 으로 감싸 direct-run일 때만 실행한다. (vitest import 시 main 미실행 확인 필수 — 테스트가 이를 검증한다: import가 성공하고 콘솔 부작용이 없어야 함)

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: --help/groups와 예약어 정책"`

---

### Task 8: 로그 뷰 마감 (스펙 P1-6)

**Files:**
- Modify: `src/tui/logView.ts`, `src/app.ts`
- Test: `test/logview.test.ts` (신규)

**Interfaces:**
- Produces:
  - `logView.ts`: `maxOffset(file: string, rows: number): number` — `Math.max(0, tailLines(file, 500).length - (rows - 1))`. `logViewLines`는 offset을 내부에서 `Math.min(offset, maxOffset(...))`으로 클램프하고, 헤더를 ` LOG: <name> [최신] (↑↓ 스크롤, Esc/q 복귀)` 또는 스크롤 중 ` LOG: <name> [-N줄] (↓ 최신으로, Esc/q 복귀)` 로. 파일이 없거나 비었으면 본문 1줄 `(기록된 로그가 없습니다)`.
  - `app.ts`: up 키가 `logOffset = Math.min(logOffset + 1, maxOffset(file, rows))` — 렌더와 같은 헬퍼 사용 (협의회 필수 요건: 상한 계산 단일화).

- [ ] **Step 1: 실패하는 테스트** — `test/logview.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest'
import { logViewLines, maxOffset } from '../src/tui/logView.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = () => mkdtempSync(join(tmpdir(), 'orca-lv-'))

describe('logView', () => {
  it('maxOffset: 전체 줄 수 - 표시 줄 수', () => {
    const f = join(dir(), 'a.log')
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n')
    expect(maxOffset(f, 6)).toBe(5)     // 10줄, 화면 5줄(rows-1) → 최대 5
    expect(maxOffset(f, 100)).toBe(0)
  })
  it('offset이 상한을 넘어도 빈 화면이 되지 않는다', () => {
    const f = join(dir(), 'b.log')
    writeFileSync(f, 'one\ntwo\nthree\n')
    const lines = logViewLines('svc', f, 3, 999)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]).toBe('one')        // 가장 오래된 줄에서 클램프
    expect(lines[0]).toContain('[-')
  })
  it('빈/없는 로그는 안내 문구', () => {
    const lines = logViewLines('svc', join(dir(), 'none.log'), 5, 0)
    expect(lines[1]).toContain('기록된 로그가 없습니다')
    expect(lines[0]).toContain('[최신]')
  })
  it('최신 위치 헤더', () => {
    const f = join(dir(), 'c.log')
    writeFileSync(f, 'x\n')
    expect(logViewLines('svc', f, 5, 0)[0]).toContain('[최신]')
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/logview.test.ts` → FAIL

- [ ] **Step 3: 구현** — `src/tui/logView.ts` 교체:

```ts
import { tailLines } from '../logs.js'

export function maxOffset(file: string, rows: number): number {
  return Math.max(0, tailLines(file, 500).length - (rows - 1))
}

export function logViewLines(name: string, file: string, rows: number, offset: number, width = 160): string[] {
  const all = tailLines(file, 500)
  const capped = Math.min(offset, Math.max(0, all.length - (rows - 1)))
  const pos = capped === 0 ? '[최신]' : `[-${capped}줄]`
  const keys = capped === 0 ? '(↑↓ 스크롤, Esc/q 복귀)' : '(↓ 최신으로, Esc/q 복귀)'
  const header = ` LOG: ${name} ${pos} ${keys}`
  if (all.length === 0) return [header, '(기록된 로그가 없습니다)']
  const end = Math.max(0, all.length - capped)
  const start = Math.max(0, end - (rows - 1))
  return [header, ...all.slice(start, end).map(l => l.slice(0, width))]
}
```

`src/app.ts` 로그 뷰 up 처리 교체 (import에 maxOffset 추가):

```ts
      else if (k === 'up') {
        const name = sup.states()[sel].def.name
        logOffset = Math.min(logOffset + 1, maxOffset(logPathFor(name), process.stdout.rows || 30))
      }
```

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: 로그 뷰 스크롤 상한·위치 표시·빈 로그 안내"`

---

### Task 9: 키 인체공학 — 번호 이동·Enter·r 재시작 (스펙 P1-5)

**Files:**
- Modify: `src/tui/keys.ts`, `src/tui/dashboard.ts`, `src/app.ts`
- Test: `test/tui.test.ts`, `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 3의 confirmQuit 게이트(확인 대기 중 다른 키는 취소만 — 이미 구현됨. 신규 키들도 자동으로 게이트에 걸린다는 것을 리뷰에서 확인).
- Produces:
  - `keys.ts`: Key 유니온에 `'r'` 추가, parseKey가 `'r'`/'R' 처리. `export function parseDigit(b: Buffer): number | null` — '1'~'9'만 해당 숫자, 그 외 null.
  - `dashboard.ts`: 행 앞에 표시 번호 — `${cur}${i < 9 ? String(i + 1) : ' '} ${icon} ...` (보이는 순서 기준 1~9, 10번째 이후는 공백).
  - `app.ts`: 대시보드에서 parseDigit(b)가 k(=1~9)이고 k <= 서비스 수면 `sel = k - 1`. `enter`는 `s`와 동일 동작. `r`은 재시작: `void (async () => { await sup.stop(name); await sup.start(name) })()`.
  - help 줄 갱신: ` [↑↓/1-9]선택 [s/Enter]시작/중지 [r]재시작 [a]전체 [l]로그 [m]수집 [q]종료`

- [ ] **Step 1: 실패하는 테스트**

`test/tui.test.ts`에 추가:

```ts
import { parseKey, parseDigit } from '../src/tui/keys.js'   // import 교체

  it('r 키와 숫자 키를 파싱한다', () => {
    expect(parseKey(Buffer.from('r'))).toBe('r')
    expect(parseKey(Buffer.from('R'))).toBe('r')
    expect(parseDigit(Buffer.from('3'))).toBe(3)
    expect(parseDigit(Buffer.from('0'))).toBeNull()
    expect(parseDigit(Buffer.from('a'))).toBeNull()
  })
```

`test/dashboard.test.ts`에 추가:

```ts
  it('행에 표시 번호가 붙는다 (1~9, 이후 공백)', () => {
    const many = Array.from({ length: 10 }, (_, i) => st({ name: `s${i}`, status: 'DOWN' as const, port: 1000 + i }))
    const lines = dashboardLines(many, SYS, { sel: 0, statsOn: false, color: false })
    expect(lines[2]).toMatch(/^>1 /)
    expect(lines[3]).toMatch(/^ 2 /)
    expect(lines[11]).toMatch(/^ {2}○|^ {2}/)   // 10번째: 번호 없음
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/tui.test.ts test/dashboard.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/tui/keys.ts`:

```ts
export type Key = 'up' | 'down' | 'enter' | 'esc' | 's' | 'a' | 'l' | 'm' | 'q' | 'r' | 'other'

export function parseKey(b: Buffer): Key {
  const s = b.toString('utf8')
  if (s === '\x1b[A') return 'up'
  if (s === '\x1b[B') return 'down'
  if (s === '\r') return 'enter'
  if (s === '\x1b') return 'esc'
  if (s === '\x03') return 'q'
  const c = s.toLowerCase()
  if (c === 's' || c === 'a' || c === 'l' || c === 'm' || c === 'q' || c === 'r') return c
  return 'other'
}

export function parseDigit(b: Buffer): number | null {
  const s = b.toString('utf8')
  return /^[1-9]$/.test(s) ? Number(s) : null
}
```

`src/tui/dashboard.ts` rows에서 `${cur}${ICON...}` 앞부분을:
```ts
    const num = i < 9 ? String(i + 1) : ' '
    const plain = truncateRow(`${cur}${num} ${ICON[s.status] ?? '?'} ${name} :${port} ${status}${mem}${cpu}${note}`, width)
```
colorizeRow는 아이콘 위치 기반이라 그대로 동작. help 기본 문구를 위 새 문구로 교체 (Task 3의 confirmQuit 오버라이드 문구는 유지).

`src/app.ts` — 대시보드 키 처리에서 switch 앞에:
```ts
    const digit = view === 'dash' ? parseDigit(b) : null
    if (digit !== null && !confirmQuit) {
      if (digit <= n) { sel = digit - 1; draw() }
      return
    }
```
switch에 추가:
```ts
      case 'enter': /* s와 동일 */ {
        const s2 = sup.states()[sel]
        if (s2.status === 'UP' || s2.status === 'STARTING' || s2.status === 'BUILDING') void sup.stop(s2.def.name)
        else void sup.start(s2.def.name)
        break
      }
      case 'r': {
        const name = sup.states()[sel].def.name
        void (async () => { await sup.stop(name); await sup.start(name) })()
        break
      }
```
(중복을 피하려면 s/enter 공용 함수 `toggleSel()`로 추출해도 좋다 — 동작 동일 조건.)

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. 리뷰 확인 포인트: confirmQuit 대기 중 digit/enter/r가 모두 취소-무시되는가 (Task 3의 게이트가 digit 분기보다 앞서야 함 — `if (confirmQuit && k !== 'q')` 게이트는 parseKey 기반이므로 digit 분기에도 `!confirmQuit` 조건이 위 코드처럼 들어가야 한다).

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: 숫자 키 이동·Enter 토글·r 재시작"`

---

### Task 10: SKIP(IDE) 제외 토글 (스펙 P1-4)

**Files:**
- Modify: `src/types.ts`, `src/supervisor.ts`, `src/tui/keys.ts`, `src/tui/dashboard.ts`, `src/app.ts`
- Test: `test/supervisor.test.ts`, `test/dashboard.test.ts`

**Interfaces:**
- Produces:
  - `types.ts` ServiceState에 `skipped?: boolean; skipPortUp?: boolean` 추가.
  - supervisor: `setSkip(name: string, v: boolean): void` — state.skipped 세팅(+ emit change). `start()`는 skipped면 즉시 return하지 **않고 skip을 해제하고 진행** (협의회: 개별 s로 해제). `startAll()`은 skipped 서비스를 건너뛴다.
  - keys: Key에 `'x'` 추가.
  - dashboard: skipped && status DOWN → 아이콘 `◇`, 상태 텍스트 `SKIP(IDE)`; skipPortUp === false면 상태 `SKIP(!)`에 note `  ⚠ 포트 응답 없음 (IDE에서 내려간 듯)`.
  - app: 대시보드 `x` — 선택 서비스가 UP/STARTING/BUILDING이 아니면 `sup.setSkip(name, !state.skipped)`. tick에서 skipped 서비스만 `portListening(port)` 1회씩 수행해 skipPortUp 갱신 (기존 3초 tick 안 — 새 타이머 금지).
  - help 줄에 `[x]제외` 추가.

- [ ] **Step 1: 실패하는 테스트**

`test/supervisor.test.ts`에 추가:

```ts
  it('setSkip된 서비스는 startAll에서 건너뛰고, 개별 start는 skip을 해제하고 진행한다', async () => {
    sup = new Supervisor(cfg(45861, 45862), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    sup.setSkip('dummy-a', true)
    await sup.startAll()
    expect(sup.states().map(s => s.status)).toEqual(['DOWN', 'UP'])   // a는 건너뜀
    expect(sup.states()[0].skipped).toBe(true)
    await sup.start('dummy-a')                                        // 개별 시작 = 해제 + 시작
    expect(sup.states()[0].status).toBe('UP')
    expect(sup.states()[0].skipped).toBe(false)
  }, 30000)
```

`test/dashboard.test.ts`에 추가:

```ts
  it('SKIP 상태 표시와 포트 비어있음 승격', () => {
    const skipped = st({ status: 'DOWN' }); skipped.skipped = true
    let lines = dashboardLines([skipped], SYS, { sel: 0, statsOn: false, color: false })
    expect(lines[2]).toContain('◇')
    expect(lines[2]).toContain('SKIP(IDE)')
    skipped.skipPortUp = false
    lines = dashboardLines([skipped], SYS, { sel: 0, statsOn: false, color: false })
    expect(lines[2]).toContain('SKIP(!)')
    expect(lines[2]).toContain('포트 응답 없음')
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/supervisor.test.ts test/dashboard.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/types.ts` ServiceState에 두 필드 추가.

`src/supervisor.ts`:
```ts
  setSkip(name: string, v: boolean): void {
    const e = this.entries.get(name)
    if (!e) return
    this.set(e, { skipped: v, skipPortUp: undefined })
  }
```
start() 초입 가드 뒤에: `if (e.state.skipped) this.set(e, { skipped: false, skipPortUp: undefined })`.
startAll() 루프를 `for (const [name, e] of this.entries) { if (e.state.skipped) continue; await this.start(name) }` 로.

`src/tui/keys.ts`: Key 유니온과 parseKey 문자 목록에 `'x'` 추가.

`src/tui/dashboard.ts` — statusCell/아이콘 결정에 skip 우선 분기:
```ts
  // rows 맵 안, 기존 icon/status 계산을 다음으로 대체
    const isSkip = s.skipped === true && (s.status === 'DOWN' || s.status === 'CRASHED' || s.status === 'ERROR')
    const icon = isSkip ? '◇' : (ICON[s.status] ?? '?')
    const statusText = isSkip ? (s.skipPortUp === false ? 'SKIP(!)' : 'SKIP(IDE)') : statusCell(s, now)
    const status = statusText.padEnd(17)
    const note = isSkip && s.skipPortUp === false ? '  ⚠ 포트 응답 없음 (IDE에서 내려간 듯)'
      : s.error ? '  ' + s.error
      : (s.status === 'BUILDING' ? '  (빌드는 수 분 걸릴 수 있음)' : '')
```
(colorizeRow는 SKIP 행에서 아이콘 미일치로 색을 건너뜀 — 허용: SKIP은 무채색이 맞다.)

`src/app.ts`:
- tick 내부(stats 샘플 뒤)에 추가:
```ts
    for (const s of sup.states()) {
      if (s.skipped) s.skipPortUp = await portListening(s.def.port)   // 기존 3초 tick에 편승 (새 타이머 금지)
    }
```
(import에 portListening 추가)
- switch에 `case 'x'`:
```ts
      case 'x': {
        const s3 = sup.states()[sel]
        if (s3.status !== 'UP' && s3.status !== 'STARTING' && s3.status !== 'BUILDING') sup.setSkip(s3.def.name, !s3.skipped)
        break
      }
```
- help 기본 문구에 `[x]제외` 추가 (dashboard.ts의 기본 help 문자열 갱신).

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: x 키 SKIP(IDE) 제외 토글과 포트 감시 승격"`

---

### Task 11: `orca remove` (스펙 P1-7)

**Files:**
- Create: `src/remove.ts`
- Modify: `src/cli.ts`
- Test: `test/remove.test.ts` (신규)

**Interfaces:**
- Consumes: `CONFIG_PATH`, `loadConfigFromString`, yaml Document API.
- Produces:
  - `remove.ts`: `removeService(src: string, name: string): string` (순수) — `doc.deleteIn(['services', name])`, 주석·포맷 보존, 미존재 시 `'x'은(는) 등록돼 있지 않습니다` throw. `runRemove(argv: string[]): Promise<void>` — argv에서 이름/`--yes` 파싱. 이름 없으면 번호 목록 보여주고 선택. `--yes` 없으면 `'x'을(를) 등록 해제할까요? [y/N]` 확인. 성공 시 exit 0, 미존재/거부 시 exitCode 1.
  - `cli.ts`: `if (arg === 'remove') { const { runRemove } = await import('./remove.js'); await runRemove(process.argv.slice(3)); return }`

- [ ] **Step 1: 실패하는 테스트** — `test/remove.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest'
import { removeService } from '../src/remove.js'
import { loadConfigFromString } from '../src/config.js'

const SRC = '# 주석 보존 확인\nservices:\n  keep:\n    kind: command\n    dir: C:\\k\n    run: r\n    port: 1\n  gone:\n    kind: command\n    dir: C:\\g\n    run: r\n    port: 2\n'

describe('removeService', () => {
  it('지정 서비스만 제거하고 주석을 보존한다', () => {
    const out = removeService(SRC, 'gone')
    expect(out).toContain('# 주석 보존 확인')
    const cfg = loadConfigFromString(out)
    expect(cfg.services.map(s => s.name)).toEqual(['keep'])
  })
  it('미등록 이름은 throw', () => {
    expect(() => removeService(SRC, 'nope')).toThrowError(/등록돼 있지 않습니다/)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/remove.test.ts` → FAIL

- [ ] **Step 3: 구현** — `src/remove.ts` 신규:

```ts
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
```

`src/cli.ts` 분기 추가 (status 다음).

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: orca remove — 번호/이름 선택과 확인으로 등록 해제"`

---

### Task 12: 헤드리스 제어 — up/down/start/stop (스펙 P1-2)

**Files:**
- Create: `src/headless.ts`
- Modify: `src/cli.ts`, `src/supervisor.ts`
- Test: `test/headless.test.ts` (신규)

**Interfaces:**
- Consumes: Task 3의 `stopAll` 반환/`killTree` boolean, Task 6의 `readRunEntries/recordStop/isAlive`, Task 7의 예약어 정리된 cli 구조.
- Produces:
  - supervisor 생성자 opts에 `owner?: number` 추가 — recordStart 호출을 `recordStart(name, pid, undefined, this.owner)`로 (기본 process.pid 유지). **headless up은 owner 0으로 스폰**해 세션 소유와 구분한다(협의회 결정: TUI 채택은 P2-1 이연 — headless로 띄운 것은 `orca down`으로 정리).
  - `headless.ts`:
    - `runUp(group: string | undefined): Promise<void>` — 그룹 필터(없으면 전체) Supervisor(owner: 0)로 startAll, 서비스별 결과 한 줄씩(`✔ eis-server UP` / `✖ security ERROR: <사유>`), 전부 UP이면 exit 0 아니면 1. 종료 전 stopAll을 **호출하지 않는다** (의도적 분리 — 프로세스는 남긴다).
    - `runDown(group: string | undefined, yes: boolean): Promise<void>` — run.json에서 대상(그룹 필터, pid 살아있는 것만) 수집. `--yes` 없으면 대상 목록 + `실행하려면 --yes를 붙이세요` 출력 후 exit 0 (dry-run). `--yes`면: 살아있는 다른 세션(owner>0 && alive)이 소유한 항목이 하나라도 있으면 그 목록과 함께 `다른 터미널(PID n)이 관리 중 — 그 터미널에서 종료하세요` 출력 후 exit 1(아무것도 죽이지 않음). 아니면 각 대상 killTree + recordStop, 결과 리포트(killTree false면 `⚠ 종료 실패`), 전부 성공 exit 0.
    - `runStartStop(action: 'start' | 'stop', name: string): Promise<void>` — start: 해당 서비스 1개짜리 Supervisor(owner 0)로 start, UP이면 exit 0. stop: run.json 항목 찾고, 살아있는 세션 소유면 거부(exit 1), 아니면 killTree + recordStop. 이름 미존재 시 `'x'은(는) 등록돼 있지 않습니다` exit 1.
  - `cli.ts` 분기: `up`/`down`은 `process.argv[3]`(그룹, `--yes` 제외) + `--yes` 파싱, `start`/`stop`은 `process.argv[3]` 이름 필수(없으면 usage 한 줄 + exit 1).

- [ ] **Step 1: 실패하는 테스트** — `test/headless.test.ts` 신규 (실프로세스 통합, 더미 서버 픽스처):

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { runUp, runDown } from '../src/headless.js'
import { readRunEntries } from '../src/procctl.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../src/types.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dummy-server.mjs')
const base = { kind: 'command' as const, dir: process.cwd(), heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
const cfg = (p1: number): Config => ({ services: [
  { ...base, name: 'h-a', run: `node "${FIXTURE}" ${p1}`, port: p1, health: `http://localhost:${p1}/health` },
] })

// runUp/runDown은 테스트 주입을 위해 opts로 cfg/runPath/logDir를 받을 수 있어야 한다 (아래 구현 참조)
describe('headless', () => {
  const runPath = join(mkdtempSync(join(tmpdir(), 'orca-hl-')), 'run.json')
  const logDir = mkdtempSync(join(tmpdir(), 'orca-hl-'))

  afterEach(async () => { await runDown(undefined, true, { cfg: cfg(45871), runPath, logDir }) })

  it('up은 서비스를 남기고 종료하며 owner=0으로 기록한다', async () => {
    await runUp(undefined, { cfg: cfg(45871), runPath, logDir })
    const r = readRunEntries(runPath)
    expect(r['h-a']).toBeDefined()
    expect(r['h-a'].owner).toBe(0)
    expect(process.exitCode ?? 0).toBe(0)
    process.exitCode = 0
  }, 30000)

  it('down은 --yes 없으면 dry-run, --yes면 종료하고 기록을 지운다', async () => {
    await runUp(undefined, { cfg: cfg(45871), runPath, logDir })
    await runDown(undefined, false, { cfg: cfg(45871), runPath, logDir })   // dry-run
    expect(readRunEntries(runPath)['h-a']).toBeDefined()                     // 아직 살아있음
    await runDown(undefined, true, { cfg: cfg(45871), runPath, logDir })
    expect(readRunEntries(runPath)['h-a']).toBeUndefined()
    process.exitCode = 0
  }, 30000)
})
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/headless.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/supervisor.ts`: 필드 `private owner: number` — `opts?.owner ?? process.pid`; recordStart 호출을 `recordStart(name, pid, undefined, this.owner)`로.

`src/headless.ts` 신규:

```ts
import { Supervisor } from './supervisor.js'
import { loadConfig } from './config.js'
import { readRunEntries, recordStop, killTree, isAlive } from './procctl.js'
import type { Config } from './types.js'

interface HeadlessOpts { cfg?: Config; runPath?: string; logDir?: string }

function pick(cfg: Config, group?: string): Config {
  const services = group ? cfg.services.filter(s => s.group === group) : cfg.services
  return { services }
}
function entries(runPath?: string) {
  return runPath === undefined ? readRunEntries() : readRunEntries(runPath)
}

export async function runUp(group: string | undefined, opts: HeadlessOpts = {}): Promise<void> {
  const cfg = pick(opts.cfg ?? loadConfig(), group)
  if (cfg.services.length === 0) { console.error(group ? `그룹 '${group}'에 서비스가 없습니다` : '등록된 서비스가 없습니다'); process.exitCode = 1; return }
  const sup = new Supervisor(cfg, { owner: 0, logDir: opts.logDir, runPath: opts.runPath } as never)
  await sup.startAll()
  let ok = true
  for (const s of sup.states()) {
    if (s.status === 'UP') console.log(`✔ ${s.def.name} UP (:${s.def.port})`)
    else { ok = false; console.log(`✖ ${s.def.name} ${s.status}${s.error ? `: ${s.error}` : ''}`) }
  }
  process.exitCode = ok ? 0 : 1
}

export async function runDown(group: string | undefined, yes: boolean, opts: HeadlessOpts = {}): Promise<void> {
  const cfg = pick(opts.cfg ?? loadConfig(), group)
  const names = new Set(cfg.services.map(s => s.name))
  const all = entries(opts.runPath)
  const targets = Object.entries(all).filter(([n, e]) => names.has(n) && isAlive(e.pid))
  if (targets.length === 0) { console.log('종료할 실행 중 서비스가 없습니다'); return }
  if (!yes) {
    console.log('종료 대상 (dry-run):')
    for (const [n, e] of targets) console.log(`  - ${n} (PID ${e.pid})`)
    console.log('실행하려면 --yes를 붙이세요')
    return
  }
  const foreign = targets.filter(([, e]) => e.owner > 0 && isAlive(e.owner))
  if (foreign.length > 0) {
    for (const [n, e] of foreign) console.error(`✖ ${n}은(는) 다른 터미널(PID ${e.owner})이 관리 중 — 그 터미널에서 종료하세요`)
    process.exitCode = 1
    return
  }
  let ok = true
  for (const [n, e] of targets) {
    const done = await killTree(e.pid)
    if (done) { opts.runPath === undefined ? recordStop(n) : recordStop(n, opts.runPath); console.log(`✔ ${n} 종료`) }
    else { ok = false; console.error(`⚠ ${n} 종료 실패 (PID ${e.pid})`) }
  }
  process.exitCode = ok ? 0 : 1
}

export async function runStartStop(action: 'start' | 'stop', name: string, opts: HeadlessOpts = {}): Promise<void> {
  const cfg = opts.cfg ?? loadConfig()
  const svc = cfg.services.find(s => s.name === name)
  if (!svc) { console.error(`'${name}'은(는) 등록돼 있지 않습니다`); process.exitCode = 1; return }
  if (action === 'start') {
    await runUp(undefined, { ...opts, cfg: { services: [svc] } })
  } else {
    await runDown(undefined, true, { ...opts, cfg: { services: [svc] } })
  }
}
```

**중요 — supervisor에 runPath 전달**: 위에서 `runPath: opts.runPath } as never`는 임시 표기다. 실제 구현은 Supervisor opts에 `runPath?: string`을 정식 추가하고, recordStart/recordStop 호출을 `recordStart(name, pid, this.runPath, this.owner)` / `recordStop(name, this.runPath)` 형태로 일관되게 바꾼다 (this.runPath 기본 undefined → procctl 기본 경로). `as never` 캐스팅 금지.

`src/cli.ts` 분기 (remove 다음):

```ts
  if (arg === 'up' || arg === 'down') {
    const { runUp, runDown } = await import('./headless.js')
    const rest = process.argv.slice(3)
    const yes = rest.includes('--yes')
    const group = rest.find(a => a !== '--yes')
    try { arg === 'up' ? await runUp(group) : await runDown(group, yes) }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
  if (arg === 'start' || arg === 'stop') {
    const name = process.argv[3]
    if (!name) { console.error(`사용법: orca ${arg} <이름>`); process.exitCode = 1; return }
    const { runStartStop } = await import('./headless.js')
    try { await runStartStop(arg, name) }
    catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exitCode = 1 } else throw e }
    return
  }
```

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. `as never`가 코드에 남아있으면 안 된다.

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: headless up/down/start/stop (down은 dry-run 기본)"`

---

### Task 13: 세션 재개 + README 갱신 (스펙 P1-3)

**Files:**
- Create: `src/session.ts`
- Modify: `src/supervisor.ts`, `src/app.ts`, `src/tui/keys.ts`, `src/tui/dashboard.ts`, `src/headless.ts`, `README.md`
- Test: `test/session.test.ts` (신규), `test/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 12의 headless runUp.
- Produces:
  - `session.ts`: `interface LastSession { savedAt: number; services: { name: string; status: string }[] }`, `writeLastSession(states: { name: string; status: string }[], path?): void` (기본 `~\.orca\last-session.json`), `readLastSession(path?): LastSession | null`, `resumeSet(s: LastSession | null, cfg: Config): string[]` — UP/STARTING/BUILDING이었고 현재 config에 존재하는 이름만(삭제된 이름 조용히 필터), `failedSet(...)` — CRASHED/ERROR였던 이름.
  - supervisor: `startMany(names: string[]): Promise<void>` — 순차 start + spring dir dedup gradleStop (startAll과 같은 마무리. startAll을 `startMany(전체이름)` 위임으로 리팩터링해 중복 제거).
  - keys: Key에 `'u'` 추가.
  - app: quit()에서 stopAll **직전** 상태 스냅샷을 writeLastSession. 시작 시 readLastSession → resumeSet 비어있지 않으면 대시보드 helpOverride 자리 위에 배너 라인(dashboardLines opts에 `banner?: string` 추가 — head 다음 줄에 삽입): `지난 세션: N개 실행 중이었음 — [u] 재개` + failedSet 있으면 ` / 실패했던 서비스: x (l로 사유 확인)`. `u` 키 → `void sup.startMany(resume)` + 배너 제거. 아무 시작 동작(a/s/enter/digit-start) 후에도 배너 제거.
  - headless runUp: `group === undefined`이고 opts.cfg 미주입이며 last-session이 존재하면 resumeSet을 대상으로 (비면 전체). `--all`이 rest에 있으면 무조건 전체.
  - README: 키 목록( x/r/u/숫자/Enter ), 새 명령(status/up/down/start/stop/remove/groups/--help), SKIP·세션 재개·소유 세션 동작 설명 반영.

- [ ] **Step 1: 실패하는 테스트**

`test/session.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest'
import { writeLastSession, readLastSession, resumeSet, failedSet } from '../src/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/types.js'

const base = { kind: 'command' as const, dir: 'C:\\x', run: 'r', heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
const cfg: Config = { services: [{ ...base, name: 'a', port: 1 }, { ...base, name: 'b', port: 2 }] }

describe('session', () => {
  it('스냅샷 라운드트립과 재개/실패 세트 계산', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'orca-ss-')), 'last-session.json')
    writeLastSession([
      { name: 'a', status: 'UP' }, { name: 'b', status: 'CRASHED' }, { name: 'deleted', status: 'UP' },
    ], p)
    const s = readLastSession(p)
    expect(s).not.toBeNull()
    expect(resumeSet(s, cfg)).toEqual(['a'])          // CRASHED 제외, 삭제된 이름 필터
    expect(failedSet(s, cfg)).toEqual(['b'])
  })
  it('파일 없으면 null, resumeSet은 빈 배열', () => {
    expect(readLastSession(join(mkdtempSync(join(tmpdir(), 'orca-ss-')), 'x.json'))).toBeNull()
    expect(resumeSet(null, cfg)).toEqual([])
  })
})
```

`test/supervisor.test.ts`에 추가:

```ts
  it('startMany는 지정한 이름만 시작한다', async () => {
    sup = new Supervisor(cfg(45881, 45882), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.startMany(['dummy-b'])
    expect(sup.states().map(s => s.status)).toEqual(['DOWN', 'UP'])
  }, 30000)
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/session.test.ts test/supervisor.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/session.ts` 신규:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ORCA_HOME } from './config.js'
import type { Config } from './types.js'

const SESSION_PATH = join(ORCA_HOME, 'last-session.json')
const RUNNING = new Set(['UP', 'STARTING', 'BUILDING'])
const FAILED = new Set(['CRASHED', 'ERROR'])

export interface LastSession { savedAt: number; services: { name: string; status: string }[] }

export function writeLastSession(services: { name: string; status: string }[], path = SESSION_PATH): void {
  mkdirSync(ORCA_HOME, { recursive: true })
  writeFileSync(path, JSON.stringify({ savedAt: Date.now(), services } satisfies LastSession, null, 2))
}
export function readLastSession(path = SESSION_PATH): LastSession | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as LastSession } catch { return null }
}
export function resumeSet(s: LastSession | null, cfg: Config): string[] {
  if (!s) return []
  const known = new Set(cfg.services.map(x => x.name))
  return s.services.filter(x => RUNNING.has(x.status) && known.has(x.name)).map(x => x.name)
}
export function failedSet(s: LastSession | null, cfg: Config): string[] {
  if (!s) return []
  const known = new Set(cfg.services.map(x => x.name))
  return s.services.filter(x => FAILED.has(x.status) && known.has(x.name)).map(x => x.name)
}
```

`src/supervisor.ts` — startAll을 위임 구조로:

```ts
  async startMany(names: string[]): Promise<void> {
    for (const name of names) {
      const e = this.entries.get(name)
      if (!e || e.state.skipped) continue
      await this.start(name)
    }
    const dirs = new Set(names
      .map(n => this.entries.get(n)?.state.def)
      .filter((d): d is NonNullable<typeof d> => !!d && d.kind === 'spring')
      .map(d => d.dir))
    for (const dir of dirs) await gradleStop(dir)
  }

  async startAll(): Promise<void> {
    await this.startMany([...this.entries.keys()])
  }
```

`src/tui/keys.ts`: `'u'` 추가.

`src/tui/dashboard.ts`: DashOpts에 `banner?: string` — head 바로 다음에 `opts.banner` 줄 삽입 (있을 때만):
```ts
  const out = [head, sep, ...rows, sep, help]
  if (opts.banner) out.splice(1, 0, opts.banner)
  return out
```

`src/app.ts`:
- 시작 시: `const last = readLastSession(); const resume = resumeSet(last, cfg); const failed = failedSet(last, cfg); let banner = resume.length > 0 ? ` 지난 세션: ${resume.length}개 실행 중이었음 — [u] 재개${failed.length ? ` / 실패했던 서비스: ${failed.join(', ')} (l로 사유 확인)` : ''}` : undefined`
- draw()의 dash 분기에 `banner` 전달.
- `u` 키: `case 'u': if (banner) { banner = undefined; void sup.startMany(resume) } break`
- `a`/`s`/`enter`/`r` 처리 뒤 공통으로 `banner = undefined` (시작 동작 후 배너 제거 — case 문 각각에 넣거나 switch 뒤 한 줄).
- quit(): `screen.exit()` 직후, stopAll 이전에 `writeLastSession(sup.states().map(s => ({ name: s.def.name, status: s.status })))`.

`src/headless.ts` runUp: 첫 줄에서

```ts
  let cfg = pick(opts.cfg ?? loadConfig(), group)
  if (!opts.cfg && group === undefined && !process.argv.includes('--all')) {
    const rs = resumeSet(readLastSession(), cfg)
    if (rs.length > 0) {
      const set = new Set(rs)
      cfg = { services: cfg.services.filter(s => set.has(s.name)) }
      console.log(`지난 세션 기준 ${cfg.services.length}개를 시작합니다 (전체는 orca up --all)`)
    }
  }
```
(cli의 up 분기에서 group 파싱 시 `--all`도 `--yes`처럼 제외 목록에 추가)

README 갱신: 사용법 섹션에 새 명령 6종 + 대시보드 키 줄을 새 도움말과 일치시키고, 동작 방식에 SKIP/세션 재개/소유 세션 3줄 추가. helpText()와 문구가 어긋나지 않게 할 것.

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린

- [ ] **Step 5: 수동 검증** — `pnpm dev` 실행 → a로 시작 → q 종료 → 재실행 시 배너 표시 → u로 재개 → q. (데모 설정 기준. 검증 후 상태 정리)

- [ ] **Step 6: 커밋** — `git add -A; git commit -m "feat: 세션 재개(u)와 headless up 기본 대상, README 갱신"`

---

## 계획 셀프리뷰 결과 (작성자 기록)

- 스펙 커버리지: P0-1→T3, P0-2→T1, P0-3→T2, P0-4→T4, P0-5→T6, P1-1→T7, P1-2→T12, P1-3→T13, P1-4→T10, P1-5→T9, P1-6→T8, P1-7→T11, P1-8→T5. 각 항목의 "반대 해소" 조건을 태스크 요건에 명시했다.
- 시그니처 일관성 확인: dashboardLines(states, sys, opts:DashOpts)는 T2에서 도입 후 T3(helpOverride)/T9(번호)/T10(SKIP)/T13(banner)이 opts만 확장. stopAll 반환은 T3 도입, T12가 소비. run.json v2는 T6 도입, T12·T13이 소비. RESERVED_WORDS는 T7 도입, T7의 add에서 소비.
- 알려진 트레이드오프(리뷰어 인지용): ① T12 headless up의 owner=0 프로세스는 TUI가 채택하지 못한다(P2-1 이연 — 포트 점유 ERROR로 표시됨). ② T2 colorizeRow는 status 토큰 탐색 기반이라 SKIP 행 등 미일치 시 무색 — 의도된 동작. ③ T13에서 startAll이 startMany로 위임되면서 skipped 필터가 startMany로 이동 — T10의 startAll 테스트는 계속 통과해야 한다.
