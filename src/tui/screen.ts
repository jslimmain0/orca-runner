export function renderDiff(prev: string[], next: string[]): string {
  let out = ''
  const rows = Math.max(prev.length, next.length)
  for (let i = 0; i < rows; i++) {
    if (prev[i] === next[i]) continue
    out += `\x1b[${i + 1};1H\x1b[2K` + (next[i] ?? '')
  }
  return out
}

export class Screen {
  private prev: string[] = []
  enter(): void {
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J')
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
  }
  exit(): void {
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    process.stdout.write('\x1b[?25h\x1b[?1049l')
  }
  render(lines: string[]): void {
    const out = renderDiff(this.prev, lines)
    if (out) process.stdout.write(out)
    this.prev = [...lines]
  }
  reset(): void {
    this.prev = []
    process.stdout.write('\x1b[2J')
  }
}
