import { describe, it, expect } from 'vitest'
import { adviseGradleProps } from '../src/setup.js'

describe('adviseGradleProps', () => {
  it('데몬 힙이 2g 초과면 권고한다', () => {
    const a = adviseGradleProps('org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g\n')
    expect(a.some(x => x.includes('4g'))).toBe(true)
  })
  it('2g 이하면 힙 권고 없음', () => {
    const a = adviseGradleProps('org.gradle.jvmargs=-Xmx2g\n')
    expect(a.some(x => x.includes('데몬 힙'))).toBe(false)
  })
  it('병렬 워커 무제한이면 권고한다', () => {
    expect(adviseGradleProps('').some(x => x.includes('max-workers'))).toBe(true)
    expect(adviseGradleProps('org.gradle.workers.max=8\n').some(x => x.includes('max-workers'))).toBe(false)
  })
})
