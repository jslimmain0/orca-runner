import { watch, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'
import { loadConfig, ConfigError, CONFIG_PATH } from './config.js'
import type { Config } from './types.js'

/**
 * services.yaml 변경 감시. 에디터의 rename-replace 저장을 놓치지 않도록 파일이 아니라
 * 디렉토리를 감시하고 파일명으로 거른다. fs.watch는 이벤트 기반(ReadDirectoryChangesW) —
 * 주기 작업이 없어 자원 예산에 영향이 없다. 디바운스 타이머는 이벤트가 있을 때만 생긴다.
 */
export function watchConfig(
  onReload: (cfg: Config) => void,
  onError: (msg: string) => void,
  path = CONFIG_PATH,
  debounceMs = 500,
): () => void {
  const dir = dirname(path)
  const file = basename(path).toLowerCase()
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher
  try {
    watcher = watch(dir, (_event, filename) => {
      if (!filename || filename.toLowerCase() !== file) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        try { onReload(loadConfig(path)) }
        catch (e) { onError(e instanceof ConfigError ? e.message : (e as Error).message) }
      }, debounceMs)
    })
  } catch {
    return () => {}   // 디렉토리 없음 등 — 감시 없이 진행 (첫 orca add 전)
  }
  watcher.on('error', () => { /* 감시 실패는 치명적이지 않다 — 핫로드만 비활성화됨 */ })
  return () => { if (timer) clearTimeout(timer); watcher.close() }
}
