import { describe, it, expect } from 'vitest'
import { appendService, validateName, validatePort, resolveGroup } from '../src/add.js'
import { loadConfigFromString } from '../src/config.js'

describe('appendService', () => {
  it('빈 파일에서 유효한 설정을 만든다', () => {
    const out = appendService('', { name: 'eis', kind: 'spring', dir: 'C:\\work\\eis', port: 8081 })
    const cfg = loadConfigFromString(out)
    expect(cfg.services[0].name).toBe('eis')
    expect(cfg.services[0].heapMb).toBe(512)
  })

  it('기존 서비스와 주석을 보존한다', () => {
    const src = '# 내 서비스들\nservices:\n  gw:\n    kind: command\n    dir: C:\\gw\n    run: r.cmd\n    port: 9000\n'
    const out = appendService(src, { name: 'eis', kind: 'spring', dir: 'C:\\eis', port: 8081, group: 'tspay' })
    expect(out).toContain('# 내 서비스들')
    const cfg = loadConfigFromString(out)
    expect(cfg.services.map(s => s.name).sort()).toEqual(['eis', 'gw'])
    expect(cfg.services.find(s => s.name === 'eis')!.group).toBe('tspay')
  })

  it('중복 이름은 throw', () => {
    const src = 'services:\n  eis:\n    kind: command\n    dir: C:\\x\n    run: r\n    port: 1\n'
    expect(() => appendService(src, { name: 'eis', kind: 'command', dir: 'C:\\y', run: 'r', port: 2 })).toThrowError(/이미/)
  })

  it('command인데 run이 없으면 검증 단계에서 걸러진다', () => {
    const out = appendService('', { name: 'bad', kind: 'command', dir: 'C:\\x', port: 1 })
    expect(() => loadConfigFromString(out)).toThrowError()
  })

  it('빈 서비스 이름은 throw', () => {
    expect(() => appendService('', { name: '', kind: 'spring', dir: 'C:\\x', port: 8081 })).toThrowError(/잘못된 서비스 이름/)
  })

  it('공백을 포함한 서비스 이름은 throw', () => {
    expect(() => appendService('', { name: 'bad name', kind: 'spring', dir: 'C:\\x', port: 8081 })).toThrowError(/잘못된 서비스 이름/)
  })

  it('bare services 키 (값 없음)에 서비스를 추가한다', () => {
    const out = appendService('services:\n', { name: 'eis', kind: 'spring', dir: 'C:\\eis', port: 8081 })
    const cfg = loadConfigFromString(out)
    expect(cfg.services[0].name).toBe('eis')
  })

  it('services: null에 서비스를 추가한다', () => {
    const out = appendService('services: null\n', { name: 'eis', kind: 'spring', dir: 'C:\\eis', port: 8081 })
    const cfg = loadConfigFromString(out)
    expect(cfg.services[0].name).toBe('eis')
  })
})

describe('add validators', () => {
  it('validateName: 형식/중복', () => {
    expect(validateName('eis', [])).toBeNull()
    expect(validateName('', [])).toMatch(/잘못된 서비스 이름/)
    expect(validateName('bad name', [])).toMatch(/잘못된 서비스 이름/)
    expect(validateName('eis', ['eis'])).toMatch(/이미 등록/)
  })
  it('validatePort: 범위/중복에 점유 서비스명 명시', () => {
    const cfg = { services: [{ name: 'eis-server', port: 8081 }] }
    expect(validatePort('8082', cfg)).toEqual({ ok: true, port: 8082 })
    expect(validatePort('abc', cfg)).toMatchObject({ ok: false })
    expect(validatePort('0', cfg)).toMatchObject({ ok: false })
    const dup = validatePort('8081', cfg)
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.msg).toContain('eis-server')
  })
  it('resolveGroup: trim과 대소문자 통일 확인', () => {
    expect(resolveGroup(' tspay ', ['tspay'])).toEqual({ value: 'tspay' })
    expect(resolveGroup('Tspay', ['tspay'])).toEqual({ value: 'Tspay', needsConfirm: 'tspay' })
    expect(resolveGroup('infra', ['tspay'])).toEqual({ value: 'infra' })
  })
})
