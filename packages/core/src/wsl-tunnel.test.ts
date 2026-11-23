import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectTunnelHelper, type TunnelHelperConfig } from '@antumi/protocol/node'
import { parseTunnelHelperConfig, startTunnelHelper } from './wsl-tunnel'

let dir = ''
const cleanup: (() => unknown)[] = []
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'antumi-wsl-tunnel-'))
})
afterEach(async () => {
  for (const each of cleanup.splice(0)) await each()
  await rm(dir, { recursive: true, force: true })
})

async function serve(reply: (text: string) => string): Promise<number> {
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = []
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => socket.end(reply(Buffer.concat(chunks).toString())))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => server.close())
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

function ask(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port, allowHalfOpen: true })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.on('error', reject)
    socket.end(text)
  })
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

// The helper's stdin and stdout, and the app's ends of them.
function stdio() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  return { helper: { stdin, stdout }, app: { toHelper: stdin, fromHelper: stdout } }
}

describe('parseTunnelHelperConfig', () => {
  it('reads both directions', () => {
    expect(parseTunnelHelperConfig('{"listen":{"endpointFile":"/h/.antumi/browser/host.json","endpoint":{"token":"t","protocolVersion":3}},"dial":{"port":51234}}')).toEqual({
      listen: { endpointFile: '/h/.antumi/browser/host.json', endpoint: { token: 't', protocolVersion: 3 } },
      dial: { port: 51234 }
    })
    expect(parseTunnelHelperConfig('{"listen":{}}')).toEqual({ listen: {} })
  })

  it.each([
    ['not json', /JSON/],
    ['[1]', /not an object/],
    ['{}', /neither/],
    ['{"dial":{"port":0}}', /port/],
    ['{"dial":{"port":"1"}}', /port/],
    ['{"listen":{"endpointFile":"host.json","endpoint":{}}}', /absolute/],
    ['{"listen":{"endpointFile":"/x/host.json"}}', /together/],
    ['{"listen":{"endpointFile":"/x/host.json","endpoint":"t"}}', /endpoint is not/]
  ])('refuses %s', (text, message) => {
    expect(() => parseTunnelHelperConfig(text)).toThrow(message)
  })
})

describe('tunnel helper', () => {
  it('carries both directions and owns the endpoint file while it runs', async () => {
    const appPort = await serve((text) => `app got ${text}`)
    const corePort = await serve((text) => `core got ${text}`)
    const endpointFile = path.join(dir, 'browser', 'host.json')
    const { helper, app } = stdio()
    const starting = startTunnelHelper({ ...helper, pid: 4242 })
    const link = await connectTunnelHelper({ ...app, appPort, config: { listen: { endpointFile, endpoint: { token: 'secret', protocolVersion: 3 } }, dial: { port: corePort } } })
    const running = await starting

    const written: unknown = JSON.parse(await readFile(endpointFile, 'utf8'))
    expect(written).toEqual({ token: 'secret', protocolVersion: 3, port: link.remotePort, pid: 4242 })
    expect((await stat(endpointFile)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(endpointFile))).mode & 0o777).toBe(0o700)
    expect(link.localPort).toBeGreaterThan(0)

    const [toApp, toCore] = await Promise.all([ask(link.remotePort ?? 0, 'from core'), ask(link.localPort ?? 0, 'from the app')])
    expect(toApp).toBe('app got from core')
    expect(toCore).toBe('core got from the app')

    // The app closing its end is the helper's stdin ending.
    link.close()
    expect(await running.stopped).toBeNull()
    expect(await exists(endpointFile)).toBe(false)
  })

  it('leaves an endpoint file a successor has taken', async () => {
    const endpointFile = path.join(dir, 'host.json')
    const { helper, app } = stdio()
    const starting = startTunnelHelper({ ...helper, pid: 4242 })
    const link = await connectTunnelHelper({ ...app, appPort: 1, config: { listen: { endpointFile, endpoint: { token: 't' } } } })
    const running = await starting
    await writeFile(endpointFile, JSON.stringify({ token: 'next', port: 1, pid: 4343 }))
    link.close()
    await running.stopped
    expect(JSON.parse(await readFile(endpointFile, 'utf8'))).toMatchObject({ pid: 4343 })
  })

  it('stops on request and tells the app', async () => {
    const { helper, app } = stdio()
    const starting = startTunnelHelper(helper)
    const link = await connectTunnelHelper({ ...app, config: { dial: { port: 1 } } })
    expect(link.remotePort).toBeNull()
    await (await starting).stop()
    expect(await link.closed).toBeNull()
  })

  it('refuses a malformed config before writing anything', async () => {
    const { helper } = stdio()
    const written: Buffer[] = []
    helper.stdout.on('data', (chunk: Buffer) => written.push(chunk))
    const starting = startTunnelHelper(helper)
    helper.stdin.write('{"dial":{}}\n')
    await expect(starting).rejects.toThrow(/dial.port/)
    expect(written).toEqual([])
  })
})

