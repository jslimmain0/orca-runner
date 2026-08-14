import { describe, it, expect } from 'vitest'
import { removeService } from '../src/remove.js'
import { loadConfigFromString } from '../src/config.js'

const SRC = '# 주석 보존 확인\nservices:\n  keep:\n    kind: command\n    dir: C:\\k\n    run: r\n    port: 1\n  gone:\n    kind: command\n    dir: C:\\g\n    run: r\n    port: 2\n'

describe('removeService', () => {
  it('지정 서비스만 제거하고 주석을 보존한다', () => {
    const out = removeService(SRC, 'gone')
    expect(out).toContain('# 주석 보존 확인')
    const cfg = loadConfigFromString(out)
    expect(cfg.services.map(s => s.name)).toEqual(['keep'])
  })
  it('미등록 이름은 throw', () => {
    expect(() => removeService(SRC, 'nope')).toThrowError(/등록돼 있지 않습니다/)
  })
})
