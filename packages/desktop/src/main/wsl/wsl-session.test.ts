import { describe, expect, it } from 'vitest'
import type { CoreEndpoint } from '@antumi/protocol'
import type { WslBackendPlace, WslBackendStart } from './wsl-backend'
import type { WslLinkEnds } from './wsl-link'
import { WslSession, type WslSessionParts } from './wsl-session'

const PLACE: WslBackendPlace = { distro: 'Ubuntu', node: '/usr/bin/node', dir: '/home/me/.antumi/backend/1', home: '/home/me', path: '/usr/bin' }
const core = (port: number, pid = 7): CoreEndpoint => ({ port, token: 't', pid, protocolVersion: 18, version: '1.0.0' })
const OPTIONS = { distro: 'ubuntu', version: '1.0.0', archive: { file: 'a.tar.gz', sha256: 'ab' } }

function parts(over: Partial<WslSessionParts> = {}) {
  const joined: WslLinkEnds[] = []
  const seen = { ensured: 0, asked: 0, joined, replaced: 0, stopped: 0 }
  const state: { now: number; running: CoreEndpoint | null; start: WslBackendStart; up: boolean } = { now: 100_000, running: core(4100), start: { ok: true, place: PLACE, endpoint: core(4100) }, up: true }
  const made: WslSessionParts = {
    ensure: async () => { seen.ensured += 1; return state.start },
    coreEndpoint: async () => { seen.asked += 1; return state.running },
    replaceDaemon: async () => { seen.replaced += 1 },
    link: () => ({
      connect: async (ends) => { seen.joined.push(ends); return state.up },
      corePort: () => (state.up ? 51000 : null),
      stop: () => { seen.stopped += 1 }
    }),
    now: () => state.now,
    ...over
  }
  return { made, seen, state }
}

describe('WslSession', () => {
  it('answers with core behind the tunnel port once started', async () => {
    const { made, seen } = parts()
    const session = new WslSession(OPTIONS, made)
    expect(await session.endpoint()).toBeNull()
    expect(await session.start()).toBeNull()
    expect(await session.endpoint()).toEqual({ ...core(4100), port: 51000 })
    expect(seen.joined[0]).toEqual({ corePort: 4100, browserHost: null })
    // Fresh from the start: the distro is not asked again yet.
    expect(seen.asked).toBe(0)
  })

  it('says why it did not start', async () => {
    const { made, state } = parts()
    state.start = { ok: false, problem: { kind: 'node-old', version: 'v18.19.1', path: '/usr/bin/node' } }
    const session = new WslSession(OPTIONS, made)
    expect(await session.start()).toEqual({ kind: 'node-old', version: 'v18.19.1', path: '/usr/bin/node' })
    expect(await session.endpoint()).toBeNull()
  })

  it('starts once however often it is asked to at a time', async () => {
    const { made, seen } = parts()
    const session = new WslSession(OPTIONS, made)
    await Promise.all([session.start(), session.start(), session.start()])
    expect(seen.ensured).toBe(1)
  })

  it('asks the distro again once what it knew is stale, and follows core to a new port', async () => {
    const { made, seen, state } = parts()
    const session = new WslSession(OPTIONS, made)
    await session.start()
    state.now += 5000
    state.running = core(4200, 9)
    expect(await session.endpoint()).toEqual({ ...core(4200, 9), port: 51000 })
    expect(seen.asked).toBe(1)
    expect(seen.joined.at(-1)).toEqual({ corePort: 4200, browserHost: null })
  })

  it('starts the backend again when core went, but not in a loop', async () => {
    const { made, seen, state } = parts()
    const session = new WslSession(OPTIONS, made)
    await session.start()
    state.running = null
    state.now += 5000
    expect(await session.endpoint()).toBeNull()
    expect(seen.ensured).toBe(1)
    state.now += 20_000
    expect(await session.endpoint()).toBeNull()
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen.ensured).toBe(2)
  })

  it('has no endpoint while the tunnel is down', async () => {
    const { made, state } = parts()
    const session = new WslSession(OPTIONS, made)
    await session.start()
    state.up = false
    expect(await session.endpoint()).toBeNull()
  })

  it('hands the browser host to the tunnel when it comes up', async () => {
    const { made, seen } = parts()
    const session = new WslSession(OPTIONS, made)
    await session.start()
    session.setBrowserHost({ port: 6000, token: 'b' })
    expect(seen.joined.at(-1)).toEqual({ corePort: 4100, browserHost: { port: 6000, token: 'b' } })
  })

  it('tells the distro\'s paths from this machine\'s', async () => {
    const { made } = parts()
    const session = new WslSession(OPTIONS, made)
    await session.start()
    expect(session.linuxPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\app')).toBe('/home/me/app')
    expect(session.linuxPath('C:\\Users\\me\\x.png')).toBe('/mnt/c/Users/me/x.png')
    expect(session.linuxPath('\\\\wsl.localhost\\Debian\\home\\me')).toBeNull()
    expect(session.windowsPath('/home/me/app/a.ts')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\a.ts')
    expect(session.windowsPath('~/notes.md')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md')
    expect(session.windowsPath('/mnt/d/work')).toBe('D:\\work')
    expect(session.homeFolder()).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me')
  })

  it('lets go of the tunnel when stopped, and stays so', async () => {
    const { made, seen } = parts()
    const session = new WslSession(OPTIONS, made)
    await session.start()
    session.stop()
    expect(seen.stopped).toBe(1)
    expect(await session.endpoint()).toBeNull()
    await session.replaceOldDaemon()
    expect(seen.replaced).toBe(0)
  })
})
