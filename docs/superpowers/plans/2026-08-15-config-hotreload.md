# 설정 핫로드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 실행 중 services.yaml 변경을 fs.watch로 감지해 승인된 반영 규칙대로 적용한다.

**Architecture:** Supervisor에 순수 조정 메서드 `applyConfig`(엔트리 맵 재조정)를 추가하고, 신규 `configWatcher.ts`(디렉토리 감시+디바운스)가 app.ts에서 이를 구동한다. 대시보드는 notice 줄과 행 노트 2종을 얻는다.

**Tech Stack:** 기존 동일. fs.watch는 Windows에서 ReadDirectoryChangesW 기반 이벤트 — 주기 작업 없음.

**Spec:** `docs/superpowers/specs/2026-08-15-config-hotreload-design.md` (반영 규칙 표가 구속)

## Global Constraints

- **새 setInterval/폴링 금지** — fs.watch 이벤트 + 500ms 디바운스 타이머(이벤트 시에만)만 허용. notice 만료는 기존 3초 tick에서 처리.
- 실행/빌드 중 서비스의 설정은 즉시 재적용하지 않는다 — 표시(`⟳`)만, 다음 시작부터 적용.
- 리로드 오류 시 기존 설정 유지 + 스티키 안내. 대시보드가 죽는 일 없음.
- 그룹 필터 유지: `orca <그룹>` 실행 중 리로드도 같은 필터. 필터 결과가 비면 반영하지 않고 안내만 (n=0 방지).
- 감시 대상은 **디렉토리**(`~\.orca`) — 에디터의 rename-replace 저장을 놓치지 않기 위해. services.yaml 이벤트만 필터.
- 커밋 conventional, 태스크마다 `pnpm test` 전체 + `tsc --noEmit` 클린, supervisor 테스트 2회 연속.

## File Structure

```
수정: src/types.ts        (Task 1 — configChanged/removedFromConfig)
수정: src/supervisor.ts   (Task 1 — applyConfig + start 가드 + exit 핸들러 삭제 처리)
생성: src/configWatcher.ts(Task 2)
수정: src/app.ts          (Task 2 — runApp opts.group, watcher 구동, notice, sel 클램프, quit 정리)
수정: src/cli.ts          (Task 2 — runApp에 group 전달)
수정: src/tui/dashboard.ts(Task 2 — notice 줄, 행 노트 2종)
수정: README.md           (Task 2)
테스트: test/supervisor.test.ts (Task 1), test/configwatcher.test.ts·test/dashboard.test.ts (Task 2)
```

---

### Task 1: Supervisor.applyConfig — 반영 규칙의 상태머신 (스펙 반영 규칙 표)

**Files:**
- Modify: `src/types.ts`, `src/supervisor.ts`
- Test: `test/supervisor.test.ts`

**Interfaces:**
- Produces:
  - `types.ts` ServiceState에 `configChanged?: boolean`(실행 중 def 변경됨 — 다음 시작 시 해제), `removedFromConfig?: boolean`(설정에서 삭제됨 — 관리만 유지) 추가.
  - `Supervisor.applyConfig(cfg: Config): { added: string[]; removed: string[]; changed: string[]; deferredRemoved: string[] }` — 엔트리 맵을 새 config 순서로 재구성. 규칙:
    - 신규 이름 → `{ status: 'DOWN' }` 엔트리 추가 (added)
    - 기존 이름 → def를 새 값으로 교체(다음 시작부터 적용). def가 실제로 달라졌고 활성(pid/buildChild 있거나 UP/STARTING/BUILDING)이면 `configChanged: true` (changed에 포함; 비활성 변경도 changed에 포함하되 플래그는 안 세움). `removedFromConfig`는 해제.
    - 사라진 이름 → 비활성이면 즉시 제거(removed), 활성이면 `removedFromConfig: true`로 맵 끝에 유지(deferredRemoved)
    - 마지막에 `emit('change')`
  - `start()`: 초입에 `if (e.state.removedFromConfig) return` (설정에 없는 서비스 재시작 금지). 시작 진행 시 `configChanged: undefined`로 해제.
  - exit 핸들러: stopping→DOWN 전이 직후, `removedFromConfig`면 엔트리를 맵에서 삭제하고 `emit('change')` (CRASHED로 끝난 removed 엔트리는 크래시 사유 표시를 위해 남긴다 — 비활성이므로 다음 applyConfig에서 제거됨. 이 정책을 주석으로 명시).

