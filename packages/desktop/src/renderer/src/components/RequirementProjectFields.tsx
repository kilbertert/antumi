import { useEffect, useRef, useState } from 'react'
import type { RequirementCatalog, RequirementFields, RequirementIteration } from '@antumi/protocol'
import { perform, useCore } from '../core-store'
import { askConfirm } from '../confirm-dialog'
import { t } from '../i18n'
import { ChatPicker } from './ChatPicker'

type Selection = Pick<RequirementFields, 'project' | 'release' | 'businessProjectId' | 'iterationId'>

export function RequirementProjectFields({ fields, disabled, onChange }: {
  fields: Selection; disabled: boolean; onChange: (selection: Selection) => void
}) {
  const rpc = useCore((state) => state.rpc)
  const [catalog, setCatalog] = useState<RequirementCatalog>({ projects: [], iterations: [] })
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [iterationName, setIterationName] = useState('')
  const pending = useRef(false)
  const locked = disabled || busy
  const project = catalog.projects.find((each) => each.id === fields.businessProjectId)
  const iterations = catalog.iterations.filter((each) => each.projectId === fields.businessProjectId)
  const iteration = iterations.find((each) => each.id === fields.iterationId)
  useEffect(() => {
    let current = true
    if (rpc) void rpc.call('requirements.projects', {}).then((next) => {
      if (current) { setCatalog(next); setError(false) }
    }, () => { if (current) setError(true) })
    return () => { current = false }
  }, [rpc])
  const mutate = async (action: () => Promise<unknown>) => {
    if (locked || pending.current) return
    pending.current = true; setBusy(true)
    try {
      if (!await action()) return
      const next = await perform((client) => client.call('requirements.projects', {}))
      if (next) { setCatalog(next); setError(false) } else setError(true)
    } finally { pending.current = false; setBusy(false) }
  }
  const changeStatus = (item: RequirementIteration, status: 'active' | 'closed') => mutate(async () => {
    if (status === 'closed' && !await askConfirm({ message: t('Requirements.confirmCloseIteration', { name: item.name }), confirm: t('Requirements.closeIteration'), danger: true })) return null
    return perform((client) => client.call('requirements.saveIteration', { id: item.id, projectId: item.projectId, name: item.name, status }))
  })
  const projectOptions = catalog.projects.filter((each) => !each.archived || each.id === fields.businessProjectId).map((each) => ({
    value: each.id, label: each.id === fields.businessProjectId ? fields.project : each.name, disabled: each.archived,
    description: each.archived ? t('Requirements.archived') : null
  }))
  if (fields.businessProjectId && !project) projectOptions.push({ value: fields.businessProjectId, label: fields.project, disabled: true, description: t('Requirements.historicalLabel') })
  if (!fields.businessProjectId && fields.project) projectOptions.push({ value: 'legacy', label: fields.project, disabled: true, description: t('Requirements.historicalLabel') })
  const iterationOptions = iterations.filter((each) => each.status !== 'closed' || each.id === fields.iterationId).map((each) => ({
    value: each.id, label: each.id === fields.iterationId ? fields.release : each.name, disabled: each.status === 'closed', description: t(`Requirements.iteration.${each.status}`)
  }))
  if (fields.iterationId && !iteration) iterationOptions.push({ value: fields.iterationId, label: fields.release, disabled: true, description: t('Requirements.historicalLabel') })
  if (!fields.iterationId && fields.release) iterationOptions.push({ value: 'legacy', label: fields.release, disabled: true, description: t('Requirements.historicalLabel') })
  return <>
    <label><span>{t('Requirements.project')}</span><ChatPicker label={t('Requirements.project')} placeholder={t('Requirements.chooseBusinessProject')}
      value={fields.businessProjectId ?? (fields.project ? 'legacy' : null)} options={projectOptions} disabled={locked} placement="below" size="field"
      onChange={(id) => { const selected = catalog.projects.find((each) => each.id === id); if (selected) onChange({ businessProjectId: selected.id, iterationId: null, project: selected.name, release: '' }) }} /></label>
    <label><span>{t('Requirements.release')}</span><ChatPicker label={t('Requirements.release')} placeholder={t('Requirements.chooseIteration')}
      value={fields.iterationId ?? (fields.release ? 'legacy' : null)} options={iterationOptions} disabled={locked || !fields.businessProjectId || project?.archived} placement="below" size="field"
      onChange={(id) => { const selected = iterations.find((each) => each.id === id); if (selected) onChange({ ...fields, iterationId: selected.id, release: selected.name }) }} /></label>
    {error && <p role="alert">{t('Requirements.projectCatalogLoadFailed')} <button type="button" className="button" disabled={locked}
      onClick={() => void mutate(() => perform((client) => client.call('requirements.projects', {})))}>{t('Requirements.reload')}</button></p>}
    {!disabled && (iteration?.status === 'closed' || project?.archived) && <p role="status">{t('Requirements.iterationClosed')}</p>}
    {!disabled && <details className="requirement-catalog"><summary>{t('Requirements.projectIterations')}</summary>
      <div className="requirement-catalog-body">
        <label>{t('Requirements.newBusinessProject')}<div className="requirement-evidence-search"><input className="input" aria-label={t('Requirements.newBusinessProject')} maxLength={200}
          value={projectName} disabled={locked} onChange={(event) => setProjectName(event.target.value)} />
          <button type="button" className="button" disabled={locked || !projectName.trim()} onClick={() => void mutate(() => perform((client) => client.call('requirements.saveProject', { name: projectName })).then((created) => {
            if (created) { onChange({ businessProjectId: created.id, iterationId: null, project: created.name, release: '' }); setProjectName('') } return created
          }))}>{t('Requirements.addBusinessProject')}</button></div></label>
        {project && !project.archived && <label>{t('Requirements.newIteration')}<div className="requirement-evidence-search"><input className="input" aria-label={t('Requirements.newIteration')} maxLength={200}
          value={iterationName} disabled={locked} onChange={(event) => setIterationName(event.target.value)} />
          <button type="button" className="button" disabled={locked || !iterationName.trim()} onClick={() => void mutate(() => perform((client) => client.call('requirements.saveIteration', { projectId: project.id, name: iterationName, status: 'planned' })).then((created) => {
            if (created) { onChange({ ...fields, iterationId: created.id, release: created.name }); setIterationName('') } return created
          }))}>{t('Requirements.addIteration')}</button></div></label>}
        {iterations.map((item) => <div className="requirement-iteration-row" key={item.id}><span>{item.name} · {t(`Requirements.iteration.${item.status}`)}</span><div className="toolbar">
          {item.status === 'planned' && <button type="button" className="button ghost" disabled={locked || project?.archived} onClick={() => void changeStatus(item, 'active')}>{t('Requirements.activateIteration')}</button>}
          {item.status !== 'closed' && <button type="button" className="button ghost" disabled={locked} onClick={() => void changeStatus(item, 'closed')}>{t('Requirements.closeIteration')}</button>}
        </div></div>)}
        {project && !project.archived && <button type="button" className="button ghost" disabled={locked || iterations.some((each) => each.status !== 'closed')}
          onClick={() => void mutate(() => perform((client) => client.call('requirements.archiveProject', { id: project.id, archived: true })))}>{t('Requirements.archiveBusinessProject')}</button>}
        {catalog.projects.filter((each) => each.archived).map((each) => <div className="requirement-iteration-row" key={each.id}><span>{each.name} · {t('Requirements.archived')}</span>
          <button type="button" className="button ghost" disabled={locked} onClick={() => void mutate(() => perform((client) => client.call('requirements.archiveProject', { id: each.id, archived: false })))}>{t('Requirements.restoreBusinessProject')}</button></div>)}
      </div>
    </details>}
  </>
}
