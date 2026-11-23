import { z } from 'zod'
import { SourceCommentOptions, SourceCommentPage, SourceCommentState } from './source-comments'
import { MAX_ATTACHMENT_BYTES, MAX_TASK_IMAGES } from './attachments'
import { LoginNotice, LoginPrompt, SettingField, SourceAttachmentRef, SourceId, SourceIssue, SourceProblem } from './source'
import { TextTranslations } from './localization'
import { PluginBrowserRequest, PluginBrowserResult, PluginBrowserSite } from './plugin-browser'

export const PLUGIN_PROTOCOL_VERSION = 1
export const PluginId = z.string().max(120).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
export const PluginVersion = z.string().max(80).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/)
export const PluginSource = z.object({ id: SourceId, name: z.string().min(1).max(64), settings: z.array(SettingField).max(32), commentSync: z.literal(1).optional() })
// A page the plugin draws itself, which the desktop shows in a sandboxed frame. entry is its HTML,
// in a directory of its own inside the package: everything in that directory is served to the frame.
export const PluginPageId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
export const PluginPage = z.object({
  id: PluginPageId, label: z.string().min(1).max(64), translations: TextTranslations.optional(), entry: z.string().min(1).max(240),
  // A stroke on the sidebar's 20px grid, never plugin-supplied SVG markup or a remote image.
  icon: z.object({ path: z.string().min(1).max(1024).regex(/^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/) }).optional()
})
export type PluginPage = z.infer<typeof PluginPage>
export const PluginManifest = z.object({
  id: PluginId,
  version: PluginVersion,
  engines: z.object({ antumi: z.string().min(1).max(100) }),
  // Plugins from before pages name sources alone; one with neither does nothing.
  contributes: z.object({ sources: z.array(PluginSource).max(16).default([]), pages: z.array(PluginPage).max(4).default([]) })
    .refine((value) => value.sources.length + value.pages.length > 0),
  entry: z.object({ runtime: z.literal('node'), main: z.string().min(1).max(240) }),
  browserSites: z.array(PluginBrowserSite).max(8).refine((sites) => new Set(sites.map((site) => site.id)).size === sites.length).optional(),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(32).default([])
})

export type PluginManifest = z.infer<typeof PluginManifest>
const ReleaseTagPrefix = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
export const PluginInstallSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('github'), repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/), tag: z.string().min(1).max(128).optional(), tagPrefix: ReleaseTagPrefix.optional(), asset: z.string().min(1).max(200).optional() })
])
export type PluginInstallSource = z.infer<typeof PluginInstallSource>

// A GitHub project as typed in settings: owner/repository, or the project page (a tree or release link still counts).
export function githubRepository(input: string): string | null {
  const text = input.trim().replace(/\/+$/, '')
  const direct = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(text)
  const owner = direct?.[1]
  const repo = direct?.[2]
  const path = owner && repo ? [owner, repo] as const : githubPath(text)
  if (!path) return null
  const name = path[1].replace(/\.git$/, '')
  const repository = `${path[0]}/${name}`
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : null
}

function githubPath(input: string): [string, string] | null {
  let url: URL
  try { url = new URL(input.includes('://') ? input : `https://${input}`) } catch { return null }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')) return null
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  return owner && repo ? [owner, repo] : null
}
export const PluginInfo = z.object({
  id: PluginId, version: PluginVersion, enabled: z.boolean(),
  sources: z.array(PluginSource), pages: z.array(PluginPage).default([]), versions: z.array(PluginVersion),
  origin: z.union([PluginInstallSource, z.object({ kind: z.literal('bundled') })]),
  problem: z.string().nullable()
})
export type PluginInfo = z.infer<typeof PluginInfo>
export const RecommendedPlugin = z.object({
  id: PluginId, name: z.string().min(1).max(64),
  repository: PluginInstallSource.options[1].shape.repository,
  tagPrefix: ReleaseTagPrefix.optional(),
  asset: PluginInstallSource.options[1].shape.asset,
  previousRepositories: z.array(PluginInstallSource.options[1].shape.repository).optional(),
  description: z.string().max(500), descriptionEn: z.string().max(500)
})
export type RecommendedPlugin = z.infer<typeof RecommendedPlugin>

export const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024
const imageSize = (value: string) => value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
const SourceImage = z.object({
  name: z.string().max(4096),
  base64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && imageSize(value) <= MAX_ATTACHMENT_BYTES)
})
const SourceImages = z.array(SourceImage).max(MAX_TASK_IMAGES)
  .refine((images) => images.reduce((size, image) => size + imageSize(image.base64), 0) <= MAX_SOURCE_IMAGE_BYTES)
// A file the user chose to download, not a picture shown inline: MAX_ATTACHMENT_BYTES is an image's
// budget and rejected the 38MB attachment this was built against, so a file has its own ceiling
// with the base64 expansion accounted for.
export const MAX_SOURCE_FILE_BYTES = 96 * 1024 * 1024
const SourceFile = z.object({
  name: z.string().max(4096),
  base64: z.string().max(Math.ceil(MAX_SOURCE_FILE_BYTES / 3) * 4)
    .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && imageSize(value) <= MAX_SOURCE_FILE_BYTES)
})

