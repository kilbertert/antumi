import { createHash } from 'node:crypto'
import { PluginBrowserRequest, type PluginManifest } from '@antumi/protocol'

const HEADERS = new Set(['accept', 'content-type', 'x-csrf-token', 'x-requested-with', 'x-shared-session-key', 'discourse-present', 'dont-chunk'])

export function pluginBrowserRequest(manifest: PluginManifest, raw: PluginBrowserRequest, namespace = '') {
  const request = PluginBrowserRequest.parse(raw)
  const site = manifest.browserSites?.find((site) => site.id === request.site)
  if (!site) throw new Error('插件未声明这个登录站点')
  if (request.action === 'request') {
    const origin = request.origin ?? site.origin
    if (origin !== site.origin && !site.requestOrigins?.includes(origin)) throw new Error('插件请求不能离开声明的站点')
    if (new URL(request.path, origin).origin !== origin) throw new Error('插件请求不能离开声明的站点')
    if (request.method === 'GET' && request.body !== undefined) throw new Error('读取请求不能携带正文')
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(value)) throw new Error('插件不能设置这个请求头')
    }
  }
  const key = createHash('sha256').update(`${namespace}\0${manifest.id}\0${site.id}\0${site.origin}`).digest('hex')
  return { key, site, request }
}
