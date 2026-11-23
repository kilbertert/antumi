import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PluginPageTheme } from '@antumi/protocol'
import { PLUGIN_PAGE_COLORS, PLUGIN_PAGE_TYPEFACE, PLUGIN_PAGE_VALUES, pluginPageTheme } from './plugin-page-theme'

describe('plugin page theme', () => {
  it('sends the app tokens under their own names, leaving out what is not there', () => {
    const theme = pluginPageTheme('dark', {
      color: (token) => token === '--warning' ? '' : `rgb(1, 2, 3)`,
      value: (token) => token === '--radius' ? ' 8px ' : token === '--mono' ? '' : '1px',
      typeface: (token) => token === '--chat-width' ? 'x'.repeat(501) : '14px'
    })
    expect(PluginPageTheme.safeParse(theme).success).toBe(true)
    expect(theme.scheme).toBe('dark')
    expect(theme.variables['--surface']).toBe('rgb(1, 2, 3)')
    expect(theme.variables['--radius']).toBe('8px')
    expect(theme.variables['--chat-font-size']).toBe('14px')
    expect(Object.keys(theme.variables)).not.toContain('--warning')
    expect(Object.keys(theme.variables)).not.toContain('--mono')
    expect(Object.keys(theme.variables)).not.toContain('--chat-width')
    expect(Object.keys(theme.variables)).toHaveLength(PLUGIN_PAGE_COLORS.length + PLUGIN_PAGE_VALUES.length + PLUGIN_PAGE_TYPEFACE.length - 3)
  })

  it('names only tokens the stylesheet defines', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    for (const token of [...PLUGIN_PAGE_COLORS, ...PLUGIN_PAGE_VALUES, ...PLUGIN_PAGE_TYPEFACE]) expect(css, token).toMatch(new RegExp(`\\n\\s*${token}:`))
  })
})