export const PluginCredential = z.object({ kind: z.string().max(32), payload: z.record(z.string(), z.string()) })
export type PluginCredential = z.infer<typeof PluginCredential>
const Settings = z.record(z.string(), z.string())
export const PluginPageMethod = z.string().min(1).max(64)
export const pluginMethods = {
  handshake: { params: z.object({ protocolVersion: z.number().int(), features: z.array(z.string()).optional() }), result: z.object({ protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION), id: PluginId, version: PluginVersion, sources: z.array(SourceId), pages: z.array(PluginPageId).default([]) }) },
  normalizeSettings: { params: z.object({ source: SourceId, settings: Settings }), result: Settings },
  normalizeKey: { params: z.object({ source: SourceId, key: z.string() }), result: z.string() },
  envCredential: { params: z.object({ source: SourceId }), result: PluginCredential.nullable() },
  login: { params: z.object({ source: SourceId, settings: Settings }), result: z.object({ credential: PluginCredential, account: z.string().max(200) }) },
  list: { params: z.object({ source: SourceId, settings: Settings, credential: PluginCredential }), result: z.array(SourceIssue).max(200) },
  // images false: the issue's text alone, its images fetched by a later call; a plugin that leaves
  // them out says how many in imagesDeferred. Older plugins ignore it and send the images anyway.
  comments: { params: SourceCommentOptions.extend({ source: SourceId, settings: Settings, credential: PluginCredential, key: z.string() }), result: SourceCommentPage },
  // One image a comment names (SourceComment.images), asked for only when the comment goes to an agent.
  image: { params: z.object({ source: SourceId, settings: Settings, credential: PluginCredential, key: z.string(), id: z.string().min(1).max(500) }), result: SourceImage },
  // A page calling its own plugin's backend. Both ends are the plugin's, so method, params and
  // result pass through core unread.
  page: { params: z.object({ page: PluginPageId, method: PluginPageMethod, params: z.unknown() }), result: z.object({ result: z.unknown() }) },
  // One attachment's bytes, asked for only when the user downloads it: these run to tens of
  // megabytes and are usually never opened, so they stay out of the fetch result.
  attachment: { params: z.object({ source: SourceId, settings: Settings, credential: PluginCredential, key: z.string(), id: z.string().min(1).max(500) }), result: SourceFile },
  fetch: {
    params: z.object({ source: SourceId, settings: Settings, credential: PluginCredential, key: z.string(), images: z.boolean().optional() }),
    result: SourceIssue.extend({
      markdown: z.string().max(50_000), images: SourceImages.optional(),
      imagesDeferred: z.number().int().nonnegative().max(1000).optional(), commentState: SourceCommentState.optional(),
      // Named, not fetched: without this field the attachment list is dropped here, before core
      // ever sees it.
      attachments: z.array(SourceAttachmentRef).max(100).optional()
    })
  }
} as const
export type PluginMethod = keyof typeof pluginMethods
type PluginSchemas = { [M in PluginMethod]: { params: z.ZodType<z.output<(typeof pluginMethods)[M]['params']>>; result: z.ZodType<z.output<(typeof pluginMethods)[M]['result']>> } }
export const pluginSchemas: PluginSchemas = pluginMethods
export type PluginParams<M extends PluginMethod> = z.output<(typeof pluginMethods)[M]['params']>
export type PluginResult<M extends PluginMethod> = z.output<(typeof pluginMethods)[M]['result']>
export const PluginCall = z.object({
  type: z.literal('call'), id: z.string(),
  method: z.enum(['handshake', 'normalizeSettings', 'normalizeKey', 'envCredential', 'login', 'list', 'fetch', 'comments', 'image', 'page', 'attachment']),
  params: z.unknown()
})
export const PluginAnswer = z.object({ type: z.literal('answer'), id: z.string(), value: z.string() })
export const PluginBrowserAnswer = z.object({ type: z.literal('browserResult'), id: z.string(), result: PluginBrowserResult.optional(), error: z.string().max(2000).optional() })
export const PluginMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('browser'), id: z.string().max(100), request: PluginBrowserRequest }),
  z.object({ type: z.literal('result'), id: z.string(), result: z.unknown() }),
  z.object({ type: z.literal('error'), id: z.string(), error: SourceProblem }),
  z.object({ type: z.literal('prompt'), id: z.string(), prompt: LoginPrompt }),
  z.object({ type: z.literal('notify'), notice: LoginNotice }),
  // How far a download has read. Separate from notify: that one is login-only, and this arrives
  // while an attachment is being fetched, often for tens of seconds.
  z.object({ type: z.literal('progress'), read: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable() })
])

// One page's files as core hands them to the desktop, which serves them to the frame: core may run
// on another machine. version names the installed plugin they came from.
export const MAX_PLUGIN_PAGE_BYTES = 8 * 1024 * 1024
export const PluginPageFiles = z.object({
  version: PluginVersion,
  entry: z.string().min(1).max(240),
  files: z.array(z.object({ path: z.string().min(1).max(240), base64: z.string().max(Math.ceil(MAX_PLUGIN_PAGE_BYTES / 3) * 4) })).max(256)
})
export type PluginPageFiles = z.infer<typeof PluginPageFiles>
