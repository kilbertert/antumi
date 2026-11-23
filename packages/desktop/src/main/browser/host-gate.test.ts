import { describe, expect, it, vi } from 'vitest'
import type { CallbackResponse } from 'electron'
import { BROWSER_HOST_DECISION_WAIT_MS } from '@antumi/protocol'
import { gatedHost, HostGate, type GatedSession } from './host-gate'

describe('gatedHost', () => {
  it('names the host of a top-level navigation to a site outside local development', () => {
    expect(gatedHost({ url: 'https://example.com/a', resourceType: 'mainFrame' })).toBe('example.com')
    expect(gatedHost({ url: 'http://app.example.test:3000/', resourceType: 'mainFrame' })).toBeNull()
    expect(gatedHost({ url: 'http://localhost:5173/', resourceType: 'mainFrame' })).toBeNull()
  })

  it('lets subresources, frames and non-web schemes through', () => {
    expect(gatedHost({ url: 'https://cdn.example.com/x.js', resourceType: 'script' })).toBeNull()
    expect(gatedHost({ url: 'https://example.com/', resourceType: 'subFrame' })).toBeNull()
    expect(gatedHost({ url: 'data:text/html,hi', resourceType: 'mainFrame' })).toBeNull()
    expect(gatedHost({ url: 'about:blank', resourceType: 'mainFrame' })).toBeNull()
    expect(gatedHost({ url: 'not a url', resourceType: 'mainFrame' })).toBeNull()
  })
})

function fakeSession() {
  let listener: Parameters<GatedSession['webRequest']['onBeforeRequest']>[1] | null = null
  let installs = 0
  const session: GatedSession = {
    webRequest: {
      onBeforeRequest(_filter, next) {
        installs++
        listener = next
      }
    }
  }
  const navigate = (url: string, webContentsId = 7) => new Promise<CallbackResponse>((resolve) => {
    if (!listener) throw new Error('gate not installed')
    listener({ url, resourceType: 'mainFrame', webContentsId }, resolve)
  })
  return { session, navigate, installs: () => installs }
}

describe('HostGate', () => {
  it('gives up on a check nobody answers in time, and reports why the tab was stopped', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const gate = new HostGate(() => null, (check) => asked.push(check.checkId))
    const outcome = gate['check']({ checkId: 'c1', tabId: 't1', conversationId: 'conv', host: 'example.com', url: 'https://example.com/' })
    expect(asked).toEqual(['c1'])
    await vi.advanceTimersByTimeAsync(BROWSER_HOST_DECISION_WAIT_MS)
    expect(await outcome).toBe('awaiting-host')
    vi.useRealTimers()
  })

  it('resolves a check as core answers it, once', async () => {
    const gate = new HostGate(() => null, () => {})
    const outcome = gate['check']({ checkId: 'c2', tabId: 't1', conversationId: 'conv', host: 'example.com', url: 'https://example.com/' })
    gate.resolve('c2', false)
    gate.resolve('c2', true)
    expect(await outcome).toBe('denied')
    expect(gate.takeOutcome('t1')).toBe('done')
  })

  it('holds a tab\'s navigation in the network stack until core answers, and cancels a denied one', async () => {
    const asked: string[] = []
    const gate = new HostGate((id) => (id === 7 ? { id: 't1', conversationId: 'conv' } : null), (check) => asked.push(check.checkId))
    const fake = fakeSession()
    gate.install(fake.session)
    gate.install(fake.session)
    expect(fake.installs()).toBe(1)

    const allowed = fake.navigate('https://example.com/')
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    gate.resolve(asked[0] ?? '', true)
    expect(await allowed).toEqual({})

    const denied = fake.navigate('https://other.example/')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    gate.resolve(asked[1] ?? '', false)
    expect(await denied).toEqual({ cancel: true })
    expect(gate.takeOutcome('t1')).toBe('denied')
  })

  it('lets through what is no tab\'s, or stays local, without asking', async () => {
    const ask = vi.fn()
    const gate = new HostGate((id) => (id === 7 ? { id: 't1', conversationId: null } : null), ask)
    const fake = fakeSession()
    gate.install(fake.session)
    expect(await fake.navigate('https://example.com/', 99)).toEqual({})
    expect(await fake.navigate('http://localhost:3000/')).toEqual({})
    expect(ask).not.toHaveBeenCalled()
  })
})
