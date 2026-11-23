import { describe, expect, it } from 'vitest'
import { MAX_PLUGIN_PAGE_BYTES, type PluginPageFiles } from '@antumi/protocol'
import { MAX_PLUGIN_PAGE_FILES, MAX_PLUGIN_PAGE_OWNER_BYTES, PluginPageBundles } from './plugin-page-bundles'

const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString('base64') })
const page = (files: PluginPageFiles['files'], entry = 'index.html'): PluginPageFiles => ({ version: '1.0.0', entry, files })
const sized = (path: string, bytes: number) => ({ path, base64: Buffer.alloc(bytes).toString('base64') })
const at = (url: string, path: string) => new URL(path, url).href

describe('plugin page bundles', () => {
  it('serves each file of a bundle by its path with its type and the page policy', async () => {
    const bundles = new PluginPageBundles()
    const url = bundles.create(1, page([file('index.html', '<p>hi</p>'), file('app.js', 'go()'), file('styles/main.css', 'p{}'), file('img/Logo.PNG', 'png'), file('data.json', '{}')]))
    expect(url).toMatch(/^antumi-plugin:\/\/[0-9a-f-]{36}\/index\.html$/)
    const html = bundles.serve(new Request(url))
    expect(await html.text()).toBe('<p>hi</p>')
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html.headers.get('cache-control')).toBe('no-store')
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    expect(html.headers.get('referrer-policy')).toBe('no-referrer')
    const policy = html.headers.get('content-security-policy') ?? ''
    expect(policy).toContain('script-src antumi-plugin:;')
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(bundles.serve(new Request(at(url, 'app.js'))).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await bundles.serve(new Request(at(url, 'styles/main.css'))).text()).toBe('p{}')
    expect(bundles.serve(new Request(at(url, 'img/Logo.PNG'))).headers.get('content-type')).toBe('image/png')
    expect(bundles.serve(new Request(at(url, 'data.json'))).headers.get('content-type')).toBe('application/json')
  })

  it('keeps inline script out of the page policy', () => {
    const bundles = new PluginPageBundles()
    const url = bundles.create(1, page([file('index.html', '')]))
    const policy = bundles.serve(new Request(url)).headers.get('content-security-policy') ?? ''
    const script = policy.split('; ').find((directive) => directive.startsWith('script-src'))
    expect(script).toBe('script-src antumi-plugin:')
  })

  it('answers GET alone, and 404 for unknown files, types and bundles', () => {
    const bundles = new PluginPageBundles()
    const url = bundles.create(1, page([file('index.html', 'x'), file('tool.exe', 'MZ'), file('README', 'r'), file('a.constructor', 'c')]))
    expect(bundles.serve(new Request(url, { method: 'POST', body: 'x' })).status).toBe(404)
    expect(bundles.serve(new Request(url, { method: 'HEAD' })).status).toBe(404)
    expect(bundles.serve(new Request(at(url, 'missing.js'))).status).toBe(404)
    expect(bundles.serve(new Request(at(url, 'tool.exe'))).status).toBe(404)
    expect(bundles.serve(new Request(at(url, 'README'))).status).toBe(404)
    expect(bundles.serve(new Request(at(url, 'a.constructor'))).status).toBe(404)
    expect(bundles.serve(new Request(at(url, '/'))).status).toBe(404)
    expect(bundles.serve(new Request('antumi-plugin://00000000-0000-4000-8000-000000000000/index.html')).status).toBe(404)
  })

  it('serves names that need escaping in a URL', async () => {
    const bundles = new PluginPageBundles()
    const url = bundles.create(1, page([file('my page.html', 'spaced'), file('图/图标.svg', '<svg/>')], 'my page.html'))
    expect(await bundles.serve(new Request(url)).text()).toBe('spaced')
    expect(bundles.serve(new Request(at(url, '图/图标.svg'))).headers.get('content-type')).toBe('image/svg+xml')
  })

  it('refuses paths that are absolute, step out, use backslashes or have empty names', () => {
    const bundles = new PluginPageBundles()
    for (const path of ['/index.html', '../index.html', 'a/../index.html', 'a\\index.html', 'a//index.html', 'a/', './index.html'])
      expect(() => bundles.create(1, page([file('index.html', 'x'), file(path, 'x')]))).toThrow()
    expect(() => bundles.create(1, page([file('index.html', 'x'), file('index.html', 'y')]))).toThrow()
    expect(() => bundles.create(1, page([file('index.html', 'x')], 'missing.html'))).toThrow()
    expect(() => bundles.create(1, page([file('index.html', 'x')], '../index.html'))).toThrow()
    expect(() => bundles.create(1, page([{ path: 'index.html', base64: 'not base64!' }]))).toThrow()
  })

  it('bounds a bundle, its files and the memory of each renderer', () => {
    const bundles = new PluginPageBundles()
    expect(() => bundles.create(1, page([file('index.html', 'x'), sized('big.png', MAX_PLUGIN_PAGE_BYTES)]))).toThrow()
    expect(() => bundles.create(1, page([file('index.html', 'x'), ...Array.from({ length: MAX_PLUGIN_PAGE_FILES }, (_, index) => file(`${index}.txt`, ''))]))).toThrow()
    const full = MAX_PLUGIN_PAGE_OWNER_BYTES / MAX_PLUGIN_PAGE_BYTES
    for (let index = 0; index < full; index++) bundles.create(1, page([sized('index.html', MAX_PLUGIN_PAGE_BYTES)]))
    expect(() => bundles.create(1, page([file('index.html', 'x')]))).toThrow()
    expect(() => bundles.create(2, page([file('index.html', 'x')]))).not.toThrow()
  })

  it('removes a bundle only for its owner, and all of an owner at once', () => {
    const bundles = new PluginPageBundles()
    const first = bundles.create(1, page([file('index.html', 'first')]))
    const second = bundles.create(1, page([file('index.html', 'second')]))
    const other = bundles.create(2, page([file('index.html', 'other')]))
    bundles.remove(2, first)
    expect(bundles.serve(new Request(first)).status).toBe(200)
    bundles.remove(1, first)
    expect(bundles.serve(new Request(first)).status).toBe(404)
    expect(bundles.serve(new Request(second)).status).toBe(200)
    bundles.removeOwner(1)
    expect(bundles.serve(new Request(second)).status).toBe(404)
    expect(bundles.serve(new Request(other)).status).toBe(200)
    // Freed memory can be used again.
    for (let index = 0; index < MAX_PLUGIN_PAGE_OWNER_BYTES / MAX_PLUGIN_PAGE_BYTES; index++) bundles.create(1, page([sized('index.html', MAX_PLUGIN_PAGE_BYTES)]))
  })
})
