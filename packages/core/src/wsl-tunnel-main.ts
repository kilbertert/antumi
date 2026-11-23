import { startTunnelHelper } from './wsl-tunnel'

// The tunnel helper as a program: `wsl.exe -d <distro> --exec node wsl-tunnel.mjs`, started by the
// Windows app (docs/WSL.md, 连接). stdout carries the sentinel and frames only, so anything
// said goes to stderr. It runs until the app closes its stdin, or a signal.

function fail(error: unknown): never {
  process.stderr.write(`[antumi-tunnel] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const helper = await startTunnelHelper({ stdin: process.stdin, stdout: process.stdout }).catch(fail)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void helper.stop())
}
const reason = await helper.stopped
if (reason) process.stderr.write(`[antumi-tunnel] ${reason.message}\n`)
process.exit(0)
