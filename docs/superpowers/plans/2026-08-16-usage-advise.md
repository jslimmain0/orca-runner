# 사용량 기반 설정 추천 + 즉시 적용 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서비스별 실사용량(RSS 피크 + JVM 힙/메타/Full GC)을 세션 간 누적하고, 대시보드 행 표시 + `v` 키 즉시 적용과 `orca advise` 명령으로 heapMb/metaspaceMb 추천을 제공한다.

**Architecture:** 신규 `usage.ts`(jstat 파서 + usage.json 저장소), `advise.ts`(추천 규칙 + 적용 함수), app/dashboard/cli 연결. 수집은 기존 3초 tick 누적 + 1회성 jstat 스냅샷(UP 후 90초 setTimeout 1회, 종료 시 1회)만 — 주기 작업 추가 없음.

**Tech Stack:** 기존 동일. jstat/jcmd는 JDK 동봉 도구(외부 의존성 아님, 없으면 RSS-only 폴백).

**Spec:** 이 문서의 요구사항이 스펙 (대화에서 확정: 대시보드 표시 + 즉시 적용 키 + advise CLI + metaspaceMb 필드, spring 전용 추천).

## Global Constraints

- **새 setInterval 금지.** 허용되는 1회성: UP 후 90초 setTimeout(서비스당 세션당 1회, DOWN 시 취소), quit 시 jstat 1회, `orca advise` 실행 시 1회. 디바운스 선례와 동일한 범주임을 주석으로 명시.
- 추천은 **spring 서비스만** (command는 래퍼 측정 한계로 제외 — 표기는 함).
- 하향 추천은 **관측 세션 2회 이상**일 때만, 상향(위험) 추천은 1회 관측이라도 즉시. 추천 단위: 힙 128MB 스텝(최소 256), 메타 64MB 스텝(최소 128).
- 추천 규칙(고정):
  - 힙: `peakHeapMb / heapMb > 0.9` 또는 `fullGc 세션평균 > 20` → 상향(`max(ceil(peakHeap*1.4/128)*128, heapMb+256)`); `< 0.35` → 하향(`max(256, ceil(peakHeap*1.4/128)*128)`). 결과가 현재값과 같으면 추천 없음.
  - 메타: `metaPeakMb / metaspaceMb > 0.85` → 상향(`ceil(metaPeak*1.3/64)*64`); `< 0.4` → 하향(`max(128, ceil(metaPeak*1.5/64)*64)`). 동일값이면 추천 없음.
- 즉시 적용(`v`)은 **선택된 서비스 1개만**, services.yaml에 주석 보존 쓰기(yaml Document API) 후 실행 중이면 자동 재시작(stop→start). 설정 파일 쓰기는 loadConfigFromString 검증 후.
- jstat 부재/실패는 조용히 무시(해당 층 데이터 없음) — 러너가 죽는 일 없음. jstat 숫자의 `,` 소수점은 `.`로 정규화.
- usage.json 스키마: `{ [name]: { sessions: number; peakRssMb: number; peakHeapMb?: number; peakMetaMb?: number; fgcAvg?: number; updatedAt: string } }` — merge 시 peak류는 max, fgcAvg는 이동평균, sessions +1.
- 예약어에 `advise` 추가. helpText/README/가이드(md+html×2)/services.example 갱신.
- 커밋 conventional, 태스크마다 `pnpm test` 전체 + `tsc --noEmit` 클린(src+test), supervisor 2회 연속.

## File Structure

```
수정: src/types.ts     (T1 — ServiceDef.metaspaceMb)
수정: src/config.ts    (T1 — metaspaceMb 검증·기본 256, defaults.spring.metaspaceMb)
수정: src/spring.ts    (T1 — javaArgs가 metaspaceMb 사용)
생성: src/usage.ts     (T1 — jstat 파서·스냅샷·usage.json 저장소)
생성: src/advise.ts    (T2 — recommend/adviseReport/applyRecommendation)
수정: src/cli.ts       (T2 — advise 분기·helpText·RESERVED_WORDS는 config.ts)
수정: src/app.ts       (T3 — tick 피크 누적·90초 스냅샷·quit 저장·v 키)
수정: src/tui/dashboard.ts (T3 — 권장 행 노트)
수정: src/tui/keys.ts  (T3 — 'v')
문서: docs/user-guide.md·user-guide.html·index.html·services.example.yaml (T3)
테스트: test/usage.test.ts(T1) test/advise.test.ts(T2) test/config·spring·dashboard.test.ts 보강
```

