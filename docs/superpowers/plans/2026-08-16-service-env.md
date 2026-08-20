# 서비스별 env 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** services.yaml의 서비스 항목에 `env` 맵을 추가해, 셸 환경 위에 서비스별 환경변수를 덮어써 실행한다.

**Architecture:** ServiceDef에 env 필드(정규화·검증은 config.ts), spawnService에 env 전달 옵션, supervisor가 연결. 스코프는 서비스 단일 (전역/그룹/격리 없음 — 사용자 결정).

**Tech Stack:** 기존 동일.

**Spec:** 이 문서의 요구사항 절이 스펙을 겸한다 (대화에서 확정된 최소 버전).

## Global Constraints

- env 값의 YAML 숫자/불리언은 문자열로 **자동 변환** (`PG_PORT: 5432` 허용). 객체/배열/null 값은 파일·줄 번호 포함 ConfigError.
- 셸 환경 상속은 유지 — `{ ...process.env, ...def.env }` 병합 (서비스 값이 이김). env가 비어 있으면 spawn 동작 완전 동일(옵션 미전달).
- detach(headless)·일반 두 spawn 경로 모두 적용.
- 핫로드: env 변경은 기존 applyConfig def 비교에 자동 포함 — 별도 코드 불필요, 테스트로 확인만.
- 문서 갱신 포함: docs/user-guide.md 필드 표, docs/user-guide.html·docs/index.html 동일 지점, docs/services.example.yaml 예시.
- `pnpm test` 전체 + `tsc --noEmit` 클린, conventional commit.

---

### Task 1: env 필드 전 구간 연결

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `src/procctl.ts`, `src/supervisor.ts`, `docs/user-guide.md`, `docs/user-guide.html`, `docs/index.html`, `docs/services.example.yaml`
- Test: `test/config.test.ts`, `test/procctl.test.ts`, `test/supervisor.test.ts`

**Interfaces:**
- `types.ts` ServiceDef에 `env: Record<string, string>` (config가 항상 채움 — 기본 `{}`).
- `config.ts`: 서비스 루프에서 `s.env` 처리 — undefined면 `{}`; 객체가 아니거나 배열이면 fail; 각 값이 string이면 그대로, number/boolean이면 `String(v)`, 그 외(null/객체/배열)면 fail(`${name}: env.${key} 값은 문자열/숫자/불리언이어야 합니다`). 키는 `/^[A-Za-z_][A-Za-z0-9_]*$/` 검증(`${name}: env 키 '${key}'는 영문/숫자/_ 형식이어야 합니다`).
- `procctl.ts` spawnService opts에 `env?: Record<string, string>` 추가 — 두 spawn 경로 모두 `env: o.env && Object.keys(o.env).length > 0 ? { ...process.env, ...o.env } : undefined` 옵션 전달.
- `supervisor.ts` start()의 두 spawnService 호출에 `env: def.env` 전달.

- [ ] **Step 1: 실패하는 테스트**

`test/config.test.ts`에 추가:

