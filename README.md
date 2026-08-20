# orca

Windows에서 로컬 개발 의존성 서비스들을 자원 아껴서 백그라운드로 띄우는 TUI 러너.
직접 개발 중인 서비스는 IDE로 띄우고, 나머지 "떠 있기만 하면 되는" 것들을 orca에 맡긴다.

> 📖 **[사용자 가이드](https://jslimmain0.github.io/orca-runner/)** (GitHub Pages) · [마크다운판](docs/user-guide.md) — 설치부터 대시보드·자동화·핫로드·문제 해결까지.
> ⚡ 설정이 막막하면 **[services.yaml 템플릿](docs/services.example.yaml)**을 복사해서 시작.

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

orca status [--json]      # TUI 없이 상태 확인 (전부 UP이면 exit 0)
orca up [그룹|--all]      # headless 일괄 시작 (인자 없으면 지난 세션 재개, --all이면 전체)
orca down [그룹] --yes    # headless 일괄 종료 (--yes 없으면 대상만 표시)
orca start|stop <이름>    # 개별 서비스 시작/종료
orca remove [이름]        # 서비스 등록 해제
orca groups               # 그룹 목록
orca advise                # 사용량 기반 heapMb/metaspaceMb 추천
orca --help                # 전체 명령 요약
```

대시보드 키: `↑↓/1-9` 선택 · `s/Enter` 시작/중지 · `r` 재시작 · `a` 전체 · `x` 제외(SKIP) · `l` 로그 · `m` 수집 on/off · `q` 종료(전체 정리)
지난 세션에 실행 중이던 서비스가 있으면 배너가 뜨고 `u`로 재개할 수 있다.

## 동작 방식

- spring 서비스: `gradlew bootJar`(소스 변경 없으면 캐시) → `java -jar` + `-Xmx512m` + 2코어 인식 + BelowNormal 우선순위. 빌드 후 Gradle 데몬은 `--stop`으로 정리.
- command 서비스: 임의 명령 + 낮은 우선순위 (+ 선택적 CPU affinity)
- 로그: `~\.orca\logs\<이름>.log` (10MB 롤링)
- 자원 수집: 장수명 PowerShell 헬퍼 1개에 3초마다 일괄 요청. `m`으로 완전히 끌 수 있음.
- command 서비스의 MEM/CPU 표시는 cmd 래퍼 프로세스 기준이라 실제 작업 프로세스보다 작게 보일 수 있다 (spring 서비스는 정확).
- command 서비스의 cpus(affinity)는 명시적으로 설정한 경우에만 적용되며, 현재는 래퍼 프로세스에 적용된다.
- SKIP: 대시보드에서 `x`로 서비스를 제외 처리하면(IDE 등에서 직접 띄운 경우) `a`/기본 시작 대상에서 빠진다. 포트가 응답하지 않으면 `SKIP(!)`로 경고 표시.
- 세션 재개: 종료(`q`) 시 그 순간의 서비스 상태를 `~\.orca\last-session.json`에 저장한다. 다음 실행 시 UP/STARTING/BUILDING이었던 서비스가 있으면 대시보드에 배너로 안내하고(`u`로 재개), `orca up`도 그룹 지정 없이 실행하면 기본으로 이 세션만 재개한다(전체는 `orca up --all`).
- 소유 세션: `orca up`/`orca start` 등 headless로 띄운 서비스는 그 CLI 프로세스가 아니라 orca 자체가 "소유"한다 — 다른 터미널의 TUI나 headless 명령이 같은 서비스를 건드리지 않도록 실행 기록에 소유자(owner)를 남기고, 다른 세션이 소유한 서비스는 조회만 허용하고 종료는 막는다.
- 대시보드 실행 중 `services.yaml`을 저장하면 자동 반영된다 (다른 터미널의 `orca add/remove` 포함).
  실행 중인 서비스의 변경은 `⟳` 표시 후 다음 재시작부터 적용되고, 파일이 깨져 있으면 기존 설정을 유지한다.

## 자원 예산

러너 자체는 평균 CPU 1% 이하, RAM 150MB 이하를 유지한다. 검증:

```powershell
pnpm build; node scripts/measure-budget.mjs
```

최근 측정: CPU 0.05%, RAM 146MB(자체 57MB + PS헬퍼 90MB), 2026-08-14, 32코어/64GB 머신, 더미 서비스 6개 30초 구동 기준. 재측정으로 재현성 확인(CPU 0.26%, RAM 146MB) — 예산 통과, RAM 여유는 약 4MB로 타이트한 편.