의존: T2는 T1(usage 스키마), T3는 T1+T2. ServiceDef.metaspaceMb가 필수 필드가 되므로 T1에서 테스트 헬퍼 base 리터럴 전부에 `metaspaceMb: 256` 추가(tsc가 잡음).

---

### Task 1: metaspaceMb 필드 + jstat/usage 저장소

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `src/spring.ts`, 테스트 헬퍼 base 리터럴 전부
- Create: `src/usage.ts`
- Test: `test/config.test.ts`, `test/spring.test.ts`, `test/usage.test.ts`(신규)

**Interfaces:**
- `types.ts`: ServiceDef에 `metaspaceMb: number` (config가 항상 채움, spring 기본 256, command 0).
- `config.ts`: BUILTIN에 `metaspaceMb: 256`, defaults.spring에서 오버라이드 가능(posInt 검증), 서비스별 오버라이드(posInt), command base는 0. env와 같은 패턴.
- `spring.ts` javaArgs: `-XX:MaxMetaspaceSize=${def.metaspaceMb}m`.
- `usage.ts`:
  - `parseJstatGc(output: string): { heapUsedKb: number; metaUsedKb: number; fullGc: number; gcTimeSec: number } | null` — 헤더행/값행 파싱(컬럼명 매핑: S0U+S1U+EU+OU 합=heapUsedKb, MU=metaUsedKb, FGC, GCT). `,`→`.` 정규화. 컬럼 누락 시 null.
  - `jstatSnapshot(pid: number): Promise<ReturnType<typeof parseJstatGc>>` — `jstat -gc <pid>` 1회성 execFile, 실패 시 null.
  - `interface UsageEntry { sessions: number; peakRssMb: number; peakHeapMb?: number; peakMetaMb?: number; fgcAvg?: number; updatedAt: string }`
  - `readUsage(path?): Record<string, UsageEntry>` (기본 `~\.orca\usage.json`, 깨짐/null은 `{}`), `mergeSession(usage, name, s: { peakRssMb: number; heapMb?: number; metaMb?: number; fgc?: number }): Record<...>` (peak=max, fgcAvg=이동평균 `(old*(n-1)+new)/n`, sessions+1), `writeUsage(u, path?)`.

- [ ] **Step 1: 실패하는 테스트**

`test/usage.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest'
import { parseJstatGc, readUsage, mergeSession, writeUsage } from '../src/usage.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const JSTAT = ` S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC     YGCT    FGC    FGCT     GCT
 8704.0 8704.0  0.0   6816.0 69952.0  35108.3   175104.0   98230.5  121208.0 115726.0 15736.0 14522.4     42    0.586   3      0.208    0.794`

describe('usage', () => {
  it('parseJstatGc: 힙 합산·메타·FGC·GCT를 뽑는다', () => {
    const r = parseJstatGc(JSTAT)!
    expect(Math.round(r.heapUsedKb)).toBe(Math.round(0 + 6816.0 + 35108.3 + 98230.5))
    expect(r.metaUsedKb).toBeCloseTo(115726.0)
    expect(r.fullGc).toBe(3)
    expect(r.gcTimeSec).toBeCloseTo(0.794)
  })
  it('parseJstatGc: 쉼표 소수점 정규화, 컬럼 누락 시 null', () => {
    expect(parseJstatGc(JSTAT.replace('0.794', '0,794'))!.gcTimeSec).toBeCloseTo(0.794)
    expect(parseJstatGc('S0C S1C\n1 2')).toBeNull()
  })
  it('mergeSession: peak는 max, fgcAvg는 이동평균, sessions 증가', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'orca-us-')), 'usage.json')
    let u = readUsage(p)
    u = mergeSession(u, 'svc', { peakRssMb: 300, heapMb: 200, metaMb: 100, fgc: 2 })
    u = mergeSession(u, 'svc', { peakRssMb: 250, heapMb: 260, metaMb: 90, fgc: 6 })
    writeUsage(u, p)
    const r = readUsage(p)['svc']
    expect(r.sessions).toBe(2)
    expect(r.peakRssMb).toBe(300)
    expect(r.peakHeapMb).toBe(260)
    expect(r.peakMetaMb).toBe(100)
    expect(r.fgcAvg).toBeCloseTo(4)
  })
})
```

