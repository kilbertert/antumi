import { ChildProcess, execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslHost } from './wsl-command'
import { findLinuxExecutable, linuxSearchPath, loginEnvironment, parseLoginEnvironment } from './wsl-login-environment'

type Reply = { code: number | null; stdout?: string } | 'hang'

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

// A Windows machine whose wsl.exe answers from what it was asked.
function windowsHost(answer: (args: string[]) => Reply) {
  const calls: string[][] = []
  const host: WslHost = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    isFile: () => true,
    spawn(_file, args) {
      calls.push(args)
      const child = new FakeChild()
      const reply = answer(args)
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

// The marker loginEnvironment chose, from the arguments it gave sh.
const markOf = (args: string[]) => args[args.indexOf('sh') + 1] ?? ''

const BANNER = 'To run a command as administrator (user "root"), use "sudo <command>".\nWelcome to Ubuntu 24.04\n'

describe('loginEnvironment', () => {
  afterEach(() => vi.useRealTimers())

  it('runs sh under --exec with the script and a fresh marker as arguments', async () => {
    const { host, calls } = windowsHost(() => ({ code: 0 }))
    await loginEnvironment('Ubuntu', { host })
    await loginEnvironment('Ubuntu', { host })
    const [first, second] = calls
    expect(first?.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c'])
    expect(first?.[6]).toBe('sh')
    const mark = markOf(first ?? [])
    expect(mark).toMatch(/^__ANTUMI_[0-9a-f]{16}_$/)
    expect(first?.[8]).toBe(`echo ${mark}path; printenv PATH; echo ${mark}home; printenv HOME; echo ${mark}end`)
    expect(markOf(second ?? [])).not.toBe(mark)
  })

  it('reads PATH, HOME and the shell between markers, past banners', async () => {
    const { host } = windowsHost((args) => {
      const mark = markOf(args)
      return { code: 1, stdout: `${mark}/bin/bash\n${BANNER}${mark}path\n/home/me/.nvm/versions/node/v22/bin:/usr/bin:/mnt/c/Windows\n${mark}home\n/home/me\n${mark}end\nbye\n` }
    })
    expect(await loginEnvironment(null, { host })).toEqual({ path: '/home/me/.nvm/versions/node/v22/bin:/usr/bin:/mnt/c/Windows', home: '/home/me', shell: '/bin/bash' })
  })

  it('does not take a marker of another ask, or a banner that looks like one', async () => {
    const { host } = windowsHost(() => ({ code: 0, stdout: '__ANTUMI_0000000000000000_/bin/sh\n__ANTUMI_0000000000000000_path\n/evil\n__ANTUMI_0000000000000000_home\n/x\n__ANTUMI_0000000000000000_end\n' }))
    expect(await loginEnvironment('Ubuntu', { host })).toBeNull()
  })

  it('is null on a timeout or without its markers', async () => {
    expect(await loginEnvironment('Ubuntu', { host: windowsHost(() => ({ code: 0, stdout: BANNER })).host })).toBeNull()
    vi.useFakeTimers()
    const answer = loginEnvironment('Ubuntu', { host: windowsHost(() => 'hang').host, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await answer).toBeNull()
  })
})

describe('parseLoginEnvironment', () => {
  const mark = '__ANTUMI_abc_'

  it('reads CRLF output', () => {
    expect(parseLoginEnvironment(`${mark}/usr/bin/zsh\r\n${mark}path\r\n/usr/bin\r\n${mark}home\r\n/root\r\n${mark}end\r\n`, mark)).toEqual({ path: '/usr/bin', home: '/root', shell: '/usr/bin/zsh' })
  })

  it('is null when PATH or HOME came out empty', () => {
    expect(parseLoginEnvironment(`${mark}/bin/sh\n${mark}path\n${mark}home\n/root\n${mark}end\n`, mark)).toBeNull()
  })
})

// The script itself, run by this machine's sh: the shell is found, then runs what it is given.
describe.skipIf(process.platform === 'win32')('the login script under a real sh', () => {
  it('prints the shell line and then the markers', () => {
    const { host, calls } = windowsHost(() => ({ code: 0 }))
    void loginEnvironment('Ubuntu', { host })
    const args = calls[0] ?? []
    const script = args[5] ?? ''
    const stdout = execFileSync('/bin/sh', ['-c', script, 'sh', markOf(args), args[8] ?? ''], { encoding: 'utf8', env: { ...process.env, HOME: '/tmp/me' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const found = parseLoginEnvironment(stdout, markOf(args))
    expect(found?.home).toBe('/tmp/me')
    expect(found?.shell.startsWith('/')).toBe(true)
    expect(found?.path).toContain('/')
  })
})

describe('linuxSearchPath', () => {
  it('drops Windows folders under /mnt and relative entries', () => {
    expect(linuxSearchPath('/home/me/.local/bin:/mnt/c/Program Files/nodejs:.:/usr/bin:/mnt:/mnt/wsl/x:/mntx/bin')).toBe('/home/me/.local/bin:/usr/bin:/mntx/bin')
  })
})

describe('findLinuxExecutable', () => {
  it('asks sh for command -v with the name as an argument and a Linux-only PATH', async () => {
    const { host, calls } = windowsHost(() => ({ code: 0, stdout: '/home/me/.nvm/versions/node/v22/bin/node\n' }))
    expect(await findLinuxExecutable('Ubuntu', 'node', '/home/me/.nvm/versions/node/v22/bin:/mnt/c/Program Files/nodejs:/usr/bin', { host }))
      .toEqual({ status: 'found', path: '/home/me/.nvm/versions/node/v22/bin/node' })
    expect(calls).toEqual([['-d', 'Ubuntu', '--exec', '/usr/bin/env', 'PATH=/home/me/.nvm/versions/node/v22/bin:/usr/bin', '/bin/sh', '-c', 'command -v "$1"', 'sh', 'node']])
  })

  it('tells missing from could not ask', async () => {
    expect(await findLinuxExecutable('Ubuntu', 'node', '/usr/bin', { host: windowsHost(() => ({ code: 127 })).host })).toEqual({ status: 'missing' })
    expect(await findLinuxExecutable('Ubuntu', 'node', '/usr/bin', { host: windowsHost(() => ({ code: 1 })).host })).toEqual({ status: 'missing' })
    expect(await findLinuxExecutable('Ubuntu', 'node', '/usr/bin', { host: windowsHost(() => ({ code: 4294967295 })).host })).toEqual({ status: 'unknown' })
    expect(await findLinuxExecutable('Ubuntu', 'node', '/usr/bin', { host: windowsHost(() => ({ code: null })).host })).toEqual({ status: 'unknown' })
  })

  it('takes no relative answer and asks nothing for a name that is a path or an option', async () => {
    expect(await findLinuxExecutable('Ubuntu', 'node', '/usr/bin', { host: windowsHost(() => ({ code: 0, stdout: 'node\n' })).host })).toEqual({ status: 'unknown' })
    const { host, calls } = windowsHost(() => ({ code: 0 }))
    expect(await findLinuxExecutable('Ubuntu', '../node', '/usr/bin', { host })).toEqual({ status: 'missing' })
    expect(await findLinuxExecutable('Ubuntu', '-v', '/usr/bin', { host })).toEqual({ status: 'missing' })
    expect(calls).toEqual([])
  })
})
