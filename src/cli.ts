export const VERSION = '0.1.0'

const arg = process.argv[2]
if (arg === '--version') {
  console.log(VERSION)
  process.exit(0)
}
console.log('orca: 아직 구현 중입니다. --version 만 지원.')
