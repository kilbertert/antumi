import { expect, it } from 'vitest'
import { MAX_PLUGIN_PAGE_STATE, PluginPageFrameMessage, PluginPageHostMessage, pluginPageState } from './plugin-page'

const token = { antumiPluginPage: 'bridge' }

it('accepts what a page may say and refuses the rest', () => {
  for (const message of [
    { kind: 'ready' },
    { kind: 'call', id: 1, method: 'list', params: { channel: 'hot' } },
    { kind: 'open', url: 'https://example.com/t/1' },
    { kind: 'state', value: { read: 3 } },
    { kind: 'key', key: 'k', code: 'KeyK', meta: true, ctrl: false, alt: false, shift: false },
    { kind: 'leave' }
  ]) expect(PluginPageFrameMessage.safeParse({ ...token, ...message }).success).toBe(true)
  expect(PluginPageFrameMessage.safeParse({ kind: 'ready' }).success).toBe(false)
  expect(PluginPageFrameMessage.safeParse({ ...token, kind: 'call', id: 1, method: '', params: null }).success).toBe(false)
  expect(PluginPageFrameMessage.safeParse({ ...token, kind: 'call', id: 1, method: 'x'.repeat(65), params: null }).success).toBe(false)
  expect(PluginPageFrameMessage.safeParse({ ...token, kind: 'navigate', url: 'https://example.com' }).success).toBe(false)
})

it('accepts what the desktop answers with', () => {
  const theme = { scheme: 'dark', variables: { '--bg': 'rgb(0, 0, 0)' } }
  expect(PluginPageHostMessage.safeParse({ ...token, kind: 'init', theme, state: null, locale: 'zh-CN' }).success).toBe(true)
  expect(PluginPageHostMessage.safeParse({ ...token, kind: 'theme', theme }).success).toBe(true)
  expect(PluginPageHostMessage.safeParse({ ...token, kind: 'response', id: 1, result: [1, 2] }).success).toBe(true)
  expect(PluginPageHostMessage.safeParse({ ...token, kind: 'response', id: 1, error: 'failed' }).success).toBe(true)
  expect(PluginPageHostMessage.safeParse({ ...token, kind: 'theme', theme: { scheme: 'sepia', variables: {} } }).success).toBe(false)
})

it('keeps a page state that is JSON within the limit', () => {
  expect(pluginPageState({ read: { a: 1 } })).toEqual({ read: { a: 1 } })
  expect(pluginPageState('x'.repeat(MAX_PLUGIN_PAGE_STATE))).toBeNull()
  // Counted in bytes: these are a third of the limit in characters, and over it once encoded.
  expect(pluginPageState('界'.repeat(Math.ceil(MAX_PLUGIN_PAGE_STATE / 3)))).toBeNull()
  expect(pluginPageState('界'.repeat(MAX_PLUGIN_PAGE_STATE / 3 - 10))).not.toBeNull()
  expect(pluginPageState(undefined)).toBeNull()
  expect(pluginPageState({ at: new Date(0) })).toBeNull()
})
