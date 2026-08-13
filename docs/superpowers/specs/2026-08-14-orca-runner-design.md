# orca 러너 설계 (2026-08-14)

Windows에서 로컬 개발 시 의존성으로 필요한 서비스들을 **자원을 아껴서** 백그라운드로 띄우고, 한 화면(TUI)에서 관리하는 범용 러너.

## 배경

로컬 테스트를 위해 사내 서비스 6개가량을 동시에 띄워야 하는데, 각 서비스를 `gradlew bootRun`·IDE·`pnpm dev`로 띄우면 Gradle 데몬 JVM, 기본값 그대로의 앱 JVM(힙 상한 = 램의 25%, GC/JIT 스레드 = 32코어 기준), 파일 워처가 겹쳐 머신이 심하게 느려진다. 실제로 코드를 고치는 서비스는 사용자가 직접 IDE로 띄우므로, 러너는 **"떠 있기만 하면 되는" 서비스를 싸게 돌리는 것**만 책임진다.

## 목표

- 미리 등록해 둔 서비스를 그룹 단위로 한 번에 시작/중지
- 서비스당 자원 사용을 강제로 제한 (JVM 힙·인식 코어 수·프로세스 우선순위)
- 상태·자원 사용량·로그를 TUI 대시보드 한 화면에서 확인
- 러너 자체의 오버헤드가 체감되지 않을 것 (아래 "자원 예산")

## 비목표

- 개발 모드 실행(`bootRun`, `pnpm dev`, HMR): 사용자가 IDE로 직접 한다. 러너는 절약 실행만.
- 크래시 자동 재시작: 원인 파악을 방해하므로 표시만 한다.
- 크로스플랫폼: Windows 전용. 타 OS 지원은 필요해질 때 별도 결정.
- 웹 UI / 원격 접근.

## 기술 선택

- **Node.js 20+ / TypeScript.** 사용자 머신에 이미 pnpm/Node가 있고, 프로세스 제어·TUI에 충분하다.
- **의존성 최소화.** YAML 파서(`yaml`) 정도만. TUI는 ANSI 이스케이프 직접 렌더링(ink/blessed 같은 프레임워크는 자체 오버헤드와 의존성 트리가 러너의 취지와 상충).
- 설치: `runner` 저장소에서 빌드 후 전역 링크(`pnpm link --global` 또는 `npm i -g .`). 명령 이름은 `orca`.

## 설정

전역 파일 `%USERPROFILE%\.orca\services.yaml` 하나. 특정 프로젝트 폴더에 종속되지 않는다.

```yaml
defaults:
  spring:
    heapMb: 512          # -Xmx
    cpus: 2              # -XX:ActiveProcessorCount
    priority: belowNormal

services:
  eis-server:
    group: tspay
    kind: spring
    dir: C:\Users\jslim\orca\EIS
    module: eis-server        # 멀티모듈이면 :module:bootJar 대상
    port: 8081
    health: http://localhost:8081/actuator/health
  legacy-gateway:
    group: tspay
    kind: command
    dir: C:\work\gateway
    run: run-local.cmd
    port: 9000
```

- `kind: spring` — Gradle 프로젝트 프리셋 (아래 참조)
- `kind: command` — 임의 명령 실행. JVM 플래그는 못 걸지만 우선순위 낮춤과 CPU affinity 제한은 적용.
- 서비스별로 `heapMb`/`cpus`/`priority`/`jvmArgs` 오버라이드 가능.
- 등록은 YAML 직접 편집 또는 `orca add`(대화형 프롬프트로 항목 생성) 둘 다 지원.
- config 파싱 오류는 시작 시 파일·줄 번호와 함께 명확히 보고.

## 실행 프리셋

### spring (절약 실행)

1. **빌드(캐시)**: `gradlew :<module>:bootJar -x test`로 jar 생성. 소스 트리(설정된 `dir` 하위의 `src/`, `build.gradle*`, `gradle.properties`)의 최종 수정 시각을 스캔해 마지막 빌드 시점보다 새 파일이 없으면 재빌드를 건너뛰고 기존 jar 재사용. 시작 배치의 빌드가 모두 끝나면 각 프로젝트에서 `gradlew --stop`을 실행해 데몬 JVM이 램을 잡은 채 남지 않게 한다(데몬 힙은 수백 MB~GB 단위라 방치하면 절약 취지와 모순).
2. **실행**: `java -jar <jar>` + 다음 플래그:
   - `-Xmx<heapMb>m -XX:MaxMetaspaceSize=256m`
   - `-XX:ActiveProcessorCount=<cpus>` (GC/JIT/포크조인 스레드 수 억제)
   - `-XX:+UseSerialGC` (수백 MB 힙에서는 스레드 없는 GC가 오히려 적합)
   - 서비스별 `jvmArgs`로 추가/오버라이드
3. **우선순위**: 프로세스를 BelowNormal로 시작해 포그라운드(IDE·브라우저)에 CPU를 양보.

### command

설정된 명령을 `dir`에서 실행. 우선순위 BelowNormal + `cpus` 설정 시 CPU affinity 마스크 적용.

