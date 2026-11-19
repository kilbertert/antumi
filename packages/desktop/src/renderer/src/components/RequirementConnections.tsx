import { useCore } from '../core-store'
import { t } from '../i18n'

export function RequirementConnections({ onSettings }: { onSettings: (section: string) => void }) {
  const rpc = useCore((state) => state.rpc)
  const features = rpc?.features ?? []
  const sources = useCore((state) => state.sources)
  const providers = useCore((state) => state.modelProviders)
  const servers = useCore((state) => state.mcpServers)
  const source = sources?.find((each) => each.provider === 'zentao')
  const instances = source?.instances ?? []
  return <details className="requirement-connections">
    <summary>{t('Requirements.connections')}</summary>
    <p className="muted">{t('Requirements.connectionsHint')}</p>
    <div className="requirement-iteration-row"><span>{t('Requirements.sourceConnection')} · {sources === null ? t('Requirements.connectionsLoading')
      : !source ? t('Requirements.sourceNotInstalled') : instances.some((each) => each.enabled && each.credential.configured) ? t('Requirements.sourceConfigured') : t('Requirements.sourceNotConfigured')}</span>
      {(source || features.includes('plugins')) && <button type="button" className="button ghost" onClick={() => onSettings(source ? 'source-zentao' : 'plugins')}>{t('Requirements.configureSource')}</button>}
    </div>
    {features.includes('model-providers') && <div className="requirement-iteration-row"><span>{t('Requirements.modelConnections', { count: providers.filter((each) => each.hasKey).length })}</span>
      <button type="button" className="button ghost" onClick={() => onSettings('model-providers')}>{t('Requirements.configureModels')}</button>
    </div>}
    {features.includes('mcp-servers') && <div className="requirement-iteration-row"><span>{t('Requirements.mcpConnections', { count: servers.filter((each) => each.enabled && each.agents.length > 0).length })}</span>
      <button type="button" className="button ghost" onClick={() => onSettings('mcp')}>{t('Requirements.configureMcp')}</button>
    </div>}
    <p className="muted">{t('Requirements.mcpConnectionsHint')}</p>
  </details>
}
