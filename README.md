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

대시보드 키: `↑↓/1-9` 선택 · `s/Enter` 시작/중지 · `r` 재시작 · `a` 전체 시작 · `l` 로그 · `m` 수집 on/off · `q` 종료(전체 정리)

## 동작 방식

- spring 서비스: `gradlew bootJar`(소스 변경 없으면 캐시) → `java -jar` + `-Xmx512m` + 2코어 인식 + BelowNormal 우선순위. 빌드 후 Gradle 데몬은 `--stop`으로 정리.
- command 서비스: 임의 명령 + 낮은 우선순위 (+ 선택적 CPU affinity)
- 로그: `~\.orca\logs\<이름>.log` (10MB 롤링)
- 자원 수집: 장수명 PowerShell 헬퍼 1개에 3초마다 일괄 요청. `m`으로 완전히 끌 수 있음.
- command 서비스의 MEM/CPU 표시는 cmd 래퍼 프로세스 기준이라 실제 작업 프로세스보다 작게 보일 수 있다 (spring 서비스는 정확).
- command 서비스의 cpus(affinity)는 명시적으로 설정한 경우에만 적용되며, 현재는 래퍼 프로세스에 적용된다.

## 자원 예산

러너 자체는 평균 CPU 1% 이하, RAM 150MB 이하를 유지한다. 검증:

```powershell
pnpm build; node scripts/measure-budget.mjs
```

최근 측정: CPU 0.05%, RAM 146MB(자체 57MB + PS헬퍼 90MB), 2026-08-14, 32코어/64GB 머신, 더미 서비스 6개 30초 구동 기준. 재측정으로 재현성 확인(CPU 0.26%, RAM 146MB) — 예산 통과, RAM 여유는 약 4MB로 타이트한 편.
