import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestSourceMtime, needsRebuild, loadCache, saveCache } from '../src/buildCache.js'

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bc-'))
  mkdirSync(join(dir, 'src', 'main'), { recursive: true })
  mkdirSync(join(dir, 'build', 'libs'), { recursive: true })   // 스캔 제외 대상
  writeFileSync(join(dir, 'build.gradle'), 'plugins {}')
  writeFileSync(join(dir, 'src', 'main', 'App.java'), 'class App {}')
  writeFileSync(join(dir, 'build', 'libs', 'app.jar'), 'jar')
  return dir
}

describe('buildCache', () => {
  it('build/ 밑은 무시하고 소스의 최신 mtime을 찾는다', () => {
    const dir = makeProject()
    const old = Date.now() / 1000 - 3600
    utimesSync(join(dir, 'build.gradle'), old, old)
    utimesSync(join(dir, 'src', 'main', 'App.java'), old, old)
    const jarTime = Date.now() / 1000
    utimesSync(join(dir, 'build', 'libs', 'app.jar'), jarTime, jarTime)
    const mtime = latestSourceMtime(dir)
    expect(mtime).toBeLessThan(jarTime * 1000 - 1000)   // jar가 아니라 소스 기준
  })

  it('기록이 없으면 재빌드 필요', () => {
    expect(needsRebuild(makeProject(), undefined)).toBe(true)
  })

  it('기록이 소스보다 새로우면 재빌드 불필요, 소스를 다시 만지면 필요', () => {
    const dir = makeProject()
    const rec = { builtAt: Date.now() + 5000, jar: 'x.jar' }
    expect(needsRebuild(dir, rec)).toBe(false)
    const future = Date.now() / 1000 + 60
    utimesSync(join(dir, 'src', 'main', 'App.java'), future, future)
    expect(needsRebuild(dir, rec)).toBe(true)
  })

  it('cache.json 저장/로드 라운드트립', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orca-bc-')), 'cache.json')
    saveCache({ eis: { builtAt: 123, jar: 'a.jar' } }, file)
    expect(loadCache(file)).toEqual({ eis: { builtAt: 123, jar: 'a.jar' } })
    expect(loadCache(join(tmpdir(), 'no-such-orca-cache.json'))).toEqual({})
  })
})
