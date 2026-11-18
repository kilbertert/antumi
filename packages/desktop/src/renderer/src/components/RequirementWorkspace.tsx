import { useEffect, useRef, useState } from 'react'
import { solutionBlocker, type Requirement, type RequirementFields } from '@antumi/protocol'
import { openConversationDraft, perform, selectTask, useCore } from '../core-store'
import { useOccludesBrowser } from '../browser-occlusion'
import { askConfirm } from '../confirm-dialog'
import { keepRequirementDraft, requirementDraft } from '../requirement-drafts'
import { insertIntoComposer } from '../composer-insertions'
import { t } from '../i18n'
import { dayAndTime } from '../labels'
import { ChatPicker } from './ChatPicker'
import { ProjectPicker } from './ProjectPicker'
import { MarkdownEditor } from './MarkdownEditor'
import { SourceAttachments } from './SourceAttachments'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { CloseIcon } from './icons'
import './requirement-workspace.css'

const TEXT_FIELDS = ['owner', 'reviewer', 'project', 'release', 'goal', 'users', 'scope', 'nonGoals', 'acceptance', 'constraints', 'questions'] as const

export function RequirementWorkspace({ initialId, onClose }: { initialId: string | null; onClose: () => void }) {
  useOccludesBrowser()
  const rpc = useCore((state) => state.rpc)
  const globalError = useCore((state) => state.error)
  const dialog = useRef<HTMLDialogElement>(null)
  const [items, setItems] = useState<Requirement[]>([])
  const [selected, setSelected] = useState(initialId)
  const [requirement, setRequirement] = useState<Requirement | null>(null)
  const [loadKey, setLoadKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const dirty = useRef(false)
  const loading = useRef(0)
  const discard = async () => !dirty.current || await askConfirm({ message: t('Requirements.discard'), confirm: t('Requirements.discardAction') })
  const close = async () => {
    if (!await discard()) return
    if (selected) keepRequirementDraft(selected, null)
    onClose()
  }
  const load = async (id: string | null) => {
    if (requirement && !await discard()) return
    const generation = ++loading.current
    try {
      if (!rpc) throw new Error(t('coreStore.notConnectedToAntumiCore'))
      const list = await rpc.call('requirements.list', {})
      const current = id ? await rpc.call('requirements.get', { id }) : null
      if (generation !== loading.current) return
      if (requirement && selected) keepRequirementDraft(selected, null)
      dirty.current = false
      setItems(list); setSelected(id); setRequirement(current); setLoadKey((key) => key + 1); setError(null); setChangedElsewhere(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  useEffect(() => { void load(selected); return () => { loading.current += 1 } }, [rpc])
  useEffect(() => rpc?.on('requirements.changed', ({ requirement: next }) => {
    setItems((all) => [next, ...all.filter((each) => each.id !== next.id)])
    if (next.id === selected && next.version !== requirement?.version) setChangedElsewhere(true)
  }), [rpc, selected, requirement?.version])
  const saved = (next: Requirement) => {
    keepRequirementDraft(next.id, null)
    dirty.current = false
    setRequirement(next); setItems((all) => [next, ...all.filter((each) => each.id !== next.id)]); setChangedElsewhere(false)
  }
  return <dialog ref={dialog} className="modal requirement-workspace" aria-labelledby="requirement-title" onCancel={(event) => { event.preventDefault(); void close() }}>
    <header className="detail-header"><h2 id="requirement-title">{t('Requirements.title')}</h2><button type="button" className="tool-button" aria-label={t('BackdropPicker.close')} onClick={() => void close()}><CloseIcon /></button></header>
    <div className="requirement-body">
      <nav aria-label={t('Requirements.list')} className="requirement-list">
        {items.length === 0 && <p className="muted">{t('Requirements.empty')}</p>}
        {items.map((each) => <button type="button" className="button" aria-current={each.id === selected} key={each.id} onClick={() => void load(each.id)}>{each.title}</button>)}
      </nav>
      {(error || globalError) && <p role="alert">{error || globalError}</p>}
      {changedElsewhere && <p role="status">{t('Requirements.changedElsewhere')} <button type="button" className="button" onClick={() => void load(selected)}>{t('Requirements.reload')}</button></p>}
      {requirement && <RequirementEditor key={`${requirement.id}/${requirement.version}/${loadKey}`} requirement={requirement} onSave={saved} onDirty={(value) => { dirty.current = value }} onTask={() => onClose()} />}
    </div>
  </dialog>
}

function RequirementEditor({ requirement, onSave, onDirty, onTask }: { requirement: Requirement; onSave: (next: Requirement) => void; onDirty: (dirty: boolean) => void; onTask: () => void }) {
  const latest = requirement.revisions.at(-1)!
  const [revisionNumber, setRevisionNumber] = useState(latest.number)
  const revision = requirement.revisions.find((each) => each.number === revisionNumber)!
  const historical = revisionNumber !== latest.number
  const [draft] = useState(() => requirementDraft(requirement.id))
  const [fields, setFields] = useState<RequirementFields>(draft?.fields ?? latest.fields)
  const [fieldsDirty, setFieldsDirty] = useState(draft?.fieldsDirty ?? false)
  const [solutionId, setSolutionId] = useState<string | null>(draft ? draft.solutionId : requirement.solutions.filter((each) => each.revision === latest.number).at(-1)?.id ?? null)
  const solution = requirement.solutions.find((each) => each.id === solutionId)
  const [markdown, setMarkdown] = useState(draft?.markdown ?? solution?.markdown ?? '')
  const [solutionDirty, setSolutionDirty] = useState(draft?.solutionDirty ?? false)
  const [feedback, setFeedback] = useState(draft?.feedback ?? '')
  const [confirmer, setConfirmer] = useState(draft?.confirmer ?? '')
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const pending = useRef(false)
  const editable = !historical && (!solution || (solution.revision === latest.number && ['draft', 'changes'].includes(solution.status)))
  useEffect(() => {
    const dirty = fieldsDirty || solutionDirty || Boolean(feedback || confirmer)
    onDirty(dirty)
    if (dirty) keepRequirementDraft(requirement.id, { version: draft?.version ?? requirement.version, fields, fieldsDirty,
      solutionDirty, solutionId, markdown, feedback, confirmer })
  }, [fields, fieldsDirty, solutionDirty, solutionId, markdown, feedback, confirmer])
  const act = async (action: () => Promise<Requirement | null>) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { const next = await action(); if (next) onSave(next) } finally { pending.current = false; setBusy(false) }
  }
  const ref = { id: requirement.id, version: draft?.version ?? requirement.version }
  const showRevision = (number: number) => { setViewing(null); setRevisionNumber(number); setFields(requirement.revisions.find((each) => each.number === number)!.fields); const choice = requirement.solutions.filter((each) => each.revision === number).at(-1); setSolutionId(choice?.id ?? null); setMarkdown(choice?.markdown ?? '') }
  const chooseSolution = (id: string) => { setSolutionId(id === 'new' ? null : id); setMarkdown(requirement.solutions.find((each) => each.id === id)?.markdown ?? '') }
  const analyze = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const context = await perform((rpc) => rpc.call('requirements.context', ref))
    if (!context) { pending.current = false; setBusy(false); return }
    onTask()
    openConversationDraft(context.projectPaths, null, null, true)
    insertIntoComposer(null, { text: context.text, images: context.images })
  }
  const handoff = async () => {
    if (!solution || pending.current) return
    pending.current = true; setBusy(true)
    try {
      const task = await perform((rpc) => rpc.call('requirements.handoff', { ...ref, solutionId: solution.id }))
      if (task) { onTask(); selectTask(task.id) }
    } finally { pending.current = false; setBusy(false) }
  }
  return <article className="requirement-editor" inert={busy || undefined}>
    <h3>{requirement.title}</h3>
    {draft && draft.version !== requirement.version && <p role="alert">{t('Requirements.restoredStale')}</p>}
    <a href={revision.source.url} target="_blank" rel="noreferrer">{revision.source.name} · {revision.source.key}</a>
    <ChatPicker label={t('Requirements.revision')} placeholder="" value={String(revisionNumber)} placement="below" disabled={busy || fieldsDirty || solutionDirty || Boolean(feedback || confirmer)}
      options={requirement.revisions.map((each) => ({ value: String(each.number), label: `${t('Requirements.revision')} ${each.number} · ${dayAndTime(each.createdAt)}` }))} onChange={(value) => showRevision(Number(value))} />
    <details><summary>{t('Requirements.original')}</summary><MarkdownEditor key={revision.number} value={revision.snapshot.markdown} label={t('Requirements.original')} hint="" readOnly />
      <SourceAttachments source={revision.source} attachments={revision.snapshot.attachments} binding={requirement.binding} />
      <ImageStrip images={revision.snapshot.images} onOpen={setViewing} />
    </details>
    {viewing !== null && revision.snapshot.images.length > 0 && <ImageViewer images={revision.snapshot.images} index={Math.min(viewing, revision.snapshot.images.length - 1)} onIndex={setViewing} onClose={() => setViewing(null)} />}
    <fieldset disabled={historical || busy || solutionDirty || Boolean(feedback || confirmer)}>
      {TEXT_FIELDS.map((field) => <label key={field}>{t(`Requirements.${field}`)}<textarea className="input" aria-label={t(`Requirements.${field}`)} value={fields[field]} maxLength={10_000} rows={['goal', 'scope', 'acceptance'].includes(field) ? 3 : 1} onChange={(event) => { setFields({ ...fields, [field]: event.target.value }); setFieldsDirty(true); onDirty(true) }} /></label>)}
      <label>{t('Requirements.repos')}<ProjectPicker projects={fields.repos.map((path) => ({ path, worktreePath: null }))} onChange={(repos) => { setFields({ ...fields, repos }); setFieldsDirty(true); onDirty(true) }} /></label>
    </fieldset>
    {!historical && <div className="toolbar">
      <button type="button" className="button" disabled={busy || solutionDirty || Boolean(feedback || confirmer)} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.revise', { ...ref, fields })))}>{t('Requirements.saveRevision')}</button>
      <button type="button" className="button" disabled={busy || fieldsDirty || solutionDirty || Boolean(feedback || confirmer)} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.revise', { ...ref, fields, refreshSource: true })))}>{t('Requirements.refreshSource')}</button>
      <button type="button" className="button" disabled={busy || fieldsDirty || solutionDirty || Boolean(feedback || confirmer)} onClick={() => void analyze()}>{t('Requirements.analyze')}</button>
    </div>}
    <h3>{t('Requirements.solution')}</h3>
    <ChatPicker label={t('Requirements.solution')} placeholder={t('Requirements.newSolution')} value={solutionId ?? 'new'} placement="below" disabled={busy || fieldsDirty || solutionDirty || Boolean(feedback || confirmer)}
      options={[{ value: 'new', label: t('Requirements.newSolution') }, ...requirement.solutions.map((each) => ({ value: each.id, label: `${t('Requirements.revision')} ${each.revision} · ${t(`Requirements.${each.status}`)} · ${dayAndTime(each.updatedAt)}` }))]} onChange={chooseSolution} />
    {solution && solution.revision !== latest.number && <p role="status">{t('Requirements.stale')}</p>}
    <MarkdownEditor key={`${solutionId ?? 'new'}/${editable}/${fieldsDirty}/${Boolean(feedback || confirmer)}`} value={markdown} label={t('Requirements.solution')} hint={t('Requirements.solutionHint')} readOnly={!editable || fieldsDirty || Boolean(feedback || confirmer)} onChange={(value) => { setMarkdown(value); setSolutionDirty(true); onDirty(true) }} />
    {editable && <button type="button" className="button" disabled={busy || fieldsDirty || Boolean(feedback || confirmer)} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.solution', { ...ref, ...(solutionId ? { solutionId } : {}), markdown })))}>{t('Requirements.saveSolution')}</button>}
    {solution?.reviews.map((review, index) => <p key={index}>{t(`Requirements.${review.decision}`)} · {review.confirmer} · {dayAndTime(review.createdAt)}<br />{review.feedback}</p>)}
    {solution && !historical && <div className="requirement-review">
      {solution.status === 'review' && solution.revision === latest.number && <>
        <p className="muted">{t('Requirements.confirmationHint')}</p><label>{t('Requirements.confirmer')}<input className="input" aria-label={t('Requirements.confirmer')} value={confirmer} maxLength={10_000} onChange={(event) => { setConfirmer(event.target.value); onDirty(true) }} /></label>
        <label>{t('Requirements.feedback')}<textarea className="input" aria-label={t('Requirements.feedback')} value={feedback} maxLength={10_000} onChange={(event) => { setFeedback(event.target.value); onDirty(true) }} /></label>
      </>}
      <div className="toolbar">
        {editable && <button type="button" className="button primary" disabled={busy || fieldsDirty || solutionDirty || Boolean(solutionBlocker(requirement, solution, 'submit'))} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.review', { ...ref, solutionId: solution.id, action: 'submit' })))}>{t('Requirements.submit')}</button>}
        {editable && solutionBlocker(requirement, solution, 'submit') && <p className="muted">{t('Requirements.incomplete')}</p>}
        {solution.status === 'review' && solution.revision === latest.number && <>
          <button type="button" className="button" disabled={busy || fieldsDirty || solutionDirty || !feedback.trim() || confirmer.trim() !== latest.fields.owner} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.review', { ...ref, solutionId: solution.id, action: 'changes', confirmer, feedback })))}>{t('Requirements.return')}</button>
          <button type="button" className="button primary" disabled={busy || fieldsDirty || solutionDirty || confirmer.trim() !== latest.fields.owner || Boolean(solutionBlocker(requirement, solution, 'accept'))} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.review', { ...ref, solutionId: solution.id, action: 'accepted', confirmer, feedback })))}>{t('Requirements.accept')}</button>
        </>}
        {solution.status === 'accepted' && <button type="button" className="button primary" disabled={busy || fieldsDirty || solutionDirty || Boolean(solutionBlocker(requirement, solution, 'handoff'))} onClick={() => void handoff()}>{t('Requirements.handoff')}</button>}
      </div>
    </div>}
  </article>
}
