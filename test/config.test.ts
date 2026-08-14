import { describe, it, expect } from 'vitest'
import { loadConfigFromString, ConfigError } from '../src/config.js'

const VALID = `
defaults:
  spring:
    heapMb: 768
services:
  eis-server:
    group: tspay
    kind: spring
    dir: C:\\work\\eis
    module: eis-server
    port: 8081
    health: http://localhost:8081/actuator/health
  gateway:
    kind: command
    dir: C:\\work\\gw
    run: run-local.cmd
    port: 9000
`

describe('config', () => {
  it('유효한 yaml을 파싱하고 spring 기본값을 병합한다', () => {
    const cfg = loadConfigFromString(VALID)
    expect(cfg.services).toHaveLength(2)
    const eis = cfg.services[0]
    expect(eis.name).toBe('eis-server')
    expect(eis.heapMb).toBe(768)      // defaults.spring 오버라이드
    expect(eis.cpus).toBe(2)          // 내장 기본값
    expect(eis.priority).toBe('belowNormal')
  })

  it('command 서비스는 cpus 기본값이 0, spring 서비스는 2 (affinity는 opt-in)', () => {
    const cfg = loadConfigFromString(VALID)
    const gw = cfg.services.find(s => s.name === 'gateway')!
    const eis = cfg.services.find(s => s.name === 'eis-server')!
    expect(gw.cpus).toBe(0)
    expect(eis.cpus).toBe(2)
  })

  it('command 서비스에 run이 없으면 줄 번호와 함께 에러', () => {
    const bad = `services:\n  gw:\n    kind: command\n    dir: C:\\x\n    port: 9000\n`
    expect(() => loadConfigFromString(bad, 'C:\\cfg.yaml')).toThrowError(ConfigError)
    try { loadConfigFromString(bad, 'C:\\cfg.yaml') } catch (e) {
      expect((e as Error).message).toMatch(/C:\\cfg\.yaml/)
      expect((e as Error).message).toMatch(/\d행/)     // 줄 번호 (3행)
      expect((e as Error).message).toMatch(/run/)
    }
  })

  it('알 수 없는 kind는 에러', () => {
    const bad = `services:\n  a:\n    kind: docker\n    dir: C:\\x\n    port: 1\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/kind/)
  })

  it('포트 중복은 에러', () => {
    const bad = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r.cmd\n    port: 1\n  b:\n    kind: command\n    dir: C:\\y\n    run: r.cmd\n    port: 1\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/포트/)
  })

  it('services가 비어있으면 줄 번호와 함께 에러', () => {
    const bad = `services: {}\n`
    expect(() => loadConfigFromString(bad, 'C:\\cfg.yaml')).toThrowError(ConfigError)
    try { loadConfigFromString(bad, 'C:\\cfg.yaml') } catch (e) {
      const msg = (e as Error).message
      expect(msg).toMatch(/C:\\cfg\.yaml/)
      expect(msg).toContain('1')                       // 줄 번호 포함
      expect(msg).toMatch(/services/)
    }
  })

  it('잘못된 서비스 키 이름은 줄 번호와 함께 거부한다', () => {
    const bad = `services:\n  "bad name":\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n`
    expect(() => loadConfigFromString(bad, 'C:\\cfg.yaml')).toThrowError(/서비스 이름|이름/)
  })
})