- [ ] **Step 1: 실패하는 테스트 추가** — `test/supervisor.test.ts` (기존 헬퍼 cfg()/FIXTURE 재사용):

```ts
  it('applyConfig: 추가/비활성 제거/순서 재정렬', () => {
    sup = new Supervisor(cfg(45901, 45902), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    const base = { kind: 'command' as const, dir: process.cwd(), heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
    const r = sup.applyConfig({ services: [
      { ...base, name: 'dummy-b', run: 'x', port: 45902 },        // 순서 앞으로
      { ...base, name: 'new-c', run: 'x', port: 45903 },          // 신규
      // dummy-a 삭제 (비활성)
    ] })
    expect(r.added).toEqual(['new-c'])
    expect(r.removed).toEqual(['dummy-a'])
    expect(r.deferredRemoved).toEqual([])
    expect(sup.states().map(s => s.def.name)).toEqual(['dummy-b', 'new-c'])
    expect(sup.states()[1].status).toBe('DOWN')
  })

  it('applyConfig: 실행 중 서비스 삭제는 유예, 중지 시 목록에서 사라진다', async () => {
    sup = new Supervisor(cfg(45905, 45906), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const base = { kind: 'command' as const, dir: process.cwd(), heapMb: 0, cpus: 0, priority: 'normal' as const, jvmArgs: [] }
    const r = sup.applyConfig({ services: [{ ...base, name: 'dummy-b', run: `node "${FIXTURE}" 45906`, port: 45906 }] })
    expect(r.deferredRemoved).toEqual(['dummy-a'])
    const a = sup.states().find(s => s.def.name === 'dummy-a')!
    expect(a.removedFromConfig).toBe(true)
    expect(a.status).toBe('UP')
    await sup.start('dummy-a')                        // 재시작 거부 — 상태 그대로 UP(새 spawn 없음)
    expect(sup.states().filter(s => s.def.name === 'dummy-a')).toHaveLength(1)
    await sup.stop('dummy-a')
    expect(sup.states().find(s => s.def.name === 'dummy-a')).toBeUndefined()   // DOWN 도달 시 제거
  }, 30000)

  it('applyConfig: 실행 중 def 변경은 표시만, 재시작 시 해제·적용', async () => {
    sup = new Supervisor(cfg(45907, 45908), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const cur = sup.states()[0].def
    sup.applyConfig({ services: [ { ...cur, heapMb: 999 }, sup.states()[1].def ] })
    expect(sup.states()[0].configChanged).toBe(true)
    expect(sup.states()[0].def.heapMb).toBe(999)      // def는 즉시 교체 (다음 시작용)
    expect(sup.states()[0].status).toBe('UP')          // 실행엔 영향 없음
    await sup.stop('dummy-a')
    await sup.start('dummy-a')
    expect(sup.states()[0].configChanged).toBeUndefined()
    expect(sup.states()[0].status).toBe('UP')
  }, 30000)
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/supervisor.test.ts` → FAIL (applyConfig 없음)

- [ ] **Step 3: 구현**

`src/types.ts` ServiceState에:
```ts
  configChanged?: boolean       // 실행 중 def가 바뀜 — 다음 시작부터 적용, 시작 시 해제
  removedFromConfig?: boolean   // 설정에서 삭제됨 — 실행 중이라 관리만 유지, 중지 시 목록에서 제거
```

