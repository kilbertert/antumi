import { randomUUID } from 'node:crypto'
import { MAX_PLUGIN_PAGE_BYTES, PLUGIN_PAGE_SCHEME, type PluginPageFiles } from '@antumi/protocol'
import { PLUGIN_PAGE_POLICY } from '../shared/plugin-page-policy'

export const MAX_PLUGIN_PAGE_OWNER_BYTES = 32 * 1024 * 1024
export const MAX_PLUGIN_PAGE_FILES = 256

const TYPES: ReadonlyMap<string, string> = new Map(Object.entries({
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain; charset=utf-8'
}))
const HEADERS = { 'content-security-policy': PLUGIN_PAGE_POLICY, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }

// Relative, with / between non-empty names, and never stepping out: a name is looked up as it is,
// so only what the bundle holds can be served under it.
function validPath(path: string): boolean {
  return !path.includes('\\') && !path.includes('\0') && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function decoded(base64: string): Buffer {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid plugin page file')
  return Buffer.from(base64, 'base64')
}

type Bundle = { owner: number; files: ReadonlyMap<string, Buffer>; bytes: number }

// A plugin page's files, held in memory for the renderer that registered them: core may be on
// another machine, so nothing here is read from disk.
export class PluginPageBundles {
  private readonly bundles = new Map<string, Bundle>()

  create(owner: number, page: PluginPageFiles): string {
    if (page.files.length > MAX_PLUGIN_PAGE_FILES) throw new Error('Plugin page has too many files')
    const files = new Map<string, Buffer>()
    let bytes = 0
    for (const file of page.files) {
      if (!validPath(file.path) || files.has(file.path)) throw new Error('Invalid plugin page file path')
      const body = decoded(file.base64)
      bytes += body.byteLength
      if (bytes > MAX_PLUGIN_PAGE_BYTES) throw new Error('Plugin page is too large')
      files.set(file.path, body)
    }
    if (!validPath(page.entry) || !files.has(page.entry)) throw new Error('Plugin page has no entry')
    if (this.ownerBytes(owner) + bytes > MAX_PLUGIN_PAGE_OWNER_BYTES) throw new Error('Plugin pages are too large')
    const id = randomUUID()
    this.bundles.set(id, { owner, files, bytes })
    return `${PLUGIN_PAGE_SCHEME}://${id}/${page.entry.split('/').map(encodeURIComponent).join('/')}`
  }

  remove(owner: number, url: string): void {
    const id = idOf(url)
    if (id && this.bundles.get(id)?.owner === owner) this.bundles.delete(id)
  }

  removeOwner(owner: number): void {
    for (const [id, bundle] of this.bundles) if (bundle.owner === owner) this.bundles.delete(id)
  }

  serve(request: Request): Response {
    const id = request.method === 'GET' ? idOf(request.url) : null
    const bundle = id ? this.bundles.get(id) : undefined
    const path = bundle ? filePath(request.url) : null
    const body = path ? bundle?.files.get(path) : undefined
    const extension = path ? /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() : undefined
    const type = extension ? TYPES.get(extension) : undefined
    return body && type ? new Response(new Uint8Array(body), { headers: { 'content-type': type, ...HEADERS } }) : new Response('not found', { status: 404, headers: HEADERS })
  }

  private ownerBytes(owner: number): number {
    let sum = 0
    for (const bundle of this.bundles.values()) if (bundle.owner === owner) sum += bundle.bytes
    return sum
  }
}

function idOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${PLUGIN_PAGE_SCHEME}:` ? parsed.host : null
  } catch { return null }
}

function filePath(url: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url).pathname.slice(1))
    return validPath(path) ? path : null
  } catch { return null }
}
