import { randomBytes } from 'node:crypto'
import { nodeWslHost, runInDistro, type WslHost } from './wsl-command'

export type WslLoginEnvironment = { path: string; home: string; shell: string }

export type WslAskOptions = { timeoutMs?: number; host?: WslHost }

// A first ask may boot the distro, and a login shell may load nvm and the like.
const LOGIN_TIMEOUT_MS = 20_000

// Finds the user's shell and runs it as a login shell; bash and zsh read ~/.bashrc or ~/.zshrc,
// where nvm and the like add themselves, only when interactive too. $1 marks the shell's line,
// $2 is what the shell runs.
const LOGIN_SCRIPT = [
  'shell=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7)',
  '[ -x "$shell" ] || shell=/bin/sh',
  'printf \'%s%s\\n\' "$1" "$shell"',
  'case "${shell##*/}" in',
  '  bash|zsh) exec "$shell" -ilc "$2" ;;',
  '  *) exec "$shell" -lc "$2" ;;',
  'esac'
].join('\n')

// Unique per ask: a banner or rc file printing to stdout cannot fake one.
const newMark = () => `__ANTUMI_${randomBytes(8).toString('hex')}_`

// The command each shell runs: echo and printenv read the same in sh, bash, zsh and fish, where
// "$PATH" would not ($PATH is a list in fish).
function printing(mark: string): string {
  return `echo ${mark}path; printenv PATH; echo ${mark}home; printenv HOME; echo ${mark}end`
}

// What sits between two marker lines, or null when either is missing.
function between(lines: string[], from: string, to: string): string | null {
  const start = lines.indexOf(from)
  const end = lines.indexOf(to, start + 1)
  return start === -1 || end === -1 ? null : lines.slice(start + 1, end).join('\n')
}

export function parseLoginEnvironment(stdout: string, mark: string): WslLoginEnvironment | null {
  const lines = stdout.split(/\r?\n/)
  const shell = lines.find((line) => line.startsWith(`${mark}/`))?.slice(mark.length)
  const path = between(lines, `${mark}path`, `${mark}home`)
  const home = between(lines, `${mark}home`, `${mark}end`)
  return shell && path && home ? { path, home, shell } : null
}

// The distro's login PATH and HOME, which `--exec` does not have, asked afresh on each call.
// Null when it could not be asked.
export async function loginEnvironment(distro: string | null, options: WslAskOptions = {}): Promise<WslLoginEnvironment | null> {
  const mark = newMark()
  const result = await runInDistro(distro, ['/bin/sh', '-c', LOGIN_SCRIPT, 'sh', mark, printing(mark)], {
    host: options.host ?? nodeWslHost,
    timeoutMs: options.timeoutMs ?? LOGIN_TIMEOUT_MS
  })
  // An rc file's failing last line sets the exit code; the markers say whether it got through.
  return result.timedOut ? null : parseLoginEnvironment(result.stdout, mark)
}

// The PATH to search in the distro: WSL appends the Windows PATH under /mnt/, and a Windows
// program found there must not stand in for a Linux one; relative entries would give no
// absolute path.
export function linuxSearchPath(path: string): string {
  return path.split(':').filter((dir) => dir.startsWith('/') && dir !== '/mnt' && !dir.startsWith('/mnt/')).join(':')
}

// "Missing" only when the shell said so; anything else is "could not ask".
export type LinuxExecutable = { status: 'found'; path: string } | { status: 'missing' } | { status: 'unknown' }

// How sh's `command -v` says it found nothing (bash 1, dash and busybox 127); wsl.exe's own
// failures exit otherwise.
const NOT_FOUND_CODES = new Set([1, 127])

// The absolute path of `name` on `path` in the distro. `command -v` is a shell builtin, so it runs
// under /bin/sh, with the name as an argument rather than in the script.
export async function findLinuxExecutable(distro: string | null, name: string, path: string, options: WslAskOptions = {}): Promise<LinuxExecutable> {
  if (!name || name.includes('/') || name.startsWith('-')) return { status: 'missing' }
  const result = await runInDistro(distro, ['/bin/sh', '-c', 'command -v "$1"', 'sh', name], {
    host: options.host ?? nodeWslHost,
    timeoutMs: options.timeoutMs ?? LOGIN_TIMEOUT_MS,
    env: { PATH: linuxSearchPath(path) }
  })
  const found = result.stdout.trim()
  if (result.code === 0 && found.startsWith('/') && !found.includes('\n')) return { status: 'found', path: found }
  return result.code !== null && NOT_FOUND_CODES.has(result.code) && !found ? { status: 'missing' } : { status: 'unknown' }
}
