import { openPluginPage, useCore, usePluginPagesSupported } from '../core-store'
import { useLocale } from '../i18n'
import { availablePluginPages, pluginPageLabel } from '../plugin-pages'
import { PuzzleIcon } from './icons'

// One entry per page of each enabled plugin, beside the routines and agents.
export function PluginPageEntries() {
  const supported = usePluginPagesSupported()
  const plugins = useCore((s) => s.plugins)
  const open = useCore((s) => s.section === 'plugin' && !s.settingsOpen && !s.overviewOpen && !s.inboxOpen && !s.worktreesOpen && !s.routinesOpen ? s.pluginPage : null)
  const locale = useLocale((s) => s.locale)
  if (!supported) return null
  return <>{availablePluginPages(plugins).map((entry) => {
    const label = pluginPageLabel(entry.info, locale)
    return <button key={`${entry.plugin}/${entry.page}`} type="button" className="inbox-entry sidebar-plugin-page" aria-current={open?.plugin === entry.plugin && open.page === entry.page} aria-label={label} title={label} onClick={() => openPluginPage(entry.plugin, entry.page)}>
      {entry.info.icon
        ? <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={entry.info.icon.path} /></svg>
        : <PuzzleIcon />}
      <span className="sidebar-navigation-label">{label}</span>
    </button>
  })}</>
}