`src/supervisor.ts`:
1. 활성 판정 헬퍼 (클래스 내):
```ts
  private isActive(e: Entry): boolean {
    return e.state.pid !== undefined || e.buildChild !== undefined ||
      e.state.status === 'UP' || e.state.status === 'STARTING' || e.state.status === 'BUILDING'
  }
```
2. applyConfig (setSkip 아래):
```ts
  /** 핫로드 반영 규칙 (스펙 표 참조): 실행 중인 프로세스는 절대 건드리지 않고 표시/유예만 한다 */
  applyConfig(cfg: Config): { added: string[]; removed: string[]; changed: string[]; deferredRemoved: string[] } {
    const next = new Map<string, Entry>()
    const added: string[] = [], removed: string[] = [], changed: string[] = [], deferredRemoved: string[] = []
    for (const def of cfg.services) {
      const e = this.entries.get(def.name)
      if (!e) {
        next.set(def.name, { state: { def, status: 'DOWN' }, stopping: false })
        added.push(def.name)
        continue
      }
      const defChanged = JSON.stringify(e.state.def) !== JSON.stringify(def)
      e.state.def = def                                   // 다음 시작부터 적용
      if (defChanged) {
        changed.push(def.name)
        if (this.isActive(e)) e.state.configChanged = true
      }
      e.state.removedFromConfig = undefined               // 복귀 처리
      next.set(def.name, e)
    }
    for (const [name, e] of this.entries) {
      if (next.has(name)) continue
      if (this.isActive(e)) {
        e.state.removedFromConfig = true                  // 실행 중 — 유예 (중지 시 제거)
        next.set(name, e)
        deferredRemoved.push(name)
      } else {
        removed.push(name)                                // CRASHED/ERROR 포함 비활성은 즉시 제거
      }
    }
    this.entries = next
    this.emit('change')
    return { added, removed, changed, deferredRemoved }
  }
```
3. start() 초입 가드(기존 상태 가드 다음 줄): `if (e.state.removedFromConfig) return`. 그리고 skip 해제 줄 뒤에 `if (e.state.configChanged) this.set(e, { configChanged: undefined })`.
4. exit 핸들러의 stopping→DOWN 분기 직후 (this.set 호출 다음):
```ts
        if (e.stopping && e.state.removedFromConfig && this.entries.get(name) === e) {
          // 설정에서 삭제된 서비스가 정지 완료 — 이제 목록에서 제거.
          // CRASHED로 끝난 경우는 사유 표시를 위해 남긴다(비활성이므로 다음 applyConfig가 제거).
          this.entries.delete(name)
          this.emit('change')
        }
```
(구현 시 set 분기 구조에 맞게 배치 — DOWN 전이일 때만.)

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + `tsc --noEmit` 클린, supervisor 2회 연속

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: Supervisor.applyConfig — 핫로드 반영 규칙 상태머신"`

---

### Task 2: 워처 + 대시보드/앱 연결 (스펙 동작 절)

**Files:**
- Create: `src/configWatcher.ts`
- Modify: `src/app.ts`, `src/cli.ts`, `src/tui/dashboard.ts`, `README.md`
- Test: `test/configwatcher.test.ts` (신규), `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1의 applyConfig 반환.
- Produces:
  - `configWatcher.ts`: `watchConfig(onReload: (cfg: Config) => void, onError: (msg: string) => void, path?: string, debounceMs = 500): () => void` — path 기본 CONFIG_PATH. **디렉토리 감시** + 파일명 필터(대소문자 무시) + 디바운스. 재로드는 `loadConfig(path)`; ConfigError·기타 오류는 onError(message). 디렉토리가 없으면 감시 없이 no-op close 반환. watcher 자체 'error'는 무시(치명 아님). close()는 타이머와 워처 정리.
  - `dashboard.ts`: `DashOpts.notice?: string` — banner처럼 head 다음에 삽입 (banner와 공존: head, banner?, notice?, sep 순). 행 note 우선순위를 다음으로 재구성: `removedFromConfig` → `  (설정에서 삭제됨 — 중지 시 제거)` / skip 경고(기존) / error(기존) / `configChanged` → `  ⟳ 설정 변경 — r로 반영` / BUILDING 힌트(기존).
  - `app.ts`: `runApp(cfg: Config, opts?: { group?: string })`. notice 상태(`notice`/`noticeExpiry`), 워처 구동:
    - onReload: full cfg에 그룹 필터 적용 → 비면 `⚠ 리로드 결과 서비스가 없어 기존 설정을 유지합니다` notice(8초)만. 아니면 `sup.applyConfig({ services })`, `sel = Math.min(sel, sup.states().length - 1)` 클램프, notice `설정 반영: +A 추가, C 변경, R 제거`(5초, R = removed+deferredRemoved), draw()
    - onError: notice `⚠ services.yaml 오류 — 기존 설정 유지: <첫 줄>` — 스티키(만료 없음), 다음 성공 리로드가 덮음
    - tick에서 만료된 notice 해제 (새 타이머 금지). quit()에서 watcher close.
  - `cli.ts`: 대시보드 호출을 `await runApp({ services }, { group })`으로.
  - README 동작 방식에 핫로드 2줄 (자동 감지, 실행 중 서비스는 표시만).

- [ ] **Step 1: 실패하는 테스트**

`test/configwatcher.test.ts` 신규:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { watchConfig } from '../src/configWatcher.js'
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/types.js'

const VALID = 'services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 4501\n'
const VALID2 = VALID + '  b:\n    kind: command\n    dir: C:\\y\n    run: r\n    port: 4502\n'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let close: (() => void) | undefined
afterEach(() => { close?.(); close = undefined })

async function waitFor<T>(get: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error('timeout')
    await sleep(100)
  }
}

describe('configWatcher', () => {
  it('파일 저장을 감지해 새 설정을 전달한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let got: Config | undefined
    close = watchConfig(c => { got = c }, () => {}, file, 200)
    await sleep(300)                               // 워처 안정화
    writeFileSync(file, VALID2)
    const cfg = await waitFor(() => got)
    expect(cfg.services.map(s => s.name)).toEqual(['a', 'b'])
  })

  it('rename-replace 저장도 감지한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let got: Config | undefined
    close = watchConfig(c => { got = c }, () => {}, file, 200)
    await sleep(300)
    const tmp = join(dir, 'services.yaml.tmp')
    writeFileSync(tmp, VALID2)
    renameSync(tmp, file)
    const cfg = await waitFor(() => got)
    expect(cfg.services).toHaveLength(2)
  })

  it('깨진 yaml은 onError로 가고 onReload는 불리지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let err: string | undefined
    let reloaded = false
    close = watchConfig(() => { reloaded = true }, m => { err = m }, file, 200)
    await sleep(300)
    writeFileSync(file, 'services:\n  bad name:\n    kind: nope\n')
    const msg = await waitFor(() => err)
    expect(msg.length).toBeGreaterThan(0)
    expect(reloaded).toBe(false)
  })

  it('디바운스: 연속 저장은 한 번만 전달된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cw-'))
    const file = join(dir, 'services.yaml')
    writeFileSync(file, VALID)
    let count = 0
    close = watchConfig(() => { count++ }, () => {}, file, 400)
    await sleep(300)
    writeFileSync(file, VALID2)
    await sleep(50)
    writeFileSync(file, VALID)
    await sleep(50)
    writeFileSync(file, VALID2)
    await sleep(1200)
    expect(count).toBe(1)
  })
})
```

