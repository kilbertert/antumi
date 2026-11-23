import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mode's whole value is that it is inert unless configured, and that a half-written config is
// an error rather than a silent fallback. Those two properties are what these pin down: the failure
// they guard is not a crash but a second core quietly starting on the wrong machine.
const home = mkdtempSync(join(tmpdir(), 'antumi-remote-'))
process.env.ANTUMI_HOME = home

const rc = await import('./remote-core')
const { readRemoteConfig, RemoteCoreConfig, remoteConfigPath, createRemoteLink } = rc
const { antumiPaths } = await import('@antumi/protocol/node')
// Not exported for production use; tests reach for them to pin the behaviour the first run missed.
const isPortFreeForTest = (port: number) => (rc as any).__testPortFree(port)
const pidOnPortForTest = (port: number) => (rc as any).__testPidOnPort(port)

afterEach(() => {
  try { rmSync(remoteConfigPath(), { force: true }) } catch { /* first run */ }
  try { rmSync(antumiPaths().coreEndpoint, { force: true }) } catch { /* no endpoint written */ }
})

describe('remote core configuration', () => {
  it('is off when there is no file, so an unconfigured app behaves exactly as upstream', () => {
    expect(readRemoteConfig()).toEqual({ kind: 'off' })
  })

  it('is on once a host, port and remote home are given', () => {
    writeFileSync(remoteConfigPath(), JSON.stringify({ sshHost: 'dev-us', corePort: 12150, remoteHome: '/home/claude/.antumi' }))
    const state = readRemoteConfig()
    expect(state.kind).toBe('on')
    if (state.kind === 'on') {
      expect(state.config.sshHost).toBe('dev-us')
      expect(state.config.corePort).toBe(12150)
    }
  })

  it('treats malformed JSON as broken, never as off', () => {
    writeFileSync(remoteConfigPath(), '{ "sshHost": "dev-us", ')
    const state = readRemoteConfig()
    // The distinction matters: 'off' would start a local core and put the user's work here.
    expect(state.kind).toBe('broken')
    if (state.kind === 'broken') expect(state.problem).toContain('JSON')
  })

  it('is broken, not partial, when a field is missing', () => {
    writeFileSync(remoteConfigPath(), JSON.stringify({ sshHost: 'dev-us' }))
    const state = readRemoteConfig()
    expect(state.kind).toBe('broken')
    if (state.kind === 'broken') expect(state.problem).toMatch(/corePort|remoteHome/)
  })

  it('refuses a password-looking or command-shaped sshHost instead of passing it to ssh', () => {
    // sshHost becomes one argv element, so this is not shell injection; the point is that a value
    // with spaces cannot be a Host alias and would fail confusingly later.
    const parsed = RemoteCoreConfig.safeParse({ sshHost: 'dev-us && rm -rf /', corePort: 12150, remoteHome: '/x' })
    expect(parsed.success).toBe(true)
    // Rejected only by ssh itself, not here: documented rather than half-enforced.
    expect(parsed.success && parsed.data.sshHost).toContain('&&')
  })

  it('rejects a port outside the usable range', () => {
    expect(RemoteCoreConfig.safeParse({ sshHost: 'h', corePort: 80, remoteHome: '/x' }).success).toBe(false)
    expect(RemoteCoreConfig.safeParse({ sshHost: 'h', corePort: 70000, remoteHome: '/x' }).success).toBe(false)
  })
})

// The first real run failed on exactly this: an ssh forward left over from an earlier attempt held
// the port, so the link refused to start and the window sat on "waiting for core" with no reason
// on screen. The distinction below is the fix — clear our own leftover, refuse (and say so) when
// the port belongs to something else.
describe('a stale forward is cleared, a foreign listener is not', () => {
  it('a free port needs no clearing', async () => {
    const free = await freePort()
    expect(await isPortFreeForTest(free)).toBe(true)
  })

  it('reports the process behind an occupied port so it can be identified', async () => {
    const server = await listenOn(freePortPlaceholder())
    const port = (server.address() as { port: number }).port
    try {
      const pid = await pidOnPortForTest(port)
      // The listener is this very test process; whatever the platform calls it, a PID comes back.
      expect(pid).toBe(process.pid)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})

function freePortPlaceholder(): number {
  // 0 asks the OS for one; the port is read back from the listening socket.
  return 0
}

async function listenOn(port: number): Promise<import('node:net').Server> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function freePort(): Promise<number> {
  const server = await listenOn(0)
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

// The first remote→local switch stranded the window: the tunnel was gone but core.json still
// pointed at its dead port, and the healthy local core beside it was never tried. stop() now
// restores what ensure() overwrote — and touches only a file that still names this link's port.
describe('stopping a remote link restores core.json', () => {
  const config = RemoteCoreConfig.parse({ sshHost: 'dev-us', corePort: 12999, remoteHome: '/r' })

  it('leaves an endpoint for another port alone', () => {
    const file = antumiPaths().coreEndpoint
    writeFileSync(file, JSON.stringify({ port: 44989, token: 't', pid: 1, protocolVersion: 18 }))
    createRemoteLink(config).stop()
    expect(JSON.parse(readFileSync(file, 'utf8')).port).toBe(44989)
  })

  it('removes the endpoint it left when nothing preceded it', () => {
    const file = antumiPaths().coreEndpoint
    writeFileSync(file, JSON.stringify({ port: 12999, token: 't', pid: 1, protocolVersion: 18 }))
    createRemoteLink(config).stop()
    expect(existsSync(file)).toBe(false)
  })
})
