import { nodeWslHost, runWsl, wslExecutable, type WslHost, type WslResult } from './wsl-command'

export type WslDistro = {
  name: string
  isDefault: boolean
  // As wsl.exe prints it, which may be in the system's language: ask isDistroRunning, not this.
  state: string
  version: 1 | 2
}

// "Could not ask" is never "none": a caller keeps what it last knew and asks again later.
export type WslAnswer<T> = ({ status: 'ok' } & T) | { status: 'unavailable' } | { status: 'unknown'; reason: string }

const LIST_TIMEOUT_MS = 10_000
// Docker Desktop's own, which run no user's work.
const HIDDEN_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])
// The header and states are localized (a state may be several words); only rows end in a version.
const VERBOSE_ROW = /^\s*(\*)?\s*(\S+)\s+(.+?)\s+([12])\s*$/

const hidden = (name: string) => HIDDEN_DISTROS.has(name.toLowerCase())
const lines = (text: string) => text.replace(/\0/g, '').split(/\r?\n/)

// `wsl.exe --list --verbose`.
export function parseDistroList(text: string): WslDistro[] {
  return lines(text).flatMap((line) => {
    const row = VERBOSE_ROW.exec(line)
    if (!row?.[2] || !row[3] || hidden(row[2])) return []
    return [{ name: row[2], isDefault: row[1] === '*', state: row[3], version: row[4] === '1' ? 1 : 2 }]
  })
}

// `wsl.exe --list --running --quiet`: one name a line. Names hold no spaces, so a sentence
// (a message in place of the list) is no name.
export function parseRunningDistros(text: string): string[] {
  return lines(text).map((line) => line.trim()).filter((line) => line && !/\s/.test(line) && !hidden(line))
}

function failure(result: WslResult): { status: 'unknown'; reason: string } {
  if (result.timedOut) return { status: 'unknown', reason: 'timeout' }
  const said = result.stderr.trim() || result.stdout.trim()
  return { status: 'unknown', reason: `exit ${String(result.code)}${said ? `: ${said}` : ''}` }
}

async function list(args: string[], host: WslHost): Promise<WslAnswer<{ text: string }>> {
  if (!wslExecutable(host)) return { status: 'unavailable' }
  const result = await runWsl(args, { host, timeoutMs: LIST_TIMEOUT_MS })
  return result.code === 0 ? { status: 'ok', text: result.stdout } : failure(result)
}

export async function listDistros(host: WslHost = nodeWslHost): Promise<WslAnswer<{ distros: WslDistro[] }>> {
  const answer = await list(['--list', '--verbose'], host)
  return answer.status === 'ok' ? { status: 'ok', distros: parseDistroList(answer.text) } : answer
}

// Asks only what runs, so a distro that has stopped is not started by asking.
export async function runningDistros(host: WslHost = nodeWslHost): Promise<WslAnswer<{ names: string[] }>> {
  const answer = await list(['--list', '--running', '--quiet'], host)
  return answer.status === 'ok' ? { status: 'ok', names: parseRunningDistros(answer.text) } : answer
}

// Distro names compare without case, as wsl.exe does.
export async function isDistroRunning(distro: string, host: WslHost = nodeWslHost): Promise<'running' | 'stopped' | 'unknown'> {
  const answer = await runningDistros(host)
  if (answer.status !== 'ok') return 'unknown'
  return answer.names.some((name) => name.toLowerCase() === distro.toLowerCase()) ? 'running' : 'stopped'
}
