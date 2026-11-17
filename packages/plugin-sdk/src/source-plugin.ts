import type { LoginNotice, LoginPrompt, SourceIssue } from '../../protocol/src/source.js'
import type { SourceCommentOptions, SourceCommentPage } from '../../protocol/src/source-comments.js'
import type { PluginCredential, PluginResult } from '../../protocol/src/plugin.js'

export type SourceSettings = Readonly<Record<string, string>>
export type SourceCredential = PluginCredential
// An attachment a source lists but does not send: the snapshot carries its identity and size, and
// the bytes are read only when someone asks. Unlike images, these are frequently larger than a
// snapshot budget and often never opened at all, so sending them with the text would be waste.
export type SourceAttachment = { id: string; name: string; size: number | null }
export type SourceIssueDetail = Omit<PluginResult<'fetch'>, 'images'> & {
  images?: readonly { name: string; bytes: Uint8Array }[]
  attachments?: readonly SourceAttachment[]
}
export type SourceFetchOptions = { images: boolean }
export type LoginSession = {
  prompt(prompt: LoginPrompt): Promise<string>
  notify(notice: LoginNotice): void
}

export type SourcePlugin = {
  readonly id: string
  comments?(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage>
  // The bytes of an image a comment names in its images, asked for when Antumi sends the comment to
  // an agent. Required once comments name images.
  image?(settings: SourceSettings, credential: SourceCredential, key: string, id: string, signal: AbortSignal): Promise<{ name: string; bytes: Uint8Array }>
  // One attachment's bytes, read on demand. key is the issue, because a file id is only meaningful
  // within the permissions of the item it hangs off.
  attachment?(settings: SourceSettings, credential: SourceCredential, key: string, id: string, signal: AbortSignal): Promise<{ name: string; bytes: Uint8Array }>
  normalizeSettings(values: SourceSettings): Record<string, string> | Promise<Record<string, string>>
  normalizeKey?(key: string): string | Promise<string>
  envCredential?(env: Readonly<Record<string, string | undefined>>): SourceCredential | null
  login(session: LoginSession, settings: SourceSettings, signal: AbortSignal): Promise<{ credential: SourceCredential; account: string }>
  list(settings: SourceSettings, credential: SourceCredential, signal: AbortSignal): Promise<SourceIssue[]>
  // images false: Antumi wants the issue's text at once and asks for the images in a later call; a
  // plugin that honours it leaves them out and counts them in imagesDeferred. Absent means true.
  fetch(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal, options?: SourceFetchOptions): Promise<SourceIssueDetail>
}