```ts
  it('env: 문자열/숫자/불리언 값을 문자열 맵으로 정규화한다', () => {
    const src = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n    env:\n      PROFILE: local\n      PG_PORT: 5432\n      DEBUG: true\n`
    const cfg = loadConfigFromString(src)
    expect(cfg.services[0].env).toEqual({ PROFILE: 'local', PG_PORT: '5432', DEBUG: 'true' })
  })
  it('env 미지정이면 빈 객체', () => {
    const src = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n`
    expect(loadConfigFromString(src).services[0].env).toEqual({})
  })
  it('env 값이 객체면 에러, 키 형식 위반이면 에러', () => {
    const nested = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n    env:\n      BAD:\n        x: 1\n`
    expect(() => loadConfigFromString(nested)).toThrowError(/env\.BAD/)
    const badKey = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n    env:\n      "1BAD": v\n`
    expect(() => loadConfigFromString(badKey)).toThrowError(/env 키/)
  })
```

`test/procctl.test.ts`에 추가:

```ts
  it('spawnService: env가 셸 환경 위에 덮어써진다', async () => {
    const out = new PassThrough()
    let buf = ''
    out.on('data', d => { buf += String(d) })
    const { pid } = await spawnService({
      command: process.execPath,
      args: ['-e', "process.stdout.write((process.env.ORCA_ENV_TEST || 'missing') + '|' + (process.env.PATH ? 'inherited' : 'no-path'))"],
      cwd: process.cwd(), priority: 'normal', out,
      env: { ORCA_ENV_TEST: 'hello' },
    })
    await new Promise(r => setTimeout(r, 1500))
    expect(buf).toBe('hello|inherited')      // 서비스 값 적용 + 셸 환경(PATH) 상속 유지
    expect(isAlive(pid)).toBe(false)
  }, 15000)
```

`test/supervisor.test.ts`에 추가 (핫로드 편승 확인 — 코드 없이 동작해야 함):

```ts
  it('env 변경은 configChanged로 표시된다 (핫로드 편승)', async () => {
    sup = new Supervisor(cfg(45921, 45922), { logDir: mkdtempSync(join(tmpdir(), 'orca-sv-')) })
    await sup.start('dummy-a')
    const cur = sup.states().map(s => s.def)
    sup.applyConfig({ services: [{ ...cur[0], env: { NEW_VAR: 'x' } }, cur[1]] })
    expect(sup.states()[0].configChanged).toBe(true)
    await sup.stop('dummy-a')
  }, 30000)
```
(기존 cfg() 헬퍼의 base에 `env: {}`가 필요해지면 — ServiceDef 필수 필드가 되므로 — 테스트 헬퍼들의 base 객체에 `env: {}`를 추가한다. supervisor/headless/status/dashboard 테스트의 base 리터럴 전부.)

- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/config.test.ts test/procctl.test.ts` → FAIL (env 필드/옵션 없음). tsc는 ServiceDef 변경 후 헬퍼 미수정 시 에러 — 그것도 수정 대상.

- [ ] **Step 3: 구현**

`src/types.ts` ServiceDef에:
```ts
  env: Record<string, string>   // 서비스별 환경변수 — 셸 환경 위에 덮어써서 실행 (기본 {})
```

`src/config.ts` — 서비스 루프의 타입 검증 블록에 추가:
```ts
    const env: Record<string, string> = {}
    if (s.env !== undefined) {
      if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) fail(at, `${name}: env는 키-값 맵이어야 합니다`)
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(at, `${name}: env 키 '${k}'는 영문/숫자/_ 형식이어야 합니다`)
        if (typeof v === 'string') env[k] = v
        else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v)
        else fail(at, `${name}: env.${k} 값은 문자열/숫자/불리언이어야 합니다`)
      }
    }
```
services.push의 객체에 `env,` 추가.

`src/procctl.ts` spawnService — opts 타입에 `env?: Record<string, string>` 추가, 두 spawn 호출(detach/일반)에:
```ts
  const childEnv = o.env && Object.keys(o.env).length > 0 ? { ...process.env, ...o.env } : undefined
```
계산 후 spawn 옵션에 `env: childEnv` 추가.

`src/supervisor.ts` start()의 두 spawnService 호출에 `env: def.env` 추가.

문서:
- `docs/user-guide.md` 필드 레퍼런스 표에 `env` 행 추가: `서비스별 환경변수 맵. 셸 환경 위에 덮어씀. 숫자/불리언 값은 문자열로 자동 변환` + 3절 YAML 예시에 env 2줄 추가.
- `docs/user-guide.html`·`docs/index.html`의 같은 표·예시 지점에 동일 반영 (두 파일은 내용 동일 — 같은 수정).
- `docs/services.example.yaml`의 eis-server 항목에 env 예시 추가:
```yaml
    env:
      SPRING_PROFILES_ACTIVE: local
      PG_PORT: 5432          # 숫자도 됨 — 문자열로 자동 변환
```

- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 + `tsc --noEmit` 클린 (base 리터럴 수정 포함), supervisor 2회 연속.

- [ ] **Step 5: 커밋** — `git add -A; git commit -m "feat: 서비스별 env — 셸 환경 위 덮어쓰기 실행"`

## 셀프리뷰 (작성자 기록)

- env가 ServiceDef 필수 필드(항상 {})가 되므로 테스트 헬퍼 base 리터럴 전부 갱신 필요 — Step 1 말미에 명시.
- applyConfig의 JSON.stringify 비교가 env를 자동 포함 — supervisor 테스트가 이를 검증.
- add 인터뷰·status·headless는 def를 통째로 쓰므로 추가 변경 불필요.
