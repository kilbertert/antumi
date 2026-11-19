import { useEffect, useRef, useState } from 'react'
import { solutionBlocker, type Requirement, type RequirementFields, type RequirementEvidence, type RequirementEvidenceFile, type ProjectFileMatch } from '@antumi/protocol'
import { openConversationDraft, perform, selectTask, useCore } from '../core-store'
import { useOccludesBrowser } from '../browser-occlusion'
import { askConfirm } from '../confirm-dialog'
import { keepRequirementDraft, requirementDraft } from '../requirement-drafts'
import { composerDraft, saveComposerDraft } from '../composer-drafts'
import { t } from '../i18n'
import { dayAndTime } from '../labels'
import { ChatPicker } from './ChatPicker'
import { ProjectPicker } from './ProjectPicker'
import { MarkdownEditor } from './MarkdownEditor'
import { RequirementPrototype } from './RequirementPrototype'
import { RequirementProjectFields } from './RequirementProjectFields'
import { SourceAttachments } from './SourceAttachments'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { CloseIcon } from './icons'
import { SearchIcon } from './icons'
import './requirement-workspace.css'

const TEXT_FIELDS = ['owner', 'reviewer', 'goal', 'users', 'scope', 'nonGoals', 'acceptance', 'constraints', 'questions'] as const

export function RequirementWorkspace({ initialId, onClose }: { initialId: string | null; onClose: () => void }) {
  useOccludesBrowser()
  const rpc = useCore((state) => state.rpc)
  const evidenceSupported = useCore((state) => state.rpc?.features.includes('requirement-evidence') ?? false)
  const knowledgeEvidenceSupported = useCore((state) => (state.rpc?.features.includes('requirement-knowledge-evidence') ?? false) && Boolean(state.chatSettings?.knowledgeBase?.path))
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
      {requirement && <RequirementEditor key={`${requirement.id}/${requirement.version}/${loadKey}`} requirement={requirement} evidenceSupported={evidenceSupported} knowledgeEvidenceSupported={knowledgeEvidenceSupported} onSave={saved} onDirty={(value) => { dirty.current = value }} onTask={() => onClose()} />}
    </div>
  </dialog>
}