`test/config.test.ts`에 추가:

```ts
  it('metaspaceMb: spring 기본 256, 서비스/defaults 오버라이드, 타입 검증', () => {
    const src = `defaults:\n  spring:\n    metaspaceMb: 192\nservices:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n  b:\n    kind: spring\n    dir: C:\\y\n    port: 2\n    metaspaceMb: 384\n`
    const cfg = loadConfigFromString(src)
    expect(cfg.services[0].metaspaceMb).toBe(192)
    expect(cfg.services[1].metaspaceMb).toBe(384)
    const bad = `services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    metaspaceMb: big\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/metaspaceMb/)
  })
```

`test/spring.test.ts`의 javaArgs 기대값을 `-XX:MaxMetaspaceSize=256m` → `` `-XX:MaxMetaspaceSize=${def.metaspaceMb}m` `` 기반으로 갱신(def에 metaspaceMb: 256 추가).

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/usage.test.ts test/config.test.ts` → FAIL. tsc는 헬퍼 미수정 시 에러(수정 대상).

- [ ] **Step 3: 구현** — 인터페이스 절대로. usage.ts 핵심:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ORCA_HOME } from './config.js'

const run = promisify(execFile)
const USAGE_PATH = join(ORCA_HOME, 'usage.json')

export interface JstatGc { heapUsedKb: number; metaUsedKb: number; fullGc: number; gcTimeSec: number }

export function parseJstatGc(output: string): JstatGc | null {
  const lines = output.trim().split(/\r?\n/)
  if (lines.length < 2) return null
  const cols = lines[0].trim().split(/\s+/)
  const vals = lines[1].trim().split(/\s+/).map(v => Number(v.replace(',', '.')))
  const get = (name: string): number | undefined => {
    const i = cols.indexOf(name)
    return i === -1 || Number.isNaN(vals[i]) ? undefined : vals[i]
  }
  const s0u = get('S0U'), s1u = get('S1U'), eu = get('EU'), ou = get('OU')
  const mu = get('MU'), fgc = get('FGC'), gct = get('GCT')
  if (s0u === undefined || s1u === undefined || eu === undefined || ou === undefined || mu === undefined || fgc === undefined || gct === undefined) return null
  return { heapUsedKb: s0u + s1u + eu + ou, metaUsedKb: mu, fullGc: fgc, gcTimeSec: gct }
}

/** 1회성 스폰 (Global Constraints 허용 범주) — jstat 부재/실패는 null */
export async function jstatSnapshot(pid: number): Promise<JstatGc | null> {
  try {
    const { stdout } = await run('jstat', ['-gc', String(pid)], { windowsHide: true, timeout: 5000 })
    return parseJstatGc(stdout)
  } catch { return null }
}

export interface UsageEntry { sessions: number; peakRssMb: number; peakHeapMb?: number; peakMetaMb?: number; fgcAvg?: number; updatedAt: string }

export function readUsage(path = USAGE_PATH): Record<string, UsageEntry> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) ?? {}
    return typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}
