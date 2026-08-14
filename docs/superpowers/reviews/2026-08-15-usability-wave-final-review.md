# 사용성 웨이브(P0+P1) 최종 리뷰 기록 (2026-08-15)

브랜치: feature/usability-p0-p1 (f866bdc..c54e832, 22커밋). 최종 상태: 테스트 122/122 (65→122), `tsc --noEmit` 클린.

## 구현된 것 (협의회 로드맵 P0 5건 + P1 8건)

- **P0-1** `q` 안전화: 로그 뷰 q=복귀, 빌드/기동 중 2단계 확인, Ctrl+C(raw mode 데이터로 선처리)=강제 종료, 종료 후 `✔ N개 모두 종료 확인` 리포트
- **P0-2** 진단 루프: 모든 ERROR/CRASHED 사유가 로그 파일(`[ORCA] ... ERROR:`)과 상태에 기록, 종료 코드/시그널 표시, 헬스 타임아웃에 마지막 프로브 사유
- **P0-3** 대시보드: 상태별 색(NO_COLOR 존중), `BUILDING 42s` 경과 시간, 시스템/서비스 합계 헤더 분리
- **P0-4** `orca add`: 필드별 즉시 검증(실패 필드만 재질문), 연속 등록 루프, 그룹 힌트+대소문자 통일, 매 회차 디스크 재로드
- **P0-5** `orca status [--json]` + run.json v2(세션 소유): 다른 터미널 세션 안내, 고아 목록에 포트·응답 병기
- **P1-1** `--help`(첫 10분 경로 섹션)/예약어 정책/`orca groups`
- **P1-2** headless `up/down/start/stop`: detached 스폰(자연 종료 — E2E로 실증), down은 dry-run 기본+`--yes`, 타 세션 소유 시 전체 거부, up 멱등(이미 실행 중이면 exit 0)
- **P1-3** 세션 재개: 종료 시 스냅샷, 재실행 배너 `[u] 재개`, 실패했던 서비스 안내, `orca up` 기본 대상(`--all`로 전체)
- **P1-4** `x` SKIP(IDE) 토글: startAll 제외, 기존 3초 tick 편승 포트 감시로 `SKIP(!)` 승격
- **P1-5** 숫자 키 즉시 이동(행 번호 표시), Enter=토글, `r`=재시작(stop이 상태 정착까지 대기)
- **P1-6** 로그 뷰: 스크롤 상한(maxOffset 단일 헬퍼), `[최신]/[-N줄]` 위치, 빈 로그 안내
- **P1-7** `orca remove`: 번호/이름 선택, 마지막 서비스 경고, 실행 중이면 거부, 빈 설정 유효화(전체 리플)
- **P1-8** 설정 타입 검증(defaults.spring 포함)

## 과정에서 리뷰가 잡아낸 주요 결함 (전부 수정됨)

- **Critical**: `orca up`이 성공 출력 후 영원히 종료 안 됨(자식 핸들/파이프 ref) → detached+fd-stdio 스폰, 실서브프로세스 E2E로 판별 실증
- raw mode에서 Ctrl+C가 확인창에 걸림 / stop() 직후 start()가 옛 상태를 보고 no-op하는 재시작 레이스 / tick 오버랩 시 stats 응답 오배정 / 마지막 서비스 삭제 시 설정 파괴 후 성공 보고 / STARTING 119s 컬럼 밀림 / LogWriter 비동기 에러로 러너 크래시 가능성 / defaults.spring 무검증 병합 등

## 파킹/이연 항목 (비차단, 후속 참고)

- spring+headless 조합 미테스트 (로그 파일 이중 오픈 창 — append 모드라 무해 추정)
- `status --json`의 owner가 한글 표시 문자열 (자동화용 숫자 필드 추가 여지)
- 한글 폭(wide glyph) 컬럼 계산은 JS length 기준 (기존 클래스, 표시상 문제만)
- headless(owner 0) 서비스를 TUI가 채택하지 못함 — P2-1 이연 (README에 소유 세션 동작 문서화됨)
- dead owner=0 잔재 엔트리 주기 정리, Ctrl+C E2E 정식 테스트 승격, help 문자열 동기화 테스트
- 자원 예산 재측정 권장 (새 주기 작업은 없음 — tick 편승뿐, README 수치는 웨이브 이전 실측)

전체 이연 마이너 상세 목록은 SDD 원장에 있었고 삭제 전 트리아지 결과: MUST-FIX 항목은 전부 이번 수정 웨이브에 포함, 나머지는 DEFER-OK 판정.