`test/dashboard.test.ts`에 추가:

```ts
  it('notice 줄과 배너가 공존한다', () => {
    const lines = dashboardLines([st({ status: 'DOWN' })], SYS,
      { sel: 0, statsOn: false, color: false, banner: ' 배너', notice: ' 공지' })
    expect(lines[1]).toBe(' 배너')
    expect(lines[2]).toBe(' 공지')
  })
  it('removedFromConfig/configChanged 행 노트', () => {
    const rm = st({ status: 'UP' }); rm.removedFromConfig = true
    expect(dashboardLines([rm], SYS, { sel: 0, statsOn: false, color: false })[2]).toContain('설정에서 삭제됨')
    const ch = st({ status: 'UP' }); ch.configChanged = true
    expect(dashboardLines([ch], SYS, { sel: 0, statsOn: false, color: false })[2]).toContain('r로 반영')
  })
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/configwatcher.test.ts test/dashboard.test.ts` → FAIL

- [ ] **Step 3: 구현**

`src/configWatcher.ts`:

```ts
import { watch, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'
import { loadConfig, ConfigError, CONFIG_PATH } from './config.js'
import type { Config } from './types.js'

/**
 * services.yaml 변경 감시. 에디터의 rename-replace 저장을 놓치지 않도록 파일이 아니라
 * 디렉토리를 감시하고 파일명으로 거른다. fs.watch는 이벤트 기반(ReadDirectoryChangesW) —
 * 주기 작업이 없어 자원 예산에 영향이 없다. 디바운스 타이머는 이벤트가 있을 때만 생긴다.
 */
export function watchConfig(
  onReload: (cfg: Config) => void,
  onError: (msg: string) => void,
  path = CONFIG_PATH,
  debounceMs = 500,
): () => void {
  const dir = dirname(path)
  const file = basename(path).toLowerCase()
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher
  try {
    watcher = watch(dir, (_event, filename) => {
      if (!filename || filename.toLowerCase() !== file) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        try { onReload(loadConfig(path)) }
        catch (e) { onError(e instanceof ConfigError ? e.message : (e as Error).message) }
      }, debounceMs)
    })
  } catch {
    return () => {}   // 디렉토리 없음 등 — 감시 없이 진행 (첫 orca add 전)
  }
  watcher.on('error', () => { /* 감시 실패는 치명적이지 않다 — 핫로드만 비활성화됨 */ })
  return () => { if (timer) clearTimeout(timer); watcher.close() }
}
```