export function mergeSession(usage: Record<string, UsageEntry>, name: string,
  s: { peakRssMb: number; heapMb?: number; metaMb?: number; fgc?: number }): Record<string, UsageEntry> {
  const prev = usage[name]
  const sessions = (prev?.sessions ?? 0) + 1
  const entry: UsageEntry = {
    sessions,
    peakRssMb: Math.max(prev?.peakRssMb ?? 0, s.peakRssMb),
    updatedAt: new Date().toISOString(),
  }
  if (s.heapMb !== undefined || prev?.peakHeapMb !== undefined) entry.peakHeapMb = Math.max(prev?.peakHeapMb ?? 0, s.heapMb ?? 0)
  if (s.metaMb !== undefined || prev?.peakMetaMb !== undefined) entry.peakMetaMb = Math.max(prev?.peakMetaMb ?? 0, s.metaMb ?? 0)
  if (s.fgc !== undefined) entry.fgcAvg = prev?.fgcAvg === undefined ? s.fgc : (prev.fgcAvg * (sessions - 1) + s.fgc) / sessions
  else if (prev?.fgcAvg !== undefined) entry.fgcAvg = prev.fgcAvg
  return { ...usage, [name]: entry }
}
export function writeUsage(u: Record<string, UsageEntry>, path = USAGE_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(u, null, 2))
}
```
config.ts: BUILTIN `{ heapMb: 512, cpus: 2, priority: 'belowNormal', metaspaceMb: 256 }`; defaults 검증에 metaspaceMb posInt; 서비스 검증에 metaspaceMb posInt; command base에 `metaspaceMb: 0`; push에 `metaspaceMb: (s.metaspaceMb as number|undefined) ?? base.metaspaceMb`.

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린(헬퍼 base에 metaspaceMb 추가 완료 상태), supervisor 2회.
- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: metaspaceMb 설정과 jstat/usage 수집 기반"`

---

### Task 2: 추천 규칙 + orca advise

**Files:**
- Create: `src/advise.ts`
- Modify: `src/config.ts`(RESERVED_WORDS에 'advise'), `src/cli.ts`(advise 분기 + helpText 자동화 섹션에 1줄)
- Test: `test/advise.test.ts`(신규), `test/cli-help.test.ts` 기대 갱신 필요 시

**Interfaces:**
- `advise.ts`:
  - `interface Recommendation { heapMb?: number; metaspaceMb?: number; reasons: string[] }`
  - `recommend(def: ServiceDef, u: UsageEntry | undefined): Recommendation | null` — Global Constraints의 규칙 그대로. command/데이터 없음/변화 없음 → null. 하향은 u.sessions >= 2 필수.
  - `adviseLines(cfg: Config, usage: Record<string, UsageEntry>, live?: Record<string, JstatGc | null>): string[]` — 서비스별 한 블록. live가 있으면 현재값 병기. command는 `(측정 제외 — command)` 한 줄.
  - `applyRecommendation(src: string, name: string, rec: Recommendation): string` (순수) — yaml Document API로 heapMb/metaspaceMb setIn(있는 값만), 주석 보존, 반환 전 loadConfigFromString 검증. 미등록 이름 throw.
  - `runAdvise(): Promise<void>` — loadConfig + readUsage + 실행 중 spring 서비스(run.json alive)에 jstatSnapshot 1회씩 → adviseLines 출력. 항상 exit 0 (추천은 정보).
- `cli.ts`: `advise` 분기 (groups 분기 옆), helpText 자동화 섹션에 `  orca advise           사용량 기반 heapMb/metaspaceMb 추천` 추가.

- [ ] **Step 1: 실패하는 테스트** — `test/advise.test.ts` 신규:

