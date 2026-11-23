import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { CoreEndpoint } from '@antumi/protocol'
import type { WslBackendProblem } from '../../shared/backend-location'
import { nodeWslHost, runInDistro, spawnInDistro, type WslHost, type WslResult } from './wsl-command'
import { listDistros } from './wsl-distros'
import { findLinuxExecutable, loginEnvironment } from './wsl-login-environment'

// Daemon and core running inside a WSL distro, for the app on Windows to be their client
// (docs/WSL.md, 安装和启动): what the distro must have, the backend's files put there, and the two
// started the way backend.ts starts them here. Everything the distro is asked goes through
// wsl-command.

// The archive pack-wsl-backend.mjs made, as the installer carries it, and the manifest beside it.
export type WslBackendArchive = { file: string; sha256: string }

// Where the backend runs in the distro: what a later call needs to ask it something or start more.
export type WslBackendPlace = { distro: string; node: string; dir: string; home: string; path: string }

export type WslBackendOptions = {
  distro: string
  // The app's version: the backend of any other is asked to leave, as backend.ts does here.
  version: string
  archive: WslBackendArchive
  host?: WslHost
  startWaitMs?: number
}

export type WslBackendStart = { ok: true; place: WslBackendPlace; endpoint: CoreEndpoint } | { ok: false; problem: WslBackendProblem }

// The Node the backend is built for and tested on: the major Electron runs it with on every other
// platform. An older one lacks what core imports (node:sqlite unflagged, zstd in node:zlib).
const MIN_NODE = [24, 0] as const
// A cold distro boots first, and core migrates its database before it listens.
const START_WAIT_MS = 30_000
const INSTALL_TIMEOUT_MS = 120_000
const CONTROL_TIMEOUT_MS = 30_000

export function nodeIsNewEnough(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim())
  if (!match?.[1] || !match[2]) return false
  const major = Number(match[1])
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && Number(match[2]) >= MIN_NODE[1])
}

