import { getLocale, t } from '../i18n'
import { accountsSupported, activeAccount, agentDescriptor, type AgentAccount, type AgentKind } from '@antumi/protocol'
import { setSettingsOpen, useCore } from '../core-store'
import { accountName, accountsOf } from '../agent-accounts'
import { ChatPicker, type PickerSize } from './ChatPicker'

// What a row says of an account besides its name: the edition its API key is for, else who signed in.
export function accountDetail(account: AgentAccount): string | null {
  if (!account.edition) return account.label ? account.email : null
  const edition = agentDescriptor(account.agent, getLocale()).accountKeys?.editions.find((each) => each.id === account.edition)?.label ?? account.edition
  return t('AgentAccounts.keyAccount', { value1: edition })
}

// Which of its agent's accounts a conversation runs on, kept for it; '' follows the agent's active
// account. Shown only where the agent has more than one signed in and core keeps the choice.
export function AccountPicker({ agent, value, onChange, disabled = false, title, placement, size }: {
  agent: AgentKind
  value: string | null
  onChange: (account: string | null) => void
  disabled?: boolean
  title?: string
  placement?: 'above' | 'below'
  size?: PickerSize
}) {
  const supported = useCore((s) => s.rpc?.features.includes('conversation-accounts') ?? false)
  const accounts = useCore((s) => s.accounts)
  if (!supported || !accounts || !accountsSupported(agent)) return null
  const own = accountsOf(accounts, agent).filter((account) => account.signedIn || account.id === value)
  if (own.length < 2) return null
  const active = own.find((account) => account.id === activeAccount(accounts, agent))
  const picked = own.some((account) => account.id === value) ? value : null
  return (
    <ChatPicker
      label={t('AccountPicker.label')}
      value={picked ?? ''}
      placeholder={t('AccountPicker.followActive')}
      disabled={disabled}
      title={title}
      placement={placement}
      size={size}
      options={[
        { value: '', label: t('AccountPicker.followActive'), description: active ? t('AccountPicker.followActiveDescription', { value1: accountName(active) }) : null },
        ...own.map((account) => ({ value: account.id, label: accountName(account), description: accountDetail(account) }))
      ]}
      onChange={(next) => onChange(next || null)}
      footer={(close) => (
        <button type="button" role="menuitem" className="menu-item" onClick={() => { close(); setSettingsOpen(true, 'accounts') }}>{t('AgentAccounts.manage')}</button>
      )}
    />
  )
}
