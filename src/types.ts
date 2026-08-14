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
  startedAt?: number     // 현재 phase(BUILDING/STARTING) 진입 시각 ms — 경과 시간 표시용
  skipped?: boolean      // IDE 등에서 별도 관리 중 — orca 시작 대상에서 제외
  skipPortUp?: boolean   // skipped 상태에서 포트 리슨 여부 (tick에서 갱신) — false면 IDE에서도 내려간 듯
}
