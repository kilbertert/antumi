import { dismissBackendLocationNotice, distroNotStarted, useBackendLocation } from '../backend-location-state'
import { setSettingsOpen } from '../core-store'
import { t } from '../i18n'
import { CloseIcon, WarningIcon } from './icons'

// Over the lists, beside EnvironmentNotice: the user chose a distro and is shown this machine's
// tasks instead, which reads as lost work unless said. Once per start, until dismissed.
export function BackendLocationNotice() {
  const distro = useBackendLocation((s) => distroNotStarted(s.state))
  const dismissed = useBackendLocation((s) => s.dismissed)
  if (distro === null || dismissed) return null
  return (
    <div className="backend-location-notice" role="status">
      <button type="button" className="backend-location-notice-open" onClick={() => setSettingsOpen(true, 'backend-location')}>
        <WarningIcon />
        <span>{t('BackendLocation.notice', { distro })}</span>
        <span className="environment-notice-action">{t('EnvironmentNotice.view')}</span>
      </button>
      <button type="button" className="backend-location-notice-dismiss" aria-label={t('BackendLocation.dismiss')} title={t('BackendLocation.dismiss')} onClick={dismissBackendLocationNotice}>
        <CloseIcon />
      </button>
    </div>
  )
}
