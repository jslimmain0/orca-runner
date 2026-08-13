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
}
