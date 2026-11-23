import { useCore } from '../core-store'
import { t } from '../i18n'
import { setPreference, usePreferences } from '../preferences'
import { ChatIcon, ConversationListIcon } from './icons'
import { InboxEntry } from './InboxEntry'
import { OverviewEntry } from './OverviewEntry'
import { RoutinesEntry } from './RoutinesEntry'
import { SidebarTasks } from './SidebarTasks'
import { SquadsEntry } from './Squads'
import { PluginPageEntries } from './PluginPageEntries'
import './sidebar-navigation.css'

export function openSidebarConversations(): void {
  setPreference('sidebarHidden', false)
  // Return without clearing the selected chat, draft or split panes.
  useCore.setState((s) => ({
    section: s.section === 'discussions' ? 'discussions' : 'conversations',
    settingsOpen: false, overviewOpen: false, inboxOpen: false, worktreesOpen: false, routinesOpen: false
  }))
}

export function useConversationsOpen(): boolean {
  return useCore((s) => (s.section === 'conversations' || s.section === 'discussions')
    && !s.settingsOpen && !s.overviewOpen && !s.inboxOpen && !s.worktreesOpen && !s.routinesOpen)
}

// Beside the icons the list belongs to the conversations entry: another page puts it away for as
// long as it shows, without touching the user's own choice to hide it.
export function useConversationListHidden(): boolean {
  const collapsed = usePreferences((s) => s.sidebarMenuCollapsed)
  const hidden = usePreferences((s) => s.sidebarHidden)
  const open = useConversationsOpen()
  return collapsed && (hidden || !open)
}

export function SidebarNavigation() {
  const open = useConversationsOpen()
  const hidden = useConversationListHidden()
  const listLabel = t(hidden ? 'Sidebar.showConversations' : 'Sidebar.hideConversations')
  return <nav id="sidebar-navigation" className="sidebar-navigation" aria-label={t('Sidebar.mainMenu')}>
    <div className="sidebar-navigation-items">
      <OverviewEntry />
      <InboxEntry />
      <RoutinesEntry />
      <PluginPageEntries />
      <SquadsEntry />
      <div className="sidebar-navigation-separator" role="separator" />
      <SidebarTasks />
      <button type="button" className="inbox-entry" aria-current={open} aria-label={t('sidebar.conversations')} data-tooltip={t('sidebar.conversations')} data-tooltip-side="right" onClick={openSidebarConversations}>
        <ChatIcon /><span className="sidebar-navigation-label">{t('sidebar.conversations')}</span>
      </button>
    </div>
    <div className="sidebar-navigation-footer">
      <button type="button" className="inbox-entry" aria-label={listLabel} aria-expanded={!hidden} aria-controls="sidebar-conversation-panel" data-tooltip={listLabel} data-tooltip-side="right" onClick={() => hidden ? openSidebarConversations() : setPreference('sidebarHidden', true)}>
        <ConversationListIcon shown={!hidden} /><span className="sidebar-navigation-label">{listLabel}</span>
      </button>
    </div>
  </nav>
}
