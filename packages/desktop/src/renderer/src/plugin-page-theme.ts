import type { PluginPageTheme } from '@antumi/protocol'

// The app's own token names, so a page can take the chat's CSS as it is.
export const PLUGIN_PAGE_COLORS = ['--bg', '--surface', '--fill', '--fill-2', '--border', '--border-2', '--text', '--text-muted', '--text-3', '--accent', '--accent-bg', '--accent-text', '--focus', '--info', '--warning', '--danger'] as const
export const PLUGIN_PAGE_VALUES = ['--radius', '--radius-sm', '--radius-xs', '--radius-lg', '--mono', '--page-reading'] as const
// As the chat sets them from the reading settings (.chat-view with the user's typeface).
export const PLUGIN_PAGE_TYPEFACE = ['--font', '--chat-font-size', '--chat-font-small', '--chat-width'] as const

export type PluginPageThemeReader = {
  // A colour as the browser resolves it, light-dark() included; empty for a token that is not there.
  color(token: string): string
  value(token: string): string
  typeface(token: string): string
}

// What is not there is left out rather than sent empty, so a page's own fallback applies.
export function pluginPageTheme(scheme: PluginPageTheme['scheme'], read: PluginPageThemeReader): PluginPageTheme {
  const variables: Record<string, string> = {}
  const keep = (token: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed && trimmed.length <= 500) variables[token] = trimmed
  }
  for (const token of PLUGIN_PAGE_COLORS) keep(token, read.color(token))
  for (const token of PLUGIN_PAGE_VALUES) keep(token, read.value(token))
  for (const token of PLUGIN_PAGE_TYPEFACE) keep(token, read.typeface(token))
  return { scheme, variables }
}

// The look where `container` is, and the chat's type as `typeface` (a .chat-view carrying the
// user's typeface attributes) sets it. A colour token's value is light-dark() unresolved, so it goes
// through a probe's computed colour; the chat's sizes are calc() unresolved, so through its font-size.
export function snapshotPluginPageTheme(container: HTMLElement, typeface: HTMLElement): PluginPageTheme {
  const computed = getComputedStyle(container)
  const chat = getComputedStyle(typeface)
  const probe = document.createElement('span')
  container.append(probe)
  const typeProbe = document.createElement('span')
  typeface.append(typeProbe)
  try {
    return pluginPageTheme(computed.colorScheme === 'dark' ? 'dark' : 'light', {
      color: (token) => {
        if (!computed.getPropertyValue(token).trim()) return ''
        probe.style.color = `var(${token})`
        return getComputedStyle(probe).color
      },
      value: (token) => computed.getPropertyValue(token),
      typeface: (token) => {
        const raw = chat.getPropertyValue(token)
        if (!raw.trim() || token === '--font' || token === '--chat-width') return raw
        typeProbe.style.fontSize = `var(${token})`
        return getComputedStyle(typeProbe).fontSize
      }
    })
  } finally {
    probe.remove()
    typeProbe.remove()
  }
}
