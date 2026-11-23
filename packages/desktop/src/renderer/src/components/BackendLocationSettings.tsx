import { useState, type ReactElement, type ReactNode } from 'react'
import type { BackendLocation, BackendLocationState, BackendProblem } from '../../../shared/backend-location'
import { readBackendLocation, sameLocation, useBackendLocation } from '../backend-location-state'
import { askConfirm } from '../confirm-dialog'
import { setBackendLocation } from '../desktop-bridge'
import { t, tr } from '../i18n'
import { ChatPicker, type PickerOption } from './ChatPicker'
import { CopyButton } from './CopyButton'
import { WarningIcon } from './icons'
import { SettingsRow } from './SettingsControls'

// 设置 → 后端位置, where the backend runs (docs/WSL.md, docs/REMOTE-CORE.md): this machine, a WSL
// distro on a Windows build that carries one, or a remote host over ssh — and what to do when the
// chosen place would not take it.

const LOCAL = 'local'
const REMOTE = 'remote'
const WSL_PREFIX = 'wsl:'

function valueOf(location: BackendLocation): string {
  if (location.kind === 'wsl') return `${WSL_PREFIX}${location.distro}`
  return location.kind
}

function locationOf(value: string): BackendLocation {
  if (value === REMOTE) return { kind: 'remote' }
  return value.startsWith(WSL_PREFIX) ? { kind: 'wsl', distro: value.slice(WSL_PREFIX.length) } : { kind: 'local' }
}

function locationLabel(location: BackendLocation, remoteHost: string | null): string {
  if (location.kind === 'remote') return remoteHost ? t('BackendLocation.remote', { host: remoteHost }) : t('BackendLocation.remoteUnconfigured')
  return location.kind === 'local' ? t('BackendLocation.local') : t('BackendLocation.wsl', { distro: location.distro })
}

export function backendLocationOptions(state: BackendLocationState): PickerOption[] {
  const distros = state.distros ?? []
  const chosen = state.chosen.kind === 'wsl' ? state.chosen.distro : null
  return [
    { value: LOCAL, label: t('BackendLocation.local'), description: t('BackendLocation.localDescription') },
    ...distros.map((distro) => ({
      value: `${WSL_PREFIX}${distro.name}`,
      label: t('BackendLocation.wsl', { distro: distro.name }),
      description: [distro.isDefault ? t('BackendLocation.distroDefault') : null, distro.version === 1 ? t('BackendLocation.distroWsl1') : 'WSL 2'].filter(Boolean).join(' · '),
      disabled: distro.version === 1
    })),
    // The chosen one stays shown when wsl.exe no longer lists it, or would not say.
    ...(chosen !== null && !distros.some((distro) => distro.name === chosen)
      ? [{ value: `${WSL_PREFIX}${chosen}`, label: t('BackendLocation.wsl', { distro: chosen }), description: state.distros ? t('BackendLocation.distroMissing') : null, disabled: true }]
      : []),
    // Remote is a choice once remote.json says where: its ssh host names it, a broken file is said
    // rather than offered.
    ...(state.remote !== null
      ? [{
          value: REMOTE,
          label: state.remote.host ? t('BackendLocation.remote', { host: state.remote.host }) : t('BackendLocation.remoteUnconfigured'),
          description: state.remote.error ?? t('BackendLocation.remoteDescription'),
          disabled: state.remote.error !== null && state.chosen.kind !== 'remote'
        }]
      : [])
  ]
}

function Command({ command }: { command: string }) {
  return (
    <span className="backend-location-command">
      <code>{command}</code>
      <CopyButton text={command} label={t('InstalledAgentsSettings.copyCommand')} />
    </span>
  )
}

function Detail({ text }: { text: string }) {
  return text.trim() ? <pre className="backend-location-detail">{text.trim()}</pre> : null
}

function NodeFix() {
  return (
    <>
      <p>{t('BackendLocation.problemNodeFix')}</p>
      <p>{t('BackendLocation.problemNodeNvm')}</p>
      <Command command="nvm install 24 && nvm alias default 24" />
      <p>{t('BackendLocation.problemNodeApt')}</p>
      <Command command="curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -" />
      <Command command="sudo apt-get install -y nodejs" />
    </>
  )
}