```ts
import { describe, it, expect } from 'vitest'
import { recommend, applyRecommendation } from '../src/advise.js'
import { loadConfigFromString } from '../src/config.js'
import type { ServiceDef } from '../src/types.js'

const springDef = (over: Partial<ServiceDef> = {}): ServiceDef => ({
  name: 'a', kind: 'spring', dir: 'C:\\x', port: 1,
  heapMb: 512, cpus: 2, priority: 'belowNormal', jvmArgs: [], env: {}, metaspaceMb: 256, ...over,
})
const entry = (over: object) => ({ sessions: 3, peakRssMb: 400, updatedAt: 'x', ...over })

describe('recommend', () => {
  it('힙 90% 초과 → 상향', () => {
    const r = recommend(springDef(), entry({ peakHeapMb: 480 }))!
    expect(r.heapMb).toBeGreaterThan(512)
  })
  it('힙 35% 미만 + 세션 2회 이상 → 하향 (128 스텝, 최소 256)', () => {
    const r = recommend(springDef(), entry({ peakHeapMb: 100 }))!
    expect(r.heapMb).toBe(256)
  })
  it('세션 1회면 하향 추천 안 함, 상향은 함', () => {
    expect(recommend(springDef(), entry({ sessions: 1, peakHeapMb: 100 }))).toBeNull()
    expect(recommend(springDef(), entry({ sessions: 1, peakHeapMb: 500 }))).not.toBeNull()
  })
  it('Full GC 빈발 → 힙 상향', () => {
    const r = recommend(springDef(), entry({ peakHeapMb: 300, fgcAvg: 35 }))!
    expect(r.heapMb).toBeGreaterThan(512)
    expect(r.reasons.join()).toMatch(/GC/)
  })
  it('메타 85% 초과 → 상향, 40% 미만 → 하향(최소 128)', () => {
    expect(recommend(springDef(), entry({ peakMetaMb: 230 }))!.metaspaceMb).toBeGreaterThan(256)
    expect(recommend(springDef(), entry({ peakMetaMb: 60 }))!.metaspaceMb).toBe(128)
  })
  it('command/무데이터/변화없음 → null', () => {
    expect(recommend(springDef({ kind: 'command', run: 'r' }), entry({ peakHeapMb: 100 }))).toBeNull()
    expect(recommend(springDef(), undefined)).toBeNull()
    expect(recommend(springDef(), entry({ peakHeapMb: 300 }))).toBeNull()   // 0.35~0.9 사이
  })
})

describe('applyRecommendation', () => {
  const SRC = '# 주석\nservices:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    heapMb: 512\n'
  it('heapMb/metaspaceMb를 주석 보존하며 갱신한다', () => {
    const out = applyRecommendation(SRC, 'a', { heapMb: 256, metaspaceMb: 128, reasons: [] })
    expect(out).toContain('# 주석')
    const cfg = loadConfigFromString(out)
    expect(cfg.services[0].heapMb).toBe(256)
    expect(cfg.services[0].metaspaceMb).toBe(128)
  })
  it('미등록 이름 throw', () => {
    expect(() => applyRecommendation(SRC, 'nope', { heapMb: 256, reasons: [] })).toThrowError(/등록/)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/advise.test.ts` → FAIL
- [ ] **Step 3: 구현** — 규칙은 Global Constraints 수식 그대로. applyRecommendation은 add.ts의 parseDocument 패턴 재사용. cli 분기는 status 패턴(ConfigError 처리) 재사용.
- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린. helpText에 advise 줄 추가로 cli-help 테스트가 깨지면 기대 갱신.
- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: orca advise — 사용량 기반 heapMb/metaspaceMb 추천"`

---

### Task 3: 수집 연결 + 대시보드 표시 + v 즉시 적용

**Files:**
- Modify: `src/app.ts`, `src/tui/dashboard.ts`, `src/tui/keys.ts`, `docs/user-guide.md`, `docs/user-guide.html`, `docs/index.html`, `docs/services.example.yaml`
- Test: `test/dashboard.test.ts`, `test/tui.test.ts`

