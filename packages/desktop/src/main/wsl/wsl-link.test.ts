import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { startTunnelHelper } from '../../../../core/src/wsl-tunnel'
import type { WslHost } from './wsl-command'
import { WslLink } from './wsl-link'

// A wsl.exe child that is the real tunnel helper, run in this process on the child's stdio.
class HelperChild extends ChildProcess {
  constructor() {
    super()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    this.stdin = stdin
    this.stdout = stdout
    this.stderr = new PassThrough()
    void startTunnelHelper({ stdin, stdout }).then((helper) => helper.stopped.then(() => stdout.end()), () => stdout.end())
  }
  override kill(): boolean {
    this.stdin?.end()
    return true
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function windows() {
  const spawned: { args: string[]; options: SpawnOptions; child: HelperChild }[] = []
  const host: WslHost = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    isFile: () => true,
    spawn(_file, args, options) {
      const child = new HelperChild()
      spawned.push({ args, options, child })
      return child
    }
  }
  return { host, spawned }
}

// A server that says its name, then echoes: which end a connection reached, and that bytes pass.
async function named(name: string): Promise<number> {
  const server = net.createServer((socket) => {
    socket.write(`${name}:`)
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  const address = server.address()
  return address && typeof address === 'object' ? address.port : 0
}

function ask(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let got = ''
    socket.on('data', (chunk: Buffer) => {
      got += chunk.toString()
      if (got.endsWith(text)) socket.end()
    })
    socket.on('close', () => resolve(got))
    socket.on('error', reject)
    socket.write(text)
  })
}

async function until(done: () => boolean): Promise<void> {
  const end = Date.now() + 5000
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(done()).toBe(true)
}

function place() {
  const home = mkdtempSync(join(tmpdir(), 'antumi-wsl-link-'))
  return { distro: 'Ubuntu', node: '/usr/bin/node', dir: '/home/me/.antumi/backend/1', home, path: '/usr/bin' }
}

describe('WslLink', () => {
  it('joins the UI to core and core to the browser host over one helper', async () => {
    const { host, spawned } = windows()
    const where = place()
    const link = new WslLink(where, { host, log: () => {} })
    cleanups.push(() => link.stop())
    const [core, browser] = [await named('core'), await named('browser')]
    expect(await link.connect({ corePort: core, browserHost: { port: browser, token: 'secret' } })).toBe(true)

    expect(spawned[0]?.args).toEqual(['-d', 'Ubuntu', '--exec', '/usr/bin/node', '/home/me/.antumi/backend/1/wsl-tunnel.mjs'])
    expect(await ask(link.corePort() ?? 0, 'ping')).toBe('core:ping')
    // Written just after the helper answers; core watches for it.
    const hostFile = join(where.home, '.antumi/browser/host.json')
    await until(() => existsSync(hostFile))
    const endpoint: { port: number; token: string; protocolVersion: number } = JSON.parse(readFileSync(hostFile, 'utf8'))
    expect(endpoint).toMatchObject({ token: 'secret', protocolVersion: 3 })
    expect(await ask(endpoint.port, 'page')).toBe('browser:page')

    // The same ends again start nothing.
    expect(await link.connect({ corePort: core, browserHost: { port: browser, token: 'secret' } })).toBe(true)
    expect(spawned).toHaveLength(1)

    link.stop()
    await until(() => !existsSync(hostFile))
    expect(link.corePort()).toBeNull()
  })

  it('carries only the way to core until the browser host is up, then both', async () => {
    const { host, spawned } = windows()
    const where = place()
    const link = new WslLink(where, { host, log: () => {} })
    cleanups.push(() => link.stop())
    const [core, browser] = [await named('core'), await named('browser')]
    await link.connect({ corePort: core, browserHost: null })
    expect(await ask(link.corePort() ?? 0, 'a')).toBe('core:a')
    expect(existsSync(join(where.home, '.antumi/browser/host.json'))).toBe(false)

    await link.connect({ corePort: core, browserHost: { port: browser, token: 't' } })
    expect(spawned).toHaveLength(2)
    expect(await ask(link.corePort() ?? 0, 'b')).toBe('core:b')
    await until(() => existsSync(join(where.home, '.antumi/browser/host.json')))
  })

  it('starts the helper again when it goes', async () => {
    const { host, spawned } = windows()
    const link = new WslLink(place(), { host, log: () => {}, retryMs: 10 })
    cleanups.push(() => link.stop())
    const core = await named('core')
    await link.connect({ corePort: core, browserHost: null })
    spawned[0]?.child.kill()
    await until(() => spawned.length === 2 && link.corePort() !== null)
    expect(await ask(link.corePort() ?? 0, 'again')).toBe('core:again')
  })

  it('stays stopped', async () => {
    const { host, spawned } = windows()
    const link = new WslLink(place(), { host, log: () => {}, retryMs: 10 })
    await link.connect({ corePort: await named('core'), browserHost: null })
    link.stop()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(spawned).toHaveLength(1)
    expect(await link.connect({ corePort: 1, browserHost: null })).toBe(false)
  })
})
