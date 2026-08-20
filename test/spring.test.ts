import { describe, it, expect } from 'vitest'
import { javaArgs, findBootJar, buildJar } from '../src/spring.js'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ServiceDef } from '../src/types.js'

const def: ServiceDef = {
  name: 'eis', kind: 'spring', dir: 'C:\\work\\eis', port: 8081,
  heapMb: 512, cpus: 2, priority: 'belowNormal', metaspaceMb: 256, jvmArgs: ['-Dspring.profiles.active=local'], env: {},
}

describe('spring', () => {
  it('javaArgs가 자원 제한 플래그를 만든다', () => {
    expect(javaArgs(def, 'C:\\x\\app.jar')).toEqual([
      '-Xmx512m', `-XX:MaxMetaspaceSize=${def.metaspaceMb}m`, '-XX:ActiveProcessorCount=2',
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

  it('buildJar: 공백 있는 디렉토리에서도 성공한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca sp-'))
    mkdirSync(join(dir, 'build', 'libs'), { recursive: true })
    writeFileSync(join(dir, 'build', 'libs', 'fake-1.0.jar'), 'jar')
    writeFileSync(join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n')
    const testDef: ServiceDef = { name: 'sp', kind: 'spring', dir, port: 1, heapMb: 512, cpus: 2, priority: 'belowNormal', metaspaceMb: 256, jvmArgs: [], env: {} }
    const jar = await buildJar(testDef, new PassThrough())
    expect(jar.endsWith('fake-1.0.jar')).toBe(true)
  }, 15000)
})
