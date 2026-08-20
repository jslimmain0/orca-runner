import { describe, it, expect } from 'vitest'
import { parseKey, parseDigit } from '../src/tui/keys.js'
import { renderDiff } from '../src/tui/screen.js'

describe('keys', () => {
  it('방향키/문자키/Ctrl+C를 파싱한다', () => {
    expect(parseKey(Buffer.from('\x1b[A'))).toBe('up')
    expect(parseKey(Buffer.from('\x1b[B'))).toBe('down')
    expect(parseKey(Buffer.from('\x1b'))).toBe('esc')
    expect(parseKey(Buffer.from('s'))).toBe('s')
    expect(parseKey(Buffer.from('Q'))).toBe('q')
    expect(parseKey(Buffer.from('\x03'))).toBe('q')
    expect(parseKey(Buffer.from('z'))).toBe('other')
  })

  it('r 키와 숫자 키를 파싱한다', () => {
    expect(parseKey(Buffer.from('r'))).toBe('r')
    expect(parseKey(Buffer.from('R'))).toBe('r')
    expect(parseDigit(Buffer.from('3'))).toBe(3)
    expect(parseDigit(Buffer.from('0'))).toBeNull()
    expect(parseDigit(Buffer.from('a'))).toBeNull()
  })

  it('v 키(권장 적용)를 파싱한다', () => {
    expect(parseKey(Buffer.from('v'))).toBe('v')
    expect(parseKey(Buffer.from('V'))).toBe('v')
  })
})

describe('renderDiff', () => {
  it('바뀐 줄만 커서이동+클리어와 함께 출력한다', () => {
    const out = renderDiff(['a', 'b', 'c'], ['a', 'B', 'c'])
    expect(out).toBe('\x1b[2;1H\x1b[2KB')
  })
  it('줄이 늘어나면 새 줄을, 줄어들면 빈 줄을 그린다', () => {
    expect(renderDiff(['a'], ['a', 'b'])).toBe('\x1b[2;1H\x1b[2Kb')
    expect(renderDiff(['a', 'b'], ['a'])).toBe('\x1b[2;1H\x1b[2K')
  })
  it('동일 프레임은 빈 문자열', () => {
    expect(renderDiff(['a'], ['a'])).toBe('')
  })
})
