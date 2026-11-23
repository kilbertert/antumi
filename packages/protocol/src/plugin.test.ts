import { expect, it } from 'vitest'
import { githubRepository, PluginCall, PluginInfo, PluginInstallSource, PluginManifest, pluginSchemas, RecommendedPlugin } from './plugin'

const detail = { key: 'DEMO-1', title: 'Example', url: 'https://example.com/1', status: 'Open', statusCategory: 'todo', type: 'Issue', priority: null, updatedAt: null, markdown: '# Example' }

it('keeps existing install sources compatible and accepts per-plugin release selectors', () => {
  expect(PluginInstallSource.parse({ kind: 'github', repository: 'demo/plugin' })).toEqual({ kind: 'github', repository: 'demo/plugin' })
  expect(PluginInstallSource.parse({ kind: 'github', repository: 'demo/plugins', tagPrefix: 'github-v', asset: 'github.zip' })).toMatchObject({ tagPrefix: 'github-v', asset: 'github.zip' })
  expect(PluginInstallSource.safeParse({ kind: 'github', repository: 'demo/plugins', tagPrefix: '' }).success).toBe(false)
  expect(RecommendedPlugin.parse({ id: 'antumi.github', name: 'GitHub', repository: 'demo/plugins', tagPrefix: 'github-v', description: '', descriptionEn: '', previousRepositories: ['demo/old-plugin'] })).toMatchObject({ previousRepositories: ['demo/old-plugin'] })
})

it('reads a GitHub project from an owner/repository or a project address', () => {
  expect(githubRepository('demo/plugin')).toBe('demo/plugin')
  expect(githubRepository(' https://github.com/Demo/plugin.git/ ')).toBe('Demo/plugin')
  expect(githubRepository('https://www.github.com/demo/plugin/tree/main')).toBe('demo/plugin')
  expect(githubRepository('github.com/demo/plugin/releases')).toBe('demo/plugin')
  for (const input of ['', 'demo', 'https://gitlab.com/demo/plugin', 'https://github.com/demo', 'not a project']) {
    expect(githubRepository(input)).toBeNull()
  }
})

it('accepts existing text plugins and validates optional image encoding and limits', () => {
  const schema = pluginSchemas.fetch.result
  expect(schema.safeParse(detail).success).toBe(true)
  expect(schema.safeParse({ ...detail, images: [{ name: 'shot.png', base64: 'AQI=' }] }).success).toBe(true)
  for (const base64 of ['AQI', 'AQI?', '=AAA', 'AA=A', 'A===']) {
    expect(schema.safeParse({ ...detail, images: [{ name: 'bad.png', base64 }] }).success).toBe(false)
  }
  expect(schema.safeParse({ ...detail, images: Array.from({ length: 21 }, () => ({ name: '', base64: '' })) }).success).toBe(false)
  const base64 = Buffer.alloc(10 * 1024 * 1024).toString('base64')
  expect(schema.safeParse({ ...detail, images: [{ name: 'limit.png', base64 }] }).success).toBe(true)
  expect(schema.safeParse({ ...detail, images: [{ name: 'too-big.png', base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }] }).success).toBe(false)
  expect(schema.safeParse({ ...detail, images: Array.from({ length: 6 }, () => ({ name: '', base64 })) }).success).toBe(false)
})

const manifest = { id: 'demo.plugin', version: '1.0.0', engines: { antumi: '>=0.1.0' }, entry: { runtime: 'node', main: 'main.mjs' } }
const source = { id: 'demo', name: 'Demo', settings: [] }
const page = { id: 'reader', label: '阅读', translations: { en: { label: 'Reader' } }, entry: 'page/index.html' }

it('keeps source-only manifests as they were and accepts pages beside or instead of sources', () => {
  expect(PluginManifest.parse({ ...manifest, contributes: { sources: [source] } }).contributes).toEqual({ sources: [source], pages: [] })
  expect(PluginManifest.parse({ ...manifest, contributes: { pages: [page] } }).contributes).toEqual({ sources: [], pages: [page] })
  expect(PluginManifest.safeParse({ ...manifest, contributes: { sources: [source], pages: [page] } }).success).toBe(true)
  expect(PluginManifest.safeParse({ ...manifest, contributes: {} }).success).toBe(false)
  expect(PluginManifest.safeParse({ ...manifest, contributes: { sources: [] } }).success).toBe(false)
  expect(PluginManifest.safeParse({ ...manifest, contributes: { pages: [{ ...page, id: 'Reader' }] } }).success).toBe(false)
  expect(PluginManifest.safeParse({ ...manifest, contributes: { pages: Array.from({ length: 5 }, (_, index) => ({ ...page, id: `p${index}` })) } }).success).toBe(false)
})

it('reads a handshake and a plugin record from before pages', () => {
  expect(pluginSchemas.handshake.result.parse({ protocolVersion: 1, id: 'demo.plugin', version: '1.0.0', sources: ['demo'] }).pages).toEqual([])
  expect(PluginInfo.parse({ id: 'demo.plugin', version: '1.0.0', enabled: true, sources: [source], versions: ['1.0.0'], origin: { kind: 'bundled' }, problem: null }).pages).toEqual([])
  expect(pluginSchemas.page.params.safeParse({ page: 'reader', method: 'list', params: { channel: 'hot' } }).success).toBe(true)
  expect(PluginCall.safeParse({ type: 'call', id: 'call', method: 'page', params: {} }).success).toBe(true)
})

it('preserves optional sidebar icon paths and rejects markup or external resources', () => {
  const icon = { path: 'M6 4v12h9' }
  expect(PluginManifest.parse({ ...manifest, contributes: { pages: [{ ...page, icon }] } }).contributes.pages[0]?.icon).toEqual(icon)
  const record = PluginInfo.parse({ ...manifest, enabled: true, sources: [], pages: [{ ...page, icon }], versions: ['1.0.0'], origin: { kind: 'bundled' }, problem: null })
  expect(record.pages[0]?.icon).toEqual(icon)
  for (const path of ['', 'M'.repeat(1025), '<svg onload="alert(1)">', 'https://example.com/logo.svg']) {
    expect(PluginManifest.safeParse({ ...manifest, contributes: { pages: [{ ...page, icon: { path } }] } }).success).toBe(false)
  }
})