**Interfaces:**
- `keys.ts`: Key에 `'v'` 추가.
- `dashboard.ts`: ServiceState는 건드리지 않고 DashOpts에 `recs?: Record<string, string>` (서비스명 → 압축 문구, 예: `힙 512→256·메타 256→128`). 행 note 체인 **최하위**(BUILDING 힌트보다 아래)에: `  ▼ 권장: ${recs[name]} ([v] 적용)`.
- `app.ts`:
  - 세션 수집: tick에서 서비스별 peakRss 누적(Map<string, number>, statsOn일 때만 갱신 — 꺼져 있으면 기존 피크 유지). UP 전이 감지(직전 상태 비교 or 'change'에서 상태 스냅샷 비교)로 spring 서비스당 세션 1회 90초 setTimeout jstat 스냅샷(진행 중 DOWN/CRASH면 결과 무시; 타이머는 quit에서 clear). 스냅샷 결과 Map<name, JstatGc> 보관(피크 max 갱신).
  - quit(): writeLastSession 뒤·stopAll 전에 — 실행 중 spring 서비스 jstatSnapshot 1회씩(Promise.all, 실패 무시) → 세션 데이터와 함께 `mergeSession`/`writeUsage`. RSS 피크는 spring/command 모두 기록(추천은 spring만이지만 데이터는 남김).
  - 시작 시: `readUsage()` + `recommend()`로 recs 계산 → DashOpts.recs. `v` 키(확인창 게이트 하위, 로그 뷰 제외): 선택 서비스에 rec 있으면 `applyRecommendation`으로 CONFIG_PATH 쓰기 → notice `권장 적용: <이름> <문구>` → 실행 중(UP)이었으면 `void (async () => { await sup.stop(name); await sup.start(name) })()` → 해당 서비스 rec 제거(재계산은 다음 세션). 파일 쓰기는 핫로드 워처가 감지하지만 def 갱신은 어차피 같은 값 — 이중 반영 무해(applyConfig 멱등) 확인.
  - help 줄에 `[v]권장적용` 추가(dashboard 기본 + cli helpText 키 줄 동기화 — 기존 제약).
- 문서: 가이드에 "9.5 사용량 추천" 절(md + html×2 동일), 필드 표에 metaspaceMb, services.example에 metaspaceMb 주석 1줄, README 명령 목록에 advise.

- [ ] **Step 1: 실패하는 테스트**

`test/tui.test.ts`: parseKey 'v'/'V' → 'v'.
`test/dashboard.test.ts`:

```ts
  it('권장 행 노트는 최하위 우선순위로 표시된다', () => {
    const plain = st({ name: 'svc', status: 'DOWN' })
    let lines = dashboardLines([plain], SYS, { sel: 0, statsOn: false, color: false, recs: { svc: '힙 512→256' } })
    expect(lines[2]).toContain('▼ 권장: 힙 512→256 ([v] 적용)')
    const withErr = st({ name: 'svc', status: 'ERROR', error: '문제' })
    lines = dashboardLines([withErr], SYS, { sel: 0, statsOn: false, color: false, recs: { svc: '힙 512→256' } })
    expect(lines[2]).toContain('문제')
    expect(lines[2]).not.toContain('권장')
  })
```

- [ ] **Step 2: 실패 확인** — FAIL 확인
- [ ] **Step 3: 구현** — 인터페이스 절대로. UP 전이 감지는 `sup.on('change')`에서 직전 상태 Map과 비교하는 간단한 방식(app 로컬 Map<string, ServiceStatus>).
- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + tsc 클린, supervisor 2회.
- [ ] **Step 5: 수동 검증** — 데모 config로: `orca` → a → (usage 없으니 추천 없음 정상) → q 후 usage.json 생성 확인. usage.json을 손으로 낮은 peakRss/세션 2로 조작 → 재실행 시 ▼ 권장 표시 → `v` → services.yaml 갱신·notice·재시작 확인 → 원상복구. 원시 출력 report 첨부.
- [ ] **Step 6: 커밋** — `git add -A; git commit -m "feat: 대시보드 사용량 추천 표시와 v 즉시 적용"`

## 셀프리뷰 (작성자 기록)

- jstat 스냅샷은 전부 1회성(90초 타이머는 서비스·세션당 1개, quit에서 clear) — 주기 작업 불변.
- v 적용이 파일을 쓰면 핫로드 onReload도 발화하지만 applyConfig는 동일 def에 멱등이라 무해 — T3 리뷰 확인 포인트.
- recommend의 힙 상향 스텝에서 `max(ceil(peak*1.4/128)*128, heapMb+256)` — FGC만으로 상향될 때 peakHeap이 작아도 최소 +256 보장.
- command의 metaspaceMb=0은 javaArgs 미사용 경로라 무해.
