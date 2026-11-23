import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslHost } from './wsl-command'
import { isDistroRunning, listDistros, parseDistroList, parseRunningDistros, runningDistros } from './wsl-distros'

type Reply = { code: number | null; stdout?: Uint8Array | string } | 'hang'

class FakeChild extends ChildProcess {
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }
  override kill(): boolean {
    return true
  }
}

// A Windows machine whose wsl.exe answers each call with the next reply.
function windowsHost(...replies: Reply[]) {
  const calls: { args: string[]; options: SpawnOptions }[] = []
  const host: WslHost = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    isFile: (file) => file === 'C:\\Windows\\System32\\wsl.exe',
    spawn(_file, args, options) {
      calls.push({ args, options })
      const child = new FakeChild()
      const reply = replies.shift() ?? { code: 0 }
      if (reply !== 'hang') {
        setImmediate(() => {
          child.stdout?.emit('data', Buffer.from(reply.stdout ?? ''))
          child.emit('close', reply.code, null)
        })
      }
      return child
    }
  }
  return { host, calls }
}

const bom = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

const VERBOSE = [
  '  NAME                   STATE           VERSION',
  '* Ubuntu-24.04           Running         2',
  '  docker-desktop         Running         2',
  '  Docker-Desktop-Data    Stopped         2',
  '  Debian                 Stopped         1',
  ''
].join('\r\n')

describe('parseDistroList', () => {
  it('reads name, default, state and version, without Docker Desktop', () => {
    expect(parseDistroList(VERBOSE)).toEqual([
      { name: 'Ubuntu-24.04', isDefault: true, state: 'Running', version: 2 },
      { name: 'Debian', isDefault: false, state: 'Stopped', version: 1 }
    ])
  })

  it('reads a localized header and states of several words', () => {
    expect(parseDistroList('  名称      状态     版本\n* Ubuntu    正在运行  2\n  Arch      Wird ausgeführt  2\n')).toEqual([
      { name: 'Ubuntu', isDefault: true, state: '正在运行', version: 2 },
      { name: 'Arch', isDefault: false, state: 'Wird ausgeführt', version: 2 }
    ])
  })

  it('finds none in a message', () => {
    expect(parseDistroList('Windows Subsystem for Linux has no installed distributions.\r\n')).toEqual([])
  })
})

describe('parseRunningDistros', () => {
  it('reads one name a line and skips Docker Desktop and messages', () => {
    expect(parseRunningDistros('Ubuntu\r\ndocker-desktop\r\n\r\nDebian\r\n')).toEqual(['Ubuntu', 'Debian'])
    expect(parseRunningDistros('There are no running distributions.\r\n')).toEqual([])
  })
})

describe('listDistros', () => {
  afterEach(() => vi.useRealTimers())

  it('asks wsl.exe --list --verbose and decodes its UTF-16LE', async () => {
    const { host, calls } = windowsHost({ code: 0, stdout: bom(VERBOSE) })
    expect(await listDistros(host)).toEqual({
      status: 'ok',
      distros: [
        { name: 'Ubuntu-24.04', isDefault: true, state: 'Running', version: 2 },
        { name: 'Debian', isDefault: false, state: 'Stopped', version: 1 }
      ]
    })
    expect(calls.map((call) => call.args)).toEqual([['--list', '--verbose']])
    expect(calls[0]?.options.cwd).toBe('C:\\Windows')
    expect(calls[0]?.options.env?.WSL_UTF8).toBe('1')
  })

  it('is unavailable off Windows or without wsl.exe, and asks nothing', async () => {
    const mac = windowsHost()
    expect(await listDistros({ ...mac.host, platform: 'darwin' })).toEqual({ status: 'unavailable' })
    const bare = windowsHost()
    expect(await listDistros({ ...bare.host, isFile: () => false })).toEqual({ status: 'unavailable' })
    expect([...mac.calls, ...bare.calls]).toEqual([])
  })

  it('is unknown, not empty, when wsl.exe fails', async () => {
    const { host } = windowsHost({ code: 1, stdout: bom('Something went wrong.\r\n') })
    expect(await listDistros(host)).toEqual({ status: 'unknown', reason: 'exit 1: Something went wrong.' })
  })

  it('is unknown when wsl.exe does not answer in time', async () => {
    vi.useFakeTimers()
    const { host } = windowsHost('hang')
    const answer = listDistros(host)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await answer).toEqual({ status: 'unknown', reason: 'timeout' })
  })
})

describe('isDistroRunning', () => {
  it('asks only --list --running, so a stopped distro stays stopped', async () => {
    const { host, calls } = windowsHost({ code: 0, stdout: 'Ubuntu\n' })
    expect(await isDistroRunning('ubuntu', host)).toBe('running')
    expect(calls.map((call) => call.args)).toEqual([['--list', '--running', '--quiet']])
  })

  it('tells stopped from could not ask', async () => {
    expect(await isDistroRunning('Debian', windowsHost({ code: 0, stdout: bom('Ubuntu\r\n') }).host)).toBe('stopped')
    expect(await isDistroRunning('Debian', windowsHost({ code: null }).host)).toBe('unknown')
  })

  it('lists the running names', async () => {
    expect(await runningDistros(windowsHost({ code: 0, stdout: 'Ubuntu\nDebian\n' }).host)).toEqual({ status: 'ok', names: ['Ubuntu', 'Debian'] })
  })
})
