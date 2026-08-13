import { describe, it, expect } from 'vitest'
import { adviseGradleProps, buildExclusionScript, elevationCommand } from '../src/setup.js'

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

describe('buildExclusionScript', () => {
  it('경로들을 Add-MpPreference 명령어로 변환한다', () => {
    const script = buildExclusionScript(['C:\\a', "C:\\O'Brien Dir"])
    expect(script).toContain("Add-MpPreference -ExclusionPath 'C:\\a'")
    expect(script).toContain("Add-MpPreference -ExclusionPath 'C:\\O''Brien Dir'")
    expect(script).toContain('Write-Host "Defender 예외 등록 완료. 이 창은 곧 닫힙니다."')
    expect(script).toContain('Start-Sleep -Seconds 5')
  })
  it('각 경로가 별도 줄에 있다', () => {
    const script = buildExclusionScript(['C:\\a', 'C:\\b'])
    const lines = script.split('\r\n').filter(l => l.startsWith('Add-MpPreference'))
    expect(lines).toHaveLength(2)
  })
  it('따옴표를 두 배로 이스케이프한다', () => {
    const script = buildExclusionScript(["C:\\path'with'quotes"])
    expect(script).toContain("'C:\\path''with''quotes'")
  })
})

describe('elevationCommand', () => {
  it('Start-Process 기반 PowerShell 명령어를 생성한다', () => {
    const cmd = elevationCommand('C:\\Temp Dir\\x.ps1')
    expect(cmd).toContain('Start-Process powershell -Verb RunAs')
    expect(cmd).toContain('-ArgumentList')
  })
  it('스크립트 경로를 -File 인자로 포함한다', () => {
    const cmd = elevationCommand('C:\\Temp Dir\\x.ps1')
    expect(cmd).toContain("'-File','C:\\Temp Dir\\x.ps1'")
  })
  it('경로의 따옴표를 두 배로 이스케이프한다', () => {
    const cmd = elevationCommand("C:\\path'with'quotes\\x.ps1")
    expect(cmd).toContain("'C:\\path''with''quotes\\x.ps1'")
  })
})