`src/tui/dashboard.ts`:
- DashOpts에 `notice?: string` 추가.
- 반환 조립을:
```ts
  const out = [head, sep, ...rows, sep, help]
  const extras = [opts.banner, opts.notice].filter((x): x is string => !!x)
  if (extras.length > 0) out.splice(1, 0, ...extras)
  return out
```
- note 계산(rows 맵 안)을 우선순위 체인으로 교체:
```ts
    const note = s.removedFromConfig ? '  (설정에서 삭제됨 — 중지 시 제거)'
      : isSkip && s.skipPortUp === false ? '  ⚠ 포트 응답 없음 (IDE에서 내려간 듯)'
      : s.error ? '  ' + s.error
      : s.configChanged ? '  ⟳ 설정 변경 — r로 반영'
      : (s.status === 'BUILDING' ? '  (빌드는 수 분 걸릴 수 있음)' : '')
```

`src/app.ts`:
- 시그니처 `export async function runApp(cfg: Config, opts?: { group?: string }): Promise<void>`
- 상태: `let notice: string | undefined; let noticeExpiry = 0` (Infinity = 스티키)
- sup 생성 직후:
```ts
  const stopWatch = watchConfig(
    full => {
      const services = opts?.group ? full.services.filter(s => s.group === opts.group) : full.services
      if (services.length === 0) {
        notice = ` ⚠ 리로드 결과 서비스가 없어 기존 설정을 유지합니다`
        noticeExpiry = Date.now() + 8000
        draw(); return
      }
      const r = sup.applyConfig({ services })
      sel = Math.min(sel, Math.max(0, sup.states().length - 1))
      notice = ` 설정 반영: +${r.added.length} 추가, ${r.changed.length} 변경, ${r.removed.length + r.deferredRemoved.length} 제거`
      noticeExpiry = Date.now() + 5000
      draw()
    },
    msg => {
      notice = ` ⚠ services.yaml 오류 — 기존 설정 유지: ${msg.split('\n')[0]}`
      noticeExpiry = Infinity   // 스티키 — 다음 성공 리로드가 덮는다
      draw()
    },
  )
```
- draw()의 dash 분기 opts에 `notice` 전달.
- tick 본문 draw() 앞: `if (notice && Date.now() > noticeExpiry) { notice = undefined }`
- quit()에 `stopWatch()` (clearInterval 옆).
- import 추가: watchConfig.

`src/cli.ts`: `await runApp({ services })` → `await runApp({ services }, { group })`.

README 동작 방식에:
```
- 대시보드 실행 중 `services.yaml`을 저장하면 자동 반영된다 (다른 터미널의 `orca add/remove` 포함).
  실행 중인 서비스의 변경은 `⟳` 표시 후 다음 재시작부터 적용되고, 파일이 깨져 있으면 기존 설정을 유지한다.
```

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + `tsc --noEmit` 클린. fs.watch 테스트가 CI/AV 타이밍에 민감할 수 있음 — 로컬에서 2회 연속 실행해 플레이크 확인, 필요 시 waitFor 한도만 조정(로직 변경 금지).

- [ ] **Step 5: 수동 검증** — `pnpm dev` 실행 상태에서 다른 터미널로 `orca add`(더미 1개) → 대시보드에 행과 `설정 반영: +1 추가` notice가 나타나는지, services.yaml을 일부러 깨뜨리면 스티키 오류 notice가 뜨고 고치면 사라지는지. 확인 후 등록 정리. 원시 출력을 보고서에 첨부.

- [ ] **Step 6: 커밋** — `git add -A; git commit -m "feat: services.yaml 핫로드 — fs.watch 감지와 대시보드 반영"`

---

## 계획 셀프리뷰 (작성자 기록)

- 스펙 표 전 행이 Task 1 applyConfig + Task 2 표시로 커버됨. 오류 유지/그룹 필터/sel 클램프/quit 정리 = Task 2.
- 시그니처 일관성: applyConfig 반환 4필드를 Task 2 notice가 소비. DashOpts.notice는 banner 패턴 동일.
- 알려진 트레이드오프: ① 자기 자신(orca add를 같은 머신 다른 프로세스가 실행)도 감지됨 — 의도된 기능. ② def 비교가 JSON.stringify — config.ts가 필드 순서를 일정하게 만들므로 결정적. ③ CRASHED로 끝난 removed 엔트리는 다음 리로드까지 잔류 — 사유 확인 기회 보존 목적, 주석 명시.