const said = (result: WslResult) => (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`).slice(-600)

// Writes the archive from stdin, checks it against the manifest, and only then lets the folder be
// found under its name: a folder with .ready in it is whole. $1 is the folder's name, $2 the hash.
const INSTALL_SCRIPT = [
  'set -e',
  'umask 077',
  'root="$HOME/.antumi/backend"',
  'dir="$root/$1"',
  'tmp="$root/.$1.$$"',
  'mkdir -p "$root"',
  // What an install that was cut short left behind.
  'rm -rf "$root/.$1".*',
  'cat > "$tmp.tar.gz"',
  'echo "$2  $tmp.tar.gz" | sha256sum -c - > /dev/null',
  'mkdir "$tmp"',
  'tar -xzf "$tmp.tar.gz" -C "$tmp"',
  'rm -f "$tmp.tar.gz"',
  ': > "$tmp/.ready"',
  'rm -rf "$dir"',
  'mv "$tmp" "$dir"'
].join('\n')

// Runs the program with its output in the distro's own logs: a detached wsl.exe hands a program no
// stdio. From the home folder, not the Windows one wsl.exe would start it in. $1 names the log.
const LAUNCH_SCRIPT = [
  'logs="$HOME/.antumi/logs"',
  'mkdir -p -m 700 "$logs"',
  'cd "$HOME"',
  'name=$1',
  'shift',
  'exec "$@" >> "$logs/$name.log" 2>&1'
].join('\n')

// Removes the folders of other builds, but for one a process still runs from: a daemon kept for
// the sessions it runs, or an MCP server an agent started from it. $1 is this build's folder.
const TIDY_SCRIPT = [
  'root="$HOME/.antumi/backend"',
  'for dir in "$root"/*/; do',
  '  dir=${dir%/}',
  '  [ "$dir" = "$root/$1" ] && continue',
  '  grep -q -a -F -- "$dir/" /proc/[0-9]*/cmdline 2>/dev/null && continue',
  '  rm -rf "$dir"',
  'done'
].join('\n')

const Started = z.object({ start: z.array(z.enum(['daemon', 'core'])) })
const Endpoint = z.object({ endpoint: CoreEndpoint.nullable() })
const Check = z.object({ node: z.string(), arch: z.string(), pty: z.union([z.literal(true), z.string()]) })

// One of backend-control's answers: the last line it printed, as JSON. Null when it gave none.
async function control<T>(place: WslBackendPlace, schema: z.ZodType<T>, command: string[], host: WslHost): Promise<{ answer: T | null; result: WslResult }> {
  const result = await runInDistro(place.distro, [place.node, `${place.dir}/backend-control.mjs`, ...command], { host, env: { PATH: place.path }, timeoutMs: CONTROL_TIMEOUT_MS })
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  let parsed: unknown = null
  try {
    parsed = JSON.parse(line)
  } catch {
    return { answer: null, result }
  }
  const answer = schema.safeParse(parsed)
  return { answer: answer.success ? answer.data : null, result }
}

// The distro as the backend needs it: there, WSL 2, x64, with a login shell that names a Node new
// enough. Nothing is installed or started by asking.
export async function findWslBackendPlace(distro: string, folder: string, host: WslHost = nodeWslHost): Promise<{ ok: true; place: WslBackendPlace } | { ok: false; problem: WslBackendProblem }> {
  const problem = (found: WslBackendProblem) => ({ ok: false as const, problem: found })
  const listed = await listDistros(host)
  if (listed.status === 'unavailable') return problem({ kind: 'wsl-unavailable' })
  if (listed.status === 'unknown') return problem({ kind: 'wsl-unknown', detail: listed.reason })
  const entry = listed.distros.find((each) => each.name.toLowerCase() === distro.toLowerCase())
  if (!entry) return problem({ kind: 'distro-missing', distro })
  if (entry.version !== 2) return problem({ kind: 'distro-wsl1', distro: entry.name })

  const arch = (await runInDistro(entry.name, ['/bin/uname', '-m'], { host })).stdout.trim()
  if (arch !== 'x86_64') return problem(arch ? { kind: 'arch', arch } : { kind: 'wsl-unknown', detail: 'uname gave no answer' })
  const login = await loginEnvironment(entry.name, { host })
  if (!login) return problem({ kind: 'login-environment' })
  const node = await findLinuxExecutable(entry.name, 'node', login.path, { host })
  if (node.status === 'missing') return problem({ kind: 'node-missing' })
  if (node.status === 'unknown') return problem({ kind: 'wsl-unknown', detail: 'could not look for node' })
  const version = (await runInDistro(entry.name, [node.path, '--version'], { host })).stdout.trim()
  if (!nodeIsNewEnough(version)) return problem({ kind: 'node-old', version, path: node.path })
  return { ok: true, place: { distro: entry.name, node: node.path, dir: `${login.home}/.antumi/backend/${folder}`, home: login.home, path: login.path } }
}

// A rebuilt archive of the same version is another folder, so it is installed too.
export const backendFolder = (version: string, archive: WslBackendArchive) => `${version}-${archive.sha256.slice(0, 12)}`

async function install(place: WslBackendPlace, folder: string, archive: WslBackendArchive, host: WslHost): Promise<WslBackendProblem | null> {
  const ready = await runInDistro(place.distro, ['/bin/sh', '-c', 'test -f "$1"', 'sh', `${place.dir}/.ready`], { host })
  if (ready.code === 0) return null
  if (ready.code !== 1) return { kind: 'install', detail: said(ready) }
  let bytes: Buffer
  try {
    bytes = await readFile(archive.file)
  } catch (error) {
    return { kind: 'install', detail: String(error) }
  }
  const done = await runInDistro(place.distro, ['/bin/sh', '-c', INSTALL_SCRIPT, 'sh', folder, archive.sha256], { host, input: bytes, timeoutMs: INSTALL_TIMEOUT_MS })
  return done.code === 0 ? null : { kind: 'install', detail: done.timedOut ? 'timed out' : said(done) }
}

// Starts one of them the way launch() in backend.ts does: detached, so quitting the app never
// touches it. Its wsl.exe stays for as long as it runs, which is what keeps the distro up.
export function launchInWsl(place: WslBackendPlace, name: 'daemon' | 'core', host: WslHost = nodeWslHost): void {
  spawnInDistro(place.distro, ['/bin/sh', '-c', LAUNCH_SCRIPT, 'sh', name, place.node, `${place.dir}/${name}.mjs`], {
    host,
    detached: true,
    env: { PATH: place.path, ANTUMI_MCP_JS: `${place.dir}/mcp.mjs` }
  }).unref()
}

// The core serving the distro's home, if one answers there. Null when none does or it could not
// be asked.
export async function wslCoreEndpoint(place: WslBackendPlace, host: WslHost = nodeWslHost): Promise<CoreEndpoint | null> {
  return (await control(place, Endpoint, ['endpoint'], host)).answer?.endpoint ?? null
}

// The daemon of another build, replaced once it runs nothing: replaceOldDaemon() for the distro.
export async function replaceOldWslDaemon(place: WslBackendPlace, version: string, host: WslHost = nodeWslHost): Promise<void> {
  const { answer } = await control(place, Started, ['replace-daemon', version], host)
  for (const name of answer?.start ?? []) launchInWsl(place, name, host)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ensureBackend() for the distro: installs this build's backend if it is not there, asks an older
// one to leave under the same rules, starts what is missing and waits for core to answer.
export async function ensureWslBackend(options: WslBackendOptions): Promise<WslBackendStart> {
  const host = options.host ?? nodeWslHost
  const folder = backendFolder(options.version, options.archive)
  const found = await findWslBackendPlace(options.distro, folder, host)
  if (!found.ok) return found
  const { place } = found
  const failed = await install(place, folder, options.archive, host)
  if (failed) return { ok: false, problem: failed }

  const check = await control(place, Check, ['check'], host)
  if (!check.answer) return { ok: false, problem: { kind: 'start', detail: said(check.result) } }
  if (check.answer.pty !== true) return { ok: false, problem: { kind: 'pty', detail: check.answer.pty } }

  const prepared = await control(place, Started, ['prepare', options.version], host)
  if (!prepared.answer) return { ok: false, problem: { kind: 'start', detail: said(prepared.result) } }
  for (const name of prepared.answer.start) launchInWsl(place, name, host)

  const until = Date.now() + (options.startWaitMs ?? START_WAIT_MS)
  for (;;) {
    const endpoint = await wslCoreEndpoint(place, host)
    if (endpoint) {
      // After the start, so what was just asked to leave has left; nothing depends on it.
      await runInDistro(place.distro, ['/bin/sh', '-c', TIDY_SCRIPT, 'sh', folder], { host })
      return { ok: true, place, endpoint }
    }
    if (Date.now() >= until) return { ok: false, problem: { kind: 'start', detail: `core did not come up; see ${place.home}/.antumi/logs/core.log in ${place.distro}` } }
    await sleep(500)
  }
}
