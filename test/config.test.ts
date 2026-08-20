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

  it('services가 비어있으면 빈 배열을 반환한다', () => {
    const empty = `services: {}\n`
    expect(loadConfigFromString(empty).services).toEqual([])
  })

  it('잘못된 서비스 키 이름은 줄 번호와 함께 거부한다', () => {
    const bad = `services:\n  "bad name":\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n`
    expect(() => loadConfigFromString(bad, 'C:\\cfg.yaml')).toThrowError(/서비스 이름|이름/)
  })

  it('heapMb가 숫자가 아니면 에러', () => {
    const bad = `services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    heapMb: many\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/heapMb/)
  })

  it('jvmArgs가 배열이 아니면 에러', () => {
    const bad = `services:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n    jvmArgs: -Dfoo\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/jvmArgs/)
  })

  it('cpus가 음수면 에러', () => {
    const bad = `services:\n  a:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n    cpus: -2\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/cpus/)
  })

  it('defaults.spring.heapMb가 숫자가 아니면 에러', () => {
    const bad = `defaults:\n  spring:\n    heapMb: many\nservices:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/defaults\.spring\.heapMb/)
  })

  it('defaults.spring.priority 오타는 에러', () => {
    const bad = `defaults:\n  spring:\n    priority: turbo\nservices:\n  a:\n    kind: spring\n    dir: C:\\x\n    port: 1\n`
    expect(() => loadConfigFromString(bad)).toThrowError(/defaults\.spring\.priority/)
  })

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
})