function RequirementEditor({ requirement, evidenceSupported, knowledgeEvidenceSupported, onSave, onDirty, onTask }: { requirement: Requirement; evidenceSupported: boolean; knowledgeEvidenceSupported: boolean; onSave: (next: Requirement) => void; onDirty: (dirty: boolean) => void; onTask: () => void }) {
  const prototypeSupported = useCore((state) => state.rpc?.features.includes('requirement-prototypes') ?? false)
  const projectIterationsSupported = useCore((state) => state.rpc?.features.includes('requirement-project-iterations') ?? false)
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
  const [prototypeHtml, setPrototypeHtml] = useState(draft?.prototypeHtml ?? solution?.prototypeHtml ?? '')
  const [solutionDirty, setSolutionDirty] = useState(draft?.solutionDirty ?? false)
  const [feedback, setFeedback] = useState(draft?.feedback ?? '')
  const [confirmer, setConfirmer] = useState(draft?.confirmer ?? '')
  const [evidence, setEvidence] = useState<RequirementEvidence[]>(solutionDirty ? draft?.evidence ?? [] : solution?.evidence ?? [])
  const [knowledgeEvidence, setKnowledgeEvidence] = useState(solutionDirty ? draft?.knowledgeEvidence ?? [] : solution?.knowledgeEvidence ?? [])
  const [query, setQuery] = useState(draft?.query ?? '')
  const [knowledgeQuery, setKnowledgeQuery] = useState(draft?.knowledgeQuery ?? '')
  const [matches, setMatches] = useState<ProjectFileMatch[]>([])
  const [knowledgeMatches, setKnowledgeMatches] = useState<ProjectFileMatch[]>([])
  const [knowledgeSearchTruncated, setKnowledgeSearchTruncated] = useState(false)
  const [file, setFile] = useState<RequirementEvidenceFile | null>(null)
  const [excerpt, setExcerpt] = useState(draft?.excerpt ?? '')
  const [knowledgeFile, setKnowledgeFile] = useState<RequirementEvidenceFile | null>(null)
  const [knowledgeExcerpt, setKnowledgeExcerpt] = useState(draft?.knowledgeExcerpt ?? '')
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const pending = useRef(false)
  const editable = !historical && (!solution || (solution.revision === latest.number && ['draft', 'changes'].includes(solution.status)))
  useEffect(() => {
    if (!draft?.file || !editable || !evidenceSupported) return
    setPreviewPath(draft.file)
    void perform((rpc) => rpc.call('requirements.readEvidence', { ...ref, path: draft.file! })).then((found) => {
      if (found) { setFile(found); setPreviewPath(found.path) }
    })
  }, [draft?.file, editable, evidenceSupported])
  useEffect(() => {
    if (!draft?.knowledgeFile || !editable || !knowledgeEvidenceSupported) return
    void perform((rpc) => rpc.call('requirements.readKnowledge', { ...ref, path: draft.knowledgeFile! })).then((found) => {
      if (found) setKnowledgeFile(found)
    })
  }, [draft?.knowledgeFile, editable, knowledgeEvidenceSupported])
  useEffect(() => {
    const dirty = fieldsDirty || solutionDirty || Boolean(feedback || confirmer || file || excerpt || knowledgeFile || knowledgeExcerpt)
    onDirty(dirty)
    if (dirty || file || excerpt || evidence.length || knowledgeEvidence.length) keepRequirementDraft(requirement.id, { version: draft?.version ?? requirement.version, fields, fieldsDirty,
      solutionDirty, solutionId, markdown, prototypeHtml, feedback, confirmer, evidence, knowledgeEvidence, query, knowledgeQuery, file: file?.path ?? null, excerpt,
      knowledgeFile: knowledgeFile?.path ?? null, knowledgeExcerpt })
  }, [fields, fieldsDirty, solutionDirty, solutionId, markdown, prototypeHtml, feedback, confirmer, evidence, knowledgeEvidence, query, knowledgeQuery, file, excerpt, knowledgeFile, knowledgeExcerpt])
  const act = async (action: () => Promise<Requirement | null>) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { const next = await action(); if (next) onSave(next) } finally { pending.current = false; setBusy(false) }
  }
  const ref = { id: requirement.id, version: draft?.version ?? requirement.version }
  const showRevision = (number: number) => { setViewing(null); setRevisionNumber(number); setFields(requirement.revisions.find((each) => each.number === number)!.fields); const choice = requirement.solutions.filter((each) => each.revision === number).at(-1); setSolutionId(choice?.id ?? null); setMarkdown(choice?.markdown ?? ''); setPrototypeHtml(choice?.prototypeHtml ?? ''); setEvidence(choice?.evidence ?? []); setKnowledgeEvidence(choice?.knowledgeEvidence ?? []); setSolutionDirty(false) }
  const chooseSolution = (id: string) => { const choice = requirement.solutions.find((each) => each.id === id); setSolutionId(choice?.id ?? null); setMarkdown(choice?.markdown ?? ''); setPrototypeHtml(choice?.prototypeHtml ?? ''); setEvidence(choice?.evidence ?? []); setKnowledgeEvidence(choice?.knowledgeEvidence ?? []); setFile(null); setExcerpt(''); setKnowledgeFile(null); setKnowledgeExcerpt(''); setSolutionDirty(false) }
  const searchEvidence = async () => {
    const found = await perform((rpc) => rpc.call('requirements.searchEvidence', { ...ref, query }))
    if (found) setMatches(found)
  }
  const previewEvidence = async (match: ProjectFileMatch) => {
    const found = await perform((rpc) => rpc.call('requirements.readEvidence', { ...ref, path: match.path }))
    if (found) { setFile(found); setPreviewPath(found.path); setExcerpt('') }
  }
  const searchKnowledge = async () => {
    const found = await perform((rpc) => rpc.call('requirements.searchKnowledge', { ...ref, query: knowledgeQuery }))
    if (found) { setKnowledgeMatches(found.matches); setKnowledgeSearchTruncated(found.truncated) }
  }
  const previewKnowledge = async (match: ProjectFileMatch) => {
    const found = await perform((rpc) => rpc.call('requirements.readKnowledge', { ...ref, path: match.path }))
    if (found) { setKnowledgeFile(found); setKnowledgeExcerpt('') }
  }
  const addEvidence = () => {
    if (!file || evidence.length >= 20 || !excerpt.trim() || !file.text.includes(excerpt.trim()) || evidence.some((item) => item.path === file.path && item.excerpt === excerpt.trim())) return
    setEvidence([...evidence, { path: file.path, project: file.project, relative: file.relative, excerpt: excerpt.trim(), mtimeMs: file.mtimeMs, checkedAt: file.checkedAt, sha256: file.sha256 }])
    setSolutionDirty(true); onDirty(true); setExcerpt('')
  }
  const addKnowledgeEvidence = () => {
    if (!knowledgeFile || evidence.length + knowledgeEvidence.length >= 20 || !knowledgeExcerpt.trim() || !knowledgeFile.text.includes(knowledgeExcerpt.trim()) || knowledgeEvidence.some((item) => item.path === knowledgeFile.path && item.excerpt === knowledgeExcerpt.trim())) return
    setKnowledgeEvidence([...knowledgeEvidence, { path: knowledgeFile.path, project: knowledgeFile.project, relative: knowledgeFile.relative, excerpt: knowledgeExcerpt.trim(), mtimeMs: knowledgeFile.mtimeMs, checkedAt: knowledgeFile.checkedAt, sha256: knowledgeFile.sha256 }])
    setSolutionDirty(true); onDirty(true); setKnowledgeExcerpt('')
  }
  const recheckEvidence = async (item: RequirementEvidence) => {
    const found = await perform((rpc) => rpc.call('requirements.readEvidence', { ...ref, path: item.path }))
    if (!found) return
    setFile(found); setPreviewPath(found.path); setExcerpt(item.excerpt)
    if (found.text.includes(item.excerpt)) {
      setEvidence(evidence.map((each) => each === item ? { ...item, project: found.project, relative: found.relative, mtimeMs: found.mtimeMs, checkedAt: found.checkedAt, sha256: found.sha256 } : each))
      setSolutionDirty(true); onDirty(true)
    }
  }
  const analyze = async (prototypeFor?: string) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const context = await perform((rpc) => rpc.call('requirements.context', { ...ref, ...(prototypeFor ? { prototypeFor } : { ...(evidenceSupported ? { evidence } : {}), ...(knowledgeEvidenceSupported ? { knowledgeEvidence } : {}) }) }))
    if (!context) { pending.current = false; setBusy(false); return }
    // Keep one composer per requirement version so a new request cannot append to another project's draft.
    const key = 'requirement:' + ref.id + '/' + ref.version + '/' +
      (prototypeFor ?? (solutionDirty ? crypto.randomUUID() : 'analysis:' + (solutionId ?? 'new')))
    const previous = composerDraft(key)
    if (!previous.text && !previous.images.length) saveComposerDraft(key, { text: context.text, images: context.images, mentions: [] })
    onTask()
    openConversationDraft(context.projectPaths, null, { key, title: requirement.title }, true)
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
      {!projectIterationsSupported && <>
        {(['project', 'release'] as const).map((field) => <label key={field}>{t(`Requirements.${field}`)}<textarea className="input" aria-label={t(`Requirements.${field}`)} value={fields[field]} maxLength={10_000} rows={1} onChange={(event) => { setFields({ ...fields, [field]: event.target.value }); setFieldsDirty(true); onDirty(true) }} /></label>)}
      </>}
      {projectIterationsSupported && <RequirementProjectFields fields={fields}
        disabled={historical || busy || solutionDirty || Boolean(feedback || confirmer)}
        onChange={(selection) => { setFields({ ...fields, ...selection }); setFieldsDirty(true); onDirty(true) }} />}
      <label>{t('Requirements.repos')}<ProjectPicker projects={fields.repos.map((path) => ({ path, worktreePath: null }))} onChange={(repos) => { setFields({ ...fields, repos }); setFieldsDirty(true); onDirty(true) }} /></label>
    </fieldset>
    {!historical && <div className="toolbar">
      <button type="button" className="button" disabled={busy || solutionDirty || Boolean(feedback || confirmer)} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.revise', { ...ref, fields })))}>{t('Requirements.saveRevision')}</button>
      <button type="button" className="button" disabled={busy || fieldsDirty || solutionDirty || Boolean(feedback || confirmer)} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.revise', { ...ref, fields, refreshSource: true })))}>{t('Requirements.refreshSource')}</button>
      <button type="button" className="button" disabled={busy || fieldsDirty || Boolean(feedback || confirmer)} onClick={() => void analyze()}>{t('Requirements.analyze')}</button>
    </div>}
    <h3>{t('Requirements.solution')}</h3>
    <ChatPicker label={t('Requirements.solution')} placeholder={t('Requirements.newSolution')} value={solutionId ?? 'new'} placement="below" disabled={busy || fieldsDirty || solutionDirty || Boolean(feedback || confirmer)}
      options={[{ value: 'new', label: t('Requirements.newSolution') }, ...requirement.solutions.map((each) => ({ value: each.id, label: `${t('Requirements.revision')} ${each.revision} · ${t(`Requirements.${each.status}`)} · ${dayAndTime(each.updatedAt)}` }))]} onChange={chooseSolution} />
    {evidenceSupported && <section className="requirement-evidence" aria-label={t('Requirements.evidence')}>
      <h4>{t('Requirements.evidence')}</h4>
      {editable && <div className="requirement-evidence-search"><input className="input" aria-label={t('Requirements.searchEvidence')} value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className="button" disabled={busy || fieldsDirty || !fields.repos.length} onClick={() => void searchEvidence()}><SearchIcon />{t('Requirements.searchEvidence')}</button></div>}
      {matches.map((match) => <button className="button" type="button" key={match.path} onClick={() => void previewEvidence(match)}>{match.relative}</button>)}
      {previewPath && file?.path !== previewPath && <p role="alert">{t('Requirements.evidenceChanged')} <button type="button" className="button" onClick={() => { setPreviewPath(null); setFile(null) }}>{t('Requirements.reload')}</button></p>}
      {file && <div className="requirement-evidence-preview"><strong>{file.relative}</strong><pre>{file.text.slice(0, 12_000)}</pre><label>{t('Requirements.excerpt')}<textarea className="input" aria-label={t('Requirements.excerpt')} value={excerpt} maxLength={6_000} onChange={(event) => setExcerpt(event.target.value)} /></label><button type="button" className="button" disabled={evidence.length >= 20 || !excerpt.trim() || !file.text.includes(excerpt.trim())} onClick={addEvidence}>{t('Requirements.addEvidence')}</button></div>}
      {evidence.map((item) => <div className="requirement-evidence-item" key={item.path + item.excerpt}><span>{item.relative}</span><blockquote>{item.excerpt}</blockquote>{editable && <><button type="button" className="button ghost" onClick={() => void recheckEvidence(item)}>{t('Requirements.recheckEvidence')}</button><button type="button" className="button ghost" onClick={() => { setEvidence(evidence.filter((each) => each !== item)); setSolutionDirty(true); onDirty(true) }}>{t('Requirements.removeEvidence')}</button></>}</div>)}
    </section>}
    {knowledgeEvidenceSupported && <section className="requirement-evidence" aria-label={t('Requirements.knowledgeEvidence')}>
      <h4>{t('Requirements.knowledgeEvidence')}</h4>
      {editable && <div className="requirement-evidence-search"><input className="input" aria-label={t('Requirements.searchKnowledge')} value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} /><button type="button" className="button" disabled={busy} onClick={() => void searchKnowledge()}><SearchIcon />{t('Requirements.searchKnowledge')}</button></div>}
      {knowledgeMatches.map((match) => <button className="button" type="button" key={match.path} disabled={busy} onClick={() => void previewKnowledge(match)}>{match.relative}</button>)}
      {knowledgeSearchTruncated && <p className="muted">{t('Requirements.knowledgeSearchTruncated')}</p>}
      {knowledgeFile && <div className="requirement-evidence-preview"><strong>{knowledgeFile.relative}</strong><pre>{knowledgeFile.text.slice(0, 12_000)}</pre>{editable && <><label>{t('Requirements.excerpt')}<textarea className="input" aria-label={t('Requirements.knowledgeExcerpt')} value={knowledgeExcerpt} maxLength={6_000} onChange={(event) => setKnowledgeExcerpt(event.target.value)} /></label><button type="button" className="button" disabled={evidence.length + knowledgeEvidence.length >= 20 || !knowledgeExcerpt.trim() || !knowledgeFile.text.includes(knowledgeExcerpt.trim())} onClick={addKnowledgeEvidence}>{t('Requirements.addEvidence')}</button></>}</div>}
      {knowledgeEvidence.map((item) => <div className="requirement-evidence-item" key={item.path + item.excerpt}><span>{item.relative}</span><blockquote>{item.excerpt}</blockquote>{editable && <button type="button" className="button ghost" onClick={() => { setKnowledgeEvidence(knowledgeEvidence.filter((each) => each !== item)); setSolutionDirty(true); onDirty(true) }}>{t('Requirements.removeEvidence')}</button>}</div>)}
    </section>}
    {solution?.evidenceStale && <p role="alert">{t('Requirements.evidenceChanged')}</p>}
    {solution && solution.revision !== latest.number && <p role="status">{t('Requirements.stale')}</p>}
    <MarkdownEditor key={`${solutionId ?? 'new'}/${editable}/${fieldsDirty}/${Boolean(feedback || confirmer)}`} value={markdown} label={t('Requirements.solution')} hint={t('Requirements.solutionHint')} readOnly={!editable || fieldsDirty || Boolean(feedback || confirmer)} onChange={(value) => { setMarkdown(value); setSolutionDirty(true); onDirty(true) }} />
    {prototypeSupported && (editable || prototypeHtml) && <RequirementPrototype key={solutionId ?? 'new'} html={prototypeHtml}
      onChange={editable && !fieldsDirty && !feedback && !confirmer ? (html) => {
        setPrototypeHtml(html)
        setSolutionDirty(true)
        onDirty(true)
      } : undefined}
      onRequest={editable && solution?.markdown && !solutionDirty ? () => void analyze(solution.id) : undefined} />}
    {!prototypeSupported && solutionDirty && prototypeHtml !== (solution?.prototypeHtml ?? '') &&
      <p role="status">{t('Requirements.prototypeNeedsCore')}</p>}
    {editable && <button type="button" className="button" disabled={busy || fieldsDirty || Boolean(feedback || confirmer) || (!prototypeSupported && prototypeHtml !== (solution?.prototypeHtml ?? ''))} onClick={() => void act(() => perform((rpc) => rpc.call('requirements.solution', { ...ref, ...(solutionId ? { solutionId } : {}), markdown, ...(evidenceSupported ? { evidence } : {}), ...(knowledgeEvidenceSupported ? { knowledgeEvidence } : {}), ...(prototypeSupported && prototypeHtml !== (solution?.prototypeHtml ?? '') ? { prototypeHtml } : {}) })))}>{t('Requirements.saveSolution')}</button>}
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
