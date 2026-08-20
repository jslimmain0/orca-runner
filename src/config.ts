import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import type { Config, Kind, Priority, ServiceDef } from './types.js'

export class ConfigError extends Error {}

export const ORCA_HOME = join(homedir(), '.orca')
export const CONFIG_PATH = join(ORCA_HOME, 'services.yaml')

export const RESERVED_WORDS = ['add', 'setup', 'status', 'up', 'down', 'start', 'stop', 'remove', 'groups', 'advise', 'help'] as const

const BUILTIN = { heapMb: 512, cpus: 2, priority: 'belowNormal' as Priority, metaspaceMb: 256 }
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

  const posInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0
  const d = (raw.defaults as { spring?: Partial<typeof BUILTIN> } | undefined)?.spring ?? {}

  // Validate defaults.spring before merging
  const dAt = ['defaults', 'spring']
  if (d.heapMb !== undefined && !posInt(d.heapMb)) fail(dAt, 'defaults.spring.heapMb는 0 이상의 정수여야 합니다')
  if (d.metaspaceMb !== undefined && !posInt(d.metaspaceMb)) fail(dAt, 'defaults.spring.metaspaceMb는 0 이상의 정수여야 합니다')
  if (d.cpus !== undefined && !posInt(d.cpus)) fail(dAt, 'defaults.spring.cpus는 0 이상의 정수여야 합니다')
  if (d.priority !== undefined && !PRIORITIES.includes(d.priority as Priority)) fail(dAt, 'defaults.spring.priority는 normal|belowNormal|idle 중 하나여야 합니다')

  const springDefaults = { ...BUILTIN, ...d }

  const rawServices = raw.services as Record<string, Record<string, unknown>> | undefined
  if (!rawServices || Object.keys(rawServices).length === 0) {
    return { services: [] }
  }

  const services: ServiceDef[] = []
  for (const [name, s] of Object.entries(rawServices)) {
    const at = ['services', name]
    if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(at, `잘못된 서비스 이름: '${name}' (영문/숫자/._- 만 허용)`)
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
    if (s.heapMb !== undefined && !posInt(s.heapMb)) fail(at, `${name}: heapMb는 0 이상의 정수여야 합니다`)
    if (s.metaspaceMb !== undefined && !posInt(s.metaspaceMb)) fail(at, `${name}: metaspaceMb는 0 이상의 정수여야 합니다`)
    if (s.cpus !== undefined && !posInt(s.cpus)) fail(at, `${name}: cpus는 0 이상의 정수여야 합니다`)
    if (s.jvmArgs !== undefined && (!Array.isArray(s.jvmArgs) || s.jvmArgs.some(a => typeof a !== 'string'))) {
      fail(at, `${name}: jvmArgs는 문자열 배열이어야 합니다 (예: jvmArgs: ["-Dspring.profiles.active=local"])`)
    }
    for (const f of ['health', 'run', 'group', 'module'] as const) {
      if (s[f] !== undefined && typeof s[f] !== 'string') fail(at, `${name}: ${f}은(는) 문자열이어야 합니다`)
    }
    const env: Record<string, string> = {}
    if (s.env !== undefined) {
      if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) fail(at, `${name}: env는 키-값 맵이어야 합니다`)
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(at, `${name}: env 키 '${k}'는 영문/숫자/_ 형식이어야 합니다`)
        if (typeof v === 'string') env[k] = v
        else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v)
        else fail(at, `${name}: env.${k} 값은 문자열/숫자/불리언이어야 합니다`)
      }
    }
    // command 서비스는 cpus 기본값이 0 — affinity는 명시적으로 설정한 경우에만 적용 (opt-in)
    const base = s.kind === 'spring' ? springDefaults : { heapMb: 0, cpus: 0, priority: BUILTIN.priority, metaspaceMb: 0 }
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
      metaspaceMb: (s.metaspaceMb as number | undefined) ?? base.metaspaceMb,
      cpus: (s.cpus as number | undefined) ?? base.cpus,
      priority: (s.priority as Priority | undefined) ?? base.priority,
      jvmArgs: (s.jvmArgs as string[] | undefined) ?? [],
      env,
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