## 프로세스 관리

- 자식 프로세스는 러너가 소유한다. 러너 종료(`q`) 시 모든 서비스 프로세스 트리를 `taskkill /T /F`로 정리해 좀비 JVM을 남기지 않는다.
- 시작 전 포트 점유를 검사한다. 점유 시 시작하지 않고 ERROR 상태로 표시하며, 점유 중인 프로세스(PID·이름)를 로그에 남긴다.
- 상태 판정: `STARTING`(프로세스 생존, 헬스 미통과) → `UP`(헬스 통과) → `CRASHED`(프로세스 사망) / `ERROR`(빌드 실패·포트 충돌). `health` URL이 없으면 포트 리슨 여부로 판정.
- 서비스 stdout/stderr는 `%USERPROFILE%\.orca\logs\<서비스>.log`에 항상 기록(러너 재시작 시 이어쓰기, 10MB 넘으면 롤링 1회).

## TUI 대시보드

```
 ORCA RUNNER              CPU 12%  RAM 21.4/63GB
 ────────────────────────────────────────────────
 ● eis-server      :8081  UP       480MB   1%
 ● batch-flow      :8082  UP       510MB   1%
 ○ security        :8083  DOWN       -     -
 ● legacy-gateway  :9000  STARTING 120MB   4%
 ────────────────────────────────────────────────
 [↑↓]선택 [s]시작/중지 [a]전체시작 [l]로그 [m]수집 on/off [q]종료
```

- `orca` → 등록된 전체 서비스로 대시보드 실행. `orca <그룹>` → 해당 그룹만 표시. 대시보드는 목록만 띄우고, 시작은 `s`/`a` 키로 한다(실행하자마자 전부 자동 시작하지 않음).
- `l` 로그 뷰: 선택한 서비스의 로그 파일 tail을 화면에 표시, 스크롤 가능, `Esc`로 복귀
- 렌더링은 데이터 변경 시에만 diff 다시 그리기. busy loop 없음.

## 모니터링과 자원 예산

**러너가 자원을 먹으면 무용지물**이라는 것이 핵심 제약. 다음을 지킨다:

- **자원 예산: 러너 전체(TUI + 수집 + 헬스체크)가 평균 CPU 1% 이하, RAM 150MB 이하.** 구현 중 이 예산을 검증하는 것이 완료 조건에 포함된다.
- 자원 수집은 **모든 자식 PID를 3초에 한 번, 단일 배치로** 샘플링한다(서비스별 개별 폴링 금지). CPU%는 두 샘플 간 프로세스 CPU 시간 차이로 계산.
- 수집 구현은 폴링마다 새 프로세스를 낳지 않는 방식을 우선한다(수집마다 PowerShell/wmic 스폰 금지 — wmic은 Win11 24H2에서 제거됨). 후보: 장수명 수집 헬퍼 1개 또는 Win32 API 직접 호출. 최종 선택은 구현 시 측정으로 결정.
- 헬스체크는 10초 간격 HTTP GET(타임아웃 2초), 실패해도 재시도 폭주 없음.
- `m` 키로 자원 수집을 완전히 끌 수 있다(끄면 상태·포트만 표시). 헬스체크는 유지.

## `orca setup` (최초 1회 튜닝)

- Windows Defender 실시간 검사 예외 등록: 등록된 각 서비스의 `dir`, `~/.gradle`, pnpm 스토어. 관리자 권한 필요 — 적용할 목록을 보여주고 확인받은 뒤 실행.
- Java/Node 버전, `JAVA_HOME` 확인.
- 각 spring 서비스의 `gradle.properties`를 읽고 데몬 힙(`org.gradle.jvmargs`) 과다 설정 등 권장 변경 사항을 안내만 한다(프로젝트 파일을 임의로 수정하지 않음).

## 에러 처리 요약

| 상황 | 동작 |
|---|---|
| 포트 충돌 | 시작 중단, ERROR 표시, 점유 PID 로그 |
| jar 빌드 실패 | ERROR 표시, `l`로 빌드 로그 바로 확인 |
| 서비스 크래시 | CRASHED 표시, 자동 재시작 안 함 |
| config 오류 | 시작 시 파일·줄 번호와 함께 종료 |
| 러너 강제 종료(창 닫힘) | 다음 실행 시 이전 세션 PID 파일을 확인해 고아 프로세스 감지·정리 제안 |

## 테스트

- 단위: config 파서, jar 캐시 판정(수정 시각 비교), 상태 머신 전이.
- 통합: 1초 만에 뜨는 더미 HTTP 서버 스크립트로 시작→UP 판정→중지→트리 정리 검증. 포트 충돌 시나리오 포함.
- 수동: TUI 렌더링, Defender 예외 등록(관리자 권한), 실제 Gradle 프로젝트 1개로 end-to-end.
- **자원 예산 검증**: 더미 서비스 6개를 띄운 상태로 러너 프로세스의 CPU/RAM을 측정해 예산(1%/150MB) 이내인지 확인.
