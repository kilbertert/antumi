import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { antumiPaths, writeCoreEndpoint } from '@antumi/protocol/node'
import { BACKEND_CONTROL_USAGE, backendControl } from './backend-control'

let home = ''
const cleanup: (() => unknown)[] = []
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'antumi-backend-control-'))
})
afterEach(async () => {
  for (const each of cleanup.splice(0).reverse()) await each()
  await rm(home, { recursive: true, force: true })
})

// A core.json naming a port that answers, for a core of this version and pid.
async function fakeCore(version: string, pid: number): Promise<number> {
  const server = net.createServer((socket) => socket.destroy())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await writeCoreEndpoint({ port: address.port, token: 't', pid, protocolVersion: 1, version }, home)
  return address.port
}

// A daemon of this version that answers info and leaves when asked to retire, as an idle one does.
async function fakeDaemon(version: string): Promise<void> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const { id, method } = JSON.parse(line)
        if (method === 'info') socket.write(`${JSON.stringify({ id, result: { version, pid: 1 } })}\n`)
        if (method === 'retire') {
          socket.end(`${JSON.stringify({ id, result: { retired: true, live: 0 } })}\n`)
          server.close()
        }
      }
    })
  })
  server.listen(antumiPaths(home).daemonSocket)
  await once(server, 'listening')
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve(undefined))))
}

describe('backendControl', () => {
  it('names what to start', async () => {
    expect(await backendControl(['prepare', '2.0.0'], { home })).toEqual({ answer: { start: ['daemon', 'core'] } })
  })

  it.skipIf(process.platform === 'win32')('names a daemon to start only once an older one left', async () => {
    expect(await backendControl(['replace-daemon', '2.0.0'], { home })).toEqual({ answer: { start: [] } })
    await fakeDaemon('2.0.0')
    expect(await backendControl(['replace-daemon', '2.0.0'], { home })).toEqual({ answer: { start: [] } })
    expect(await backendControl(['replace-daemon', '3.0.0'], { home })).toEqual({ answer: { start: ['daemon'] } })
  })

  it('gives the running core, or null', async () => {
    expect(await backendControl(['endpoint'], { home })).toEqual({ answer: { endpoint: null } })
    const port = await fakeCore('2.0.0', process.pid)
    expect(await backendControl(['endpoint'], { home })).toEqual({ answer: { endpoint: { port, token: 't', pid: process.pid, protocolVersion: 1, version: '2.0.0' } } })
  })

  it('says whether node-pty loads, and why not', async () => {
    expect(await backendControl(['check'], { loadPty: async () => ({}) })).toEqual({ answer: { node: process.version, arch: process.arch, pty: true } })
    const failing = await backendControl(['check'], { loadPty: () => Promise.reject(new Error('no binding')) })
    expect(failing).toEqual({ answer: { node: process.version, arch: process.arch, pty: 'no binding' } })
  })

  it('refuses anything else', async () => {
    for (const args of [[], ['prepare'], ['prepare', ''], ['prepare', '1', '2'], ['replace-daemon'], ['replace-daemon', '1', '2'], ['endpoint', 'x'], ['check', 'x'], ['start']]) {
      expect(await backendControl(args, { home })).toEqual({ usage: BACKEND_CONTROL_USAGE })
    }
  })
})

// As the app will run it, minus wsl.exe: a child on plain Node with the source through tsx.
describe('backend-control process', () => {
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const entry = fileURLToPath(new URL('./backend-control-main.ts', import.meta.url))

  async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, ['--import', loader, entry, ...args], { env: { ...process.env, ANTUMI_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const [code] = await once(child, 'close')
    return { code, stdout, stderr }
  }

  it('prints one line of JSON, and what the rules say goes to stderr', async () => {
    const old = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000);process.stdout.write('ready')"], { stdio: ['ignore', 'pipe', 'ignore'] })
    cleanup.push(() => old.kill('SIGKILL'))
    if (old.pid === undefined) throw new Error('child did not start')
    await once(old.stdout, 'data')
    await fakeCore('1.0.0', old.pid)
    const { code, stdout, stderr } = await run(['prepare', '2.0.0'])
    expect(code).toBe(0)
    expect(stdout).toBe('{"start":["daemon","core"]}\n')
    expect(stderr).toContain('[antumi] core 1.0.0 is older than this app (2.0.0); replacing it')
  }, 30_000)

  it('prints no daemon to start when none was replaced', async () => {
    const { code, stdout } = await run(['replace-daemon', '2.0.0'])
    expect(code).toBe(0)
    expect(stdout).toBe('{"start":[]}\n')
  }, 30_000)

  it('reports its Node and whether node-pty loads', async () => {
    const { code, stdout } = await run(['check'])
    expect(code).toBe(0)
    expect(stdout.split('\n')).toHaveLength(2)
    const answer = JSON.parse(stdout)
    expect(answer).toMatchObject({ node: process.version, arch: process.arch })
    expect(answer.pty === true || typeof answer.pty === 'string').toBe(true)
  }, 30_000)

  it('exits 1 with one line on stderr and nothing on stdout for bad usage', async () => {
    const { code, stdout, stderr } = await run(['prepare'])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe(`[antumi-backend-control] ${BACKEND_CONTROL_USAGE}\n`)
  }, 30_000)
})
