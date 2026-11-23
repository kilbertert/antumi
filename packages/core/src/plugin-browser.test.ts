import { describe, expect, it } from 'vitest'
import { PluginManifest } from '@antumi/protocol'
import { pluginBrowserRequest } from './plugin-browser'

const manifest = PluginManifest.parse({ id: 'demo.reader', version: '1.0.0', engines: { antumi: '*' }, entry: { runtime: 'node', main: 'main.mjs' },
  contributes: { pages: [{ id: 'reader', label: 'Reader', entry: 'page/index.html' }] }, browserSites: [{ id: 'forum', origin: 'https://forum.test', loginPath: '/login' }] })

describe('plugin browser policy', () => {
  it('isolates credentials per plugin and site while keeping the key across updates', () => {
    const request = { action: 'status', site: 'forum' } as const
    const key = pluginBrowserRequest(manifest, request).key
    expect(pluginBrowserRequest({ ...manifest, version: '2.0.0' }, request).key).toBe(key)
    expect(pluginBrowserRequest({ ...manifest, id: 'other.reader' }, request).key).not.toBe(key)
    expect(pluginBrowserRequest(manifest, request, '/test-home/plugins').key).not.toBe(pluginBrowserRequest(manifest, request, '/real-home/plugins').key)
    expect(pluginBrowserRequest({ ...manifest, browserSites: [{ id: 'forum', origin: 'https://other.test', loginPath: '/login' }] }, request).key).not.toBe(key)
  })

  it('refuses undeclared sites and credentials supplied by the plugin', () => {
    expect(() => pluginBrowserRequest(manifest, { action: 'status', site: 'other' })).toThrow('未声明')
    for (const header of ['Cookie', 'Authorization', 'Host', 'Origin', 'Referer']) {
      expect(() => pluginBrowserRequest(manifest, { action: 'request', site: 'forum', path: '/', headers: { [header]: 'secret' } })).toThrow('请求头')
    }
  })

  it('refuses URL escapes and invalid origins before contacting the browser', () => {
    for (const path of ['//other.test/', '/\\other.test/', 'https://other.test/', '/\n']) {
      expect(() => pluginBrowserRequest(manifest, { action: 'request', site: 'forum', path })).toThrow()
    }
    for (const origin of ['http://forum.test', 'https://user:pass@forum.test', 'https://forum.test/path']) {
      expect(PluginManifest.safeParse({ ...manifest, browserSites: [{ id: 'forum', origin, loginPath: '/login' }] }).success).toBe(false)
      expect(PluginManifest.safeParse({ ...manifest, browserSites: [{ id: 'forum', origin: 'https://forum.test', requestOrigins: [origin], loginPath: '/login' }] }).success).toBe(false)
    }
  })

  it('permits declared request origins, long-poll timeouts and supported headers', () => {
    const declared = PluginManifest.parse({ ...manifest, browserSites: [{ id: 'forum', origin: 'https://forum.test', requestOrigins: ['https://ping.forum.test'], loginPath: '/login' }] })
    expect(pluginBrowserRequest(manifest, { action: 'request', site: 'forum', path: '/posts.json', method: 'POST', headers: { 'X-CSRF-Token': 'csrf' }, body: 'raw=hello' }).request).toMatchObject({ method: 'POST' })
    expect(pluginBrowserRequest(declared, { action: 'request', site: 'forum', origin: 'https://ping.forum.test', path: '/poll', method: 'POST', timeoutMs: 35000,
      headers: { 'x-shared-session-key': 'shared', 'discourse-present': 'true', 'dont-chunk': 'true' }, body: 'channel=90' }).request).toMatchObject({ origin: 'https://ping.forum.test', timeoutMs: 35000 })
    expect(() => pluginBrowserRequest(manifest, { action: 'request', site: 'forum', origin: 'https://ping.forum.test', path: '/poll' })).toThrow('不能离开')
    expect(() => pluginBrowserRequest(manifest, { action: 'request', site: 'forum', path: '/', body: 'ignored' })).toThrow('正文')
  })
})
