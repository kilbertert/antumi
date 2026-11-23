// The backend's lifecycle rules as a program, run inside a WSL distro by the Windows app:
// `wsl.exe -d <distro> --exec node backend-control.mjs <command> ...` (docs/WSL.md, 安装和启动).
// Exit 0 with one line of JSON on stdout; 1 with a line on stderr and nothing on stdout.

// stdout carries that line only, so everything else said goes to stderr, the lifecycle rules'
// console.log lines included. Set before backend-control is loaded, hence its dynamic import.
console.log = (...args: unknown[]) => console.error(...args)
console.info = console.log
console.debug = console.log

const { backendControl } = await import('./backend-control')

function fail(message: string): never {
  process.stderr.write(`[antumi-backend-control] ${message.replace(/\s*\n\s*/g, ' ')}\n`)
  process.exit(1)
}

const outcome = await backendControl(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
if ('usage' in outcome) fail(outcome.usage)
process.stdout.write(`${JSON.stringify(outcome.answer)}\n`, () => process.exit(0))

// No static import (see above), so this is what makes it a module, for top-level await.
export {}
