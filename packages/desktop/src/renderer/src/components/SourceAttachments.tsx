import { useEffect, useState, type ReactNode } from 'react'
import { t, tr, useLocale } from '../i18n'
import { perform, useCore } from '../core-store'
import type { TaskSource } from '@antumi/protocol'

type SourceAttachmentShape = { id: string; name: string; size: number | null }
type Progress = { read: number; total: number | null }

// Files the issue carries. The snapshot names them; the bytes are read from the source only when
// asked, because they run to tens of megabytes and are often never opened.
export function SourceAttachments({ source, attachments, binding }: { source: TaskSource; binding?: string; attachments: readonly SourceAttachmentShape[] }): ReactNode {
  useLocale((state) => state.locale)
  const rpc = useCore((state) => state.rpc)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  // A main older than this renderer cannot save; say so once rather than showing dead buttons.
  const canSave = typeof window.antumi?.saveDownload === 'function'

  // The download happens in core, so its progress arrives as a notification rather than as a
  // return value. Only the file being downloaded is listened for: two buttons pressed in turn
  // must not mix their numbers.
  useEffect(() => {
    if (busy === null) return
    const unsubscribe = rpc?.on('sources.attachmentProgress', (event) => {
      if (event.provider !== source.provider || event.instance !== source.instance || event.id !== busy) return
      setProgress({ read: event.read, total: event.total })
    })
    return () => unsubscribe?.()
  }, [rpc, busy, source.provider, source.instance])

  if (attachments.length === 0) return null

  const download = async (file: SourceAttachmentShape) => {
    setBusy(file.id)
    setProgress(null)
    setProblem(null)
    setSaved(null)
    try {
      const data = await perform((rpc) => rpc.call('sources.attachment', { provider: source.provider, instance: source.instance, key: source.key, attachmentId: file.id, expectedSize: file.size, ...(binding ? { binding } : {}) }))
      if (!data) { setProblem(t('SourceAttachments.notConnected')); return }
      const answer = await window.antumi?.saveDownload?.({ name: data.name, base64: data.base64 })
      if (answer && typeof answer === 'object' && 'ok' in answer) {
        const result = answer as { ok: boolean; path?: string; reason?: string }
        if (result.ok) setSaved(result.path ?? data.name)
        // A cancelled dialog is the user's own choice, not a failure worth a message.
        else if (result.reason !== 'cancelled') setProblem(result.reason ?? 'save-failed')
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'download-failed')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  return (
    <div className="snapshot-attachments">
      <span className="muted">{tr('SourceAttachments.filesFrom', { value1: source.name, value2: attachments.length })}</span>
      <ul>
        {attachments.map((file) => {
          const mine = busy === file.id
          const percent = mine && progress?.total ? Math.min(100, Math.floor((progress.read / progress.total) * 100)) : null
          return (
            <li key={file.id}>
              <button
                type="button"
                className="button ghost snapshot-attachment"
                disabled={busy !== null || !canSave}
                title={canSave ? t('SourceAttachments.download') : t('SourceAttachments.downloadUnsupported')}
                onClick={() => void download(file)}
              >
                <span className="snapshot-attachment-name">{file.name}</span>
                {file.size !== null && <span className="muted"> {joinSize(file.size)}</span>}
                {mine && percent === null && <span className="muted"> · {t('SourceAttachments.downloading')}</span>}
                {mine && percent !== null && <span className="muted"> · {percent}%</span>}
              </button>
              {/* A bar only where a total is known: a made-up percentage is worse than none. */}
              {mine && percent !== null && (
                <progress className="snapshot-attachment-progress" max={100} value={percent} aria-label={t('SourceAttachments.progressOf', { value1: file.name })} />
              )}
              {mine && percent === null && <progress className="snapshot-attachment-progress" aria-label={t('SourceAttachments.progressOf', { value1: file.name })} />}
            </li>
          )
        })}
      </ul>
      {saved !== null && <span className="muted">{tr('SourceAttachments.saved', { value1: saved })}</span>}
      {problem !== null && <span className="problem">{problem}</span>}
    </div>
  )
}

function joinSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