// What went wrong, as a title, and what to do about it. `distro` is the chosen one, which most
// problems are about without naming it.
export function problemContent(problem: BackendProblem, distro: string): { title: string; body: ReactNode; retry: boolean } {
  switch (problem.kind) {
    case 'remote-config':
      return { title: t('BackendLocation.problemRemoteConfig'), body: <p>{t('BackendLocation.problemRemoteConfigFix')} <code>remote.json</code></p>, retry: true }
    case 'remote-link':
      return { title: t('BackendLocation.problemRemoteLink'), body: <><p>{t('BackendLocation.problemRemoteLinkFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'wsl-unavailable':
      return { title: t('BackendLocation.problemWslUnavailable'), body: <><p>{t('BackendLocation.problemWslUnavailableFix')}</p><Command command="wsl --install" /></>, retry: true }
    case 'wsl-unknown':
      return { title: t('BackendLocation.problemWslUnknown', { distro }), body: <><p>{t('BackendLocation.problemWslUnknownFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'distro-missing':
      return { title: t('BackendLocation.problemDistroMissing', { distro: problem.distro }), body: <p>{t('BackendLocation.problemDistroMissingFix')}</p>, retry: false }
    case 'distro-wsl1':
      return { title: t('BackendLocation.problemWsl1', { distro: problem.distro }), body: <><p>{t('BackendLocation.problemWsl1Fix')}</p><Command command={`wsl --set-version ${problem.distro} 2`} /></>, retry: true }
    case 'arch':
      return { title: t('BackendLocation.problemArch', { distro, arch: problem.arch }), body: null, retry: false }
    case 'login-environment':
      return { title: t('BackendLocation.problemLogin', { distro }), body: <><p>{t('BackendLocation.problemLoginFix')}</p><Command command={`wsl -d ${distro}`} /></>, retry: true }
    case 'node-missing':
      return { title: t('BackendLocation.problemNodeMissing', { distro }), body: <NodeFix />, retry: true }
    case 'node-old':
      return { title: t('BackendLocation.problemNodeOld', { distro, version: problem.version }), body: <><p>{tr('BackendLocation.problemNodeFound', { path: <code>{problem.path}</code> })}</p><NodeFix /></>, retry: true }
    case 'install':
      return { title: t('BackendLocation.problemInstall', { distro }), body: <Detail text={problem.detail} />, retry: true }
    case 'pty':
      return { title: t('BackendLocation.problemPty', { distro }), body: <><p>{t('BackendLocation.problemPtyFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'start':
      return { title: t('BackendLocation.problemStart', { distro }), body: <><p>{tr('BackendLocation.problemStartFix', { log: <code>~/.antumi/logs/core.log</code> })}</p><Detail text={problem.detail} /></>, retry: true }
  }
}

// The other place has its own tasks, conversations and settings, and the app restarts at once:
// neither is something to find out after the fact.
export function confirmSwitch(location: BackendLocation): Promise<boolean> {
  const question = location.kind === 'local' ? t('BackendLocation.confirmLocal') : location.kind === 'remote' ? t('BackendLocation.confirmRemote') : t('BackendLocation.confirmWsl', { distro: location.distro })
  return askConfirm({ message: `${question} ${t('BackendLocation.confirmBody')}`, confirm: t('BackendLocation.confirmAction') })
}

// Empty where there is no choice to make: no WSL support, and no remote.json either.
export function BackendLocationSettings(): ReactElement {
  const state = useBackendLocation((s) => s.state)
  return state !== null && (state.supported || state.remote !== null) ? <BackendLocationRows state={state} /> : <></>
}

function BackendLocationRows({ state }: { state: BackendLocationState }) {
  const reading = useBackendLocation((s) => s.reading)
  const [switching, setSwitching] = useState(false)
  const [failed, setFailed] = useState(false)

  const apply = async (location: BackendLocation) => {
    setSwitching(true)
    setFailed(false)
    // Main restarts the app once it has saved the choice; only a refusal comes back.
    if (await setBackendLocation(location)) return
    setSwitching(false)
    setFailed(true)
  }
  const choose = async (value: string) => {
    const location = locationOf(value)
    if (switching || sameLocation(location, state.chosen) || !await confirmSwitch(location)) return
    await apply(location)
  }

  const chosenDistro = state.chosen.kind === 'wsl' ? state.chosen.distro : null
  const fellBack = chosenDistro !== null && state.running === 'local'
  // A remote that did not come up serves nothing at all: it shows as down, never as this machine's.
  const remoteDown = state.chosen.kind === 'remote' && state.problem !== null
  const problem = state.problem && (chosenDistro !== null || state.chosen.kind === 'remote') ? problemContent(state.problem, chosenDistro ?? '') : null
  const recheck = (
    <button type="button" className="button" disabled={reading} onClick={() => void readBackendLocation()}>
      {reading ? t('BackendLocation.rechecking') : t('BackendLocation.recheck')}
    </button>
  )
  return (
    <>
      <SettingsRow
        label={t('BackendLocation.choose')}
        description={t('BackendLocation.chooseDescription')}
        control={() => (
          <ChatPicker
            label={t('BackendLocation.choose')}
            value={valueOf(state.chosen)}
            placeholder={locationLabel(state.chosen, state.remote?.host ?? null)}
            options={backendLocationOptions(state)}
            disabled={switching}
            size="large"
            placement="below"
            align="end"
            onChange={(value) => void choose(value)}
          />
        )}
      />
      {state.distros === null && <div className="backend-location-block"><p>{t('BackendLocation.unlisted')}</p><div>{recheck}</div></div>}
      {state.distros?.length === 0 && (
        <div className="backend-location-block">
          <p>{t('BackendLocation.noDistros')}</p>
          <Command command="wsl --install" />
          <div>{recheck}</div>
        </div>
      )}
      <SettingsRow
        label={t('BackendLocation.running')}
        description={fellBack ? t('BackendLocation.fellBack', { distro: chosenDistro }) : remoteDown ? t('BackendLocation.remoteDown') : undefined}
        control={() => (
          <span className="backend-location-running" data-fell-back={fellBack || remoteDown || undefined}>
            {(fellBack || remoteDown) && <WarningIcon />}
            {state.running === 'local' ? t('BackendLocation.local') : locationLabel(state.chosen, state.remote?.host ?? null)}
          </span>
        )}
      />
      {problem && (
        <div className="backend-location-block backend-location-problem" role="alert">
          <p className="backend-location-problem-title"><WarningIcon />{problem.title}</p>
          {problem.body}
          {problem.retry && (
            <div>
              <button type="button" className="button" disabled={switching} onClick={() => void apply(state.chosen)}>{t('BackendLocation.restart')}</button>
            </div>
          )}
        </div>
      )}
      {(switching || failed) && (
        <p className="backend-location-block" role="status" data-failed={failed || undefined}>
          {failed ? t('BackendLocation.switchFailed') : t('BackendLocation.restarting')}
        </p>
      )}
      <p className="backend-location-block">{state.chosen.kind === 'remote' ? t('BackendLocation.notYetRemote') : t('BackendLocation.notYet')}</p>
    </>
  )
}