// As the app will run it, minus wsl.exe: a child on plain Node with the source through tsx.
describe('tunnel helper process', () => {
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const entry = fileURLToPath(new URL('./wsl-tunnel-main.ts', import.meta.url))

  function start(): { child: ChildProcessByStdio<Writable, Readable, Readable>; stderr: () => string; exited: Promise<number | null> } {
    const child = spawn(process.execPath, ['--import', loader, entry], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    cleanup.push(() => child.kill('SIGKILL'))
    return { child, stderr: () => stderr, exited }
  }

  it('tunnels both ways and removes its endpoint file when stdin closes', async () => {
    const appPort = await serve((text) => `app got ${text}`)
    const corePort = await serve((text) => `core got ${text}`)
    const endpointFile = path.join(dir, 'browser', 'host.json')
    const { child, exited } = start()
    const config: TunnelHelperConfig = { listen: { endpointFile, endpoint: { token: 'secret', protocolVersion: 3 } }, dial: { port: corePort } }
    const link = await connectTunnelHelper({ fromHelper: child.stdout, toHelper: child.stdin, config, appPort, timeoutMs: 20_000 })
    // The file is written just after the sentinel.
    while (!(await exists(endpointFile))) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(JSON.parse(await readFile(endpointFile, 'utf8'))).toEqual({ token: 'secret', protocolVersion: 3, port: link.remotePort, pid: child.pid })
    expect((await stat(endpointFile)).mode & 0o777).toBe(0o600)

    expect(await ask(link.remotePort ?? 0, 'from core')).toBe('app got from core')
    expect(await ask(link.localPort ?? 0, 'from the app')).toBe('core got from the app')

    link.close()
    expect(await exited).toBe(0)
    expect(await exists(endpointFile)).toBe(false)
  }, 30_000)

  it.skipIf(process.platform === 'win32')('removes its endpoint file on SIGTERM', async () => {
    const endpointFile = path.join(dir, 'host.json')
    const { child, exited } = start()
    await connectTunnelHelper({ fromHelper: child.stdout, toHelper: child.stdin, config: { listen: { endpointFile, endpoint: { token: 't' } } }, appPort: 1, timeoutMs: 20_000 })
    while (!(await exists(endpointFile))) await new Promise((resolve) => setTimeout(resolve, 10))
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(await exists(endpointFile)).toBe(false)
  }, 30_000)

  it('exits non-zero with one line on stderr for a malformed config', async () => {
    const { child, stderr, exited } = start()
    const stdout: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stdin.end('{"listen":"yes"}\n')
    expect(await exited).toBe(1)
    expect(stderr()).toMatch(/^\[antumi-tunnel\] listen is not an object\n$/)
    expect(Buffer.concat(stdout).length).toBe(0)
  }, 30_000)
})
