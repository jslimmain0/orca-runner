import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import type { Config, Kind, Priority, ServiceDef } from './types.js'

export class ConfigError extends Error {}

export const ORCA_HOME = join(homedir(), '.orca')
export const CONFIG_PATH = join(ORCA_HOME, 'services.yaml')

const BUILTIN = { heapMb: 512, cpus: 2, priority: 'belowNormal' as Priority }
const KINDS: Kind[] = ['spring', 'command']
const PRIORITIES: Priority[] = ['normal', 'belowNormal', 'idle']

export function loadConfig(path = CONFIG_PATH): Config {
  let src: string
  try { src = readFileSync(path, 'utf8') } catch {
    throw new ConfigError(`설정 파일이 없습니다: ${path}\n'orca add'로 서비스를 등록하세요.`)
  }
  return loadConfigFromString(src, path)
}

export function loadConfigFromString(src: string, path = '(inline)'): Config {
  const lc = new LineCounter()
  const doc = parseDocument(src, { lineCounter: lc })
  if (doc.errors.length > 0) {
    const e = doc.errors[0]
    throw new ConfigError(`${path} ${lc.linePos(e.pos[0]).line}행: YAML 문법 오류 — ${e.message}`)
  }
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>

  const lineOf = (keys: (string | number)[]): number => {
    const node = doc.getIn(keys, true) as { range?: [number, number, number] } | undefined
    return node?.range ? lc.linePos(node.range[0]).line : 1
  }
  const fail = (keys: (string | number)[], msg: string): never => {
    throw new ConfigError(`${path} ${lineOf(keys)}행: ${msg}`)
  }

  const d = (raw.defaults as { spring?: Partial<typeof BUILTIN> } | undefined)?.spring ?? {}
  const springDefaults = { ...BUILTIN, ...d }

  const rawServices = raw.services as Record<string, Record<string, unknown>> | undefined
  if (!rawServices || Object.keys(rawServices).length === 0) {
    throw new ConfigError(`${path}: services 항목이 비어 있습니다.`)
  }

  const services: ServiceDef[] = []
  for (const [name, s] of Object.entries(rawServices)) {
    const at = ['services', name]
    if (!KINDS.includes(s.kind as Kind)) fail(at, `${name}: kind는 spring|command 여야 합니다 (현재: ${s.kind})`)
    if (typeof s.dir !== 'string' || !/^[A-Za-z]:\\/.test(s.dir)) fail(at, `${name}: dir는 절대 경로여야 합니다`)
    const port = s.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail(at, `${name}: port는 1~65535 정수여야 합니다`)
    }
    if (s.kind === 'command' && typeof s.run !== 'string') fail(at, `${name}: command 서비스는 run이 필요합니다`)
    if (s.priority !== undefined && !PRIORITIES.includes(s.priority as Priority)) {
      fail(at, `${name}: priority는 normal|belowNormal|idle 중 하나여야 합니다`)
    }
    const base = s.kind === 'spring' ? springDefaults : { ...BUILTIN, heapMb: 0 }
    services.push({
      name,
      group: s.group as string | undefined,
      kind: s.kind as Kind,
      dir: s.dir as string,
      module: s.module as string | undefined,
      run: s.run as string | undefined,
      port: port as number,
      health: s.health as string | undefined,
      heapMb: (s.heapMb as number | undefined) ?? base.heapMb,
      cpus: (s.cpus as number | undefined) ?? base.cpus,
      priority: (s.priority as Priority | undefined) ?? base.priority,
      jvmArgs: (s.jvmArgs as string[] | undefined) ?? [],
    })
  }

  const seenPort = new Map<number, string>()
  for (const s of services) {
    const dup = seenPort.get(s.port)
    if (dup) throw new ConfigError(`${path} ${lineOf(['services', s.name, 'port'])}행: 포트 ${s.port}가 ${dup}와(과) 중복됩니다`)
    seenPort.set(s.port, s.name)
  }
  return { services }
}
