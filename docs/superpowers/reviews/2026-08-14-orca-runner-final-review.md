# orca 러너 최종 리뷰 기록 (2026-08-14)

브랜치: feature/orca-runner (ed4c5b9..b8046a6, 31+2 커밋). 최종 상태: 테스트 65/65, `tsc --noEmit` 클린, 자원 예산 실측 통과(CPU 0.05~0.26% / RAM 146MB, 예산 1%/150MB).

## 최종 리뷰 → 수정 웨이브에서 해결된 항목

- F1: 헬스 타임아웃 시 좀비 프로세스 잔류 + 재시작 시 이중 스폰/상태 오염 → exit 핸들러 가드 + 타임아웃 시 killTree (회귀 테스트 포함)
- F2: BUILDING 중 stop/종료 시 Gradle 빌드 트리 고아 → buildChild 추적 + BUILDING stop 경로 (회귀 테스트 포함)
- F3: 단일 서비스 시작 시 Gradle 데몬 잔류 → 빌드 직후 gradleStop
- F4: setup 승격 시 임시 경로에 공백 있으면 실패 → -File 인자 이중따옴표 내장
- F5: command 서비스 affinity가 기본 적용(스펙은 opt-in) → 기본 cpus 0
- F6: orca add 실패 시 exit code 0 → 1 + non-Error 처리
- F7: setup에 JAVA_HOME 확인 추가
- F8: README에 한계 2건 문서화 (command MEM/CPU는 래퍼 기준, affinity는 opt-in·래퍼 적용)

## 파킹된 잔여 항목 (실재하나 머지 비차단, 후속 수정 대상)

1. **빌드 직후 gradleStop 구간의 stop 무시 레이스** — 빌드 완료 후 STARTING 전환 전 수 초 구간에 stop()이 조용히 no-op (buildChild는 이미 해제, pid는 아직 없음). 결과는 키 입력 1회 유실이며 UP 표시 후 다시 s로 복구 가능. 후속 수정안: stop()의 BUILDING 분기가 buildChild 없어도 e.stopping을 세팅하고, start()가 spawn 전에 e.stopping을 확인.
2. stop()을 ERROR 상태 서비스에 호출하면 pid만 지워지고 상태가 ERROR로 유지 (대시보드 UX상 ERROR는 재시작 대상이라 실질 영향 없음)

## 문서화된 한계 (README 반영됨)

- command 서비스의 MEM/CPU는 cmd 래퍼 프로세스 측정값 (spring은 정확)
- command affinity는 명시 설정 시에만, 현재 래퍼 프로세스에 적용
- RAM 예산 여유가 얇음 (146/150MB, PS 헬퍼 기저 ~89MB) — 실서비스 6개로 재측정 권장

## 태스크별 이연 마이너 전수 목록

SDD 진행 원장(비추적 스크래치)에 기록돼 있던 항목 중 머지 후 참고 가치가 있는 것: whoHoldsPort의 netstat 스폰 실패 미캐치(수퍼바이저 try/catch가 흡수함 — 확인됨), 로그 뷰 스크롤 상한 없음(과스크롤 시 빈 화면, ↓로 복구), 로그 롤링이 LogWriter 생성 시에만 수행(장기 세션 중 10MB 초과 가능), config의 jvmArgs/heapMb 타입 미검증, `orca --help` 미지원(그룹명으로 해석됨).
