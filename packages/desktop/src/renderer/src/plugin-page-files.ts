import type { PluginPageFiles, RpcConnection } from '@antumi/protocol'
import type { PluginPageRef } from './plugin-pages'

// A page's files, kept so that coming back to the page (from settings, say) frames it again without
// asking core. Kept per connection, and only until the plugins change: a plugin removed and put back
// at the same version may be other files.
let bundles = new WeakMap<RpcConnection, Map<string, Promise<PluginPageFiles>>>()

export function pluginPageFiles(rpc: RpcConnection, ref: PluginPageRef, version: string): Promise<PluginPageFiles> {
  const kept = bundles.get(rpc) ?? new Map<string, Promise<PluginPageFiles>>()
  bundles.set(rpc, kept)
  const key = `${ref.plugin}/${ref.page}@${version}`
  const cached = kept.get(key)
  if (cached) return cached
  const loading = rpc.call('plugins.pageFiles', { id: ref.plugin, page: ref.page })
  kept.set(key, loading)
  loading.catch(() => { if (kept.get(key) === loading) kept.delete(key) })
  return loading
}

export function forgetPluginPageFiles(): void {
  bundles = new WeakMap()
}
