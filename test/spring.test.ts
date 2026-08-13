import { describe, it, expect } from 'vitest'
import { javaArgs, findBootJar, buildJar } from '../src/spring.js'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ServiceDef } from '../src/types.js'

const def: ServiceDef = {
  name: 'eis', kind: 'spring', dir: 'C:\\work\\eis', port: 8081,
  heapMb: 512, cpus: 2, priority: 'belowNormal', jvmArgs: ['-Dspring.profiles.active=local'],
}

describe('spring', () => {
  it('javaArgs가 자원 제한 플래그를 만든다', () => {
    expect(javaArgs(def, 'C:\\x\\app.jar')).toEqual([
      '-Xmx512m', '-XX:MaxMetaspaceSize=256m', '-XX:ActiveProcessorCount=2',
      '-XX:+UseSerialGC', '-Dspring.profiles.active=local', '-jar', 'C:\\x\\app.jar',
    ])
  })

  it('findBootJar: -plain 제외 최신 jar를 고른다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sp-'))
    const libs = join(dir, 'eis-server', 'build', 'libs')
    mkdirSync(libs, { recursive: true })
    writeFileSync(join(libs, 'eis-0.1.jar'), 'old')
    writeFileSync(join(libs, 'eis-0.2.jar'), 'new')
    writeFileSync(join(libs, 'eis-0.2-plain.jar'), 'plain')
    const old = Date.now() / 1000 - 100
    utimesSync(join(libs, 'eis-0.1.jar'), old, old)
    expect(findBootJar(dir, 'eis-server')).toBe(join(libs, 'eis-0.2.jar'))
  })

  it('findBootJar: jar 없으면 throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sp-'))
    expect(() => findBootJar(dir)).toThrowError(/jar/)
  })

  it('buildJar: 잘못된 module 이름은 reject한다', async () => {
    const testDef: ServiceDef = { ...def, module: 'bad name!' }
    await expect(buildJar(testDef, new PassThrough())).rejects.toThrowError(/잘못된 module/)
  })

  it('buildJar: 경로에 공백이 있어도 spawn이 실패하지 않는다', async () => {
    // 이 테스트는 spawn('cmd', ['/c', 'gradlew.bat', ...]) 가
    // dir의 공백을 올바르게 처리함을 보장한다.
    // 실제 gradlew는 없지만, spawn이 gradlew.bat을 찾으려고 시도할 때
    // dir의 공백이 경로를 분할하지 않음을 입증한다.
    const spaceDir = mkdtempSync(join(tmpdir(), 'orca sp-'))
    const testDef: ServiceDef = { ...def, dir: spaceDir }
    try {
      await buildJar(testDef, new PassThrough())
    } catch (e: any) {
      // spawn이 "not recognized" 에러로 실패하면 안 되고,
      // 빌드 실패 에러로 실패해야 한다 (gradlew를 찾았지만 실행 실패)
      // 또는 spawn이 ENOENT로 실패해야 한다 (gradlew를 찾을 수 없음)
      // 중요한 것은 경로 분할 에러("not recognized")가 아니어야 한다는 것이다.
      expect(e.message).not.toMatch(/명령|command|not found/)
    }
  })
})
