import { useState } from 'react'
import { MAX_PROTOTYPE_HTML_LENGTH } from '@antumi/protocol'
import { t } from '../i18n'

export function RequirementPrototype({ html, onChange, onRequest }: {
  html: string
  onChange?: (html: string) => void
  onRequest?: () => void
}) {
  const [preview, setPreview] = useState<string | null>(null)
  return <section className="requirement-prototype" aria-label={t('Requirements.prototype')}>
    <h4>{t('Requirements.prototype')}</h4>
    {onChange && <>
      {onRequest && <button type="button" className="button" onClick={onRequest}>{t('Requirements.generatePrototype')}</button>}
      <label>{t('Requirements.prototypeSource')}
        <textarea className="input" rows={6} spellCheck={false} value={html} maxLength={MAX_PROTOTYPE_HTML_LENGTH}
          onChange={(event) => { setPreview(null); onChange(event.target.value) }} />
      </label>
    </>}
    <button type="button" className="button" disabled={!html.trim()} aria-expanded={preview !== null}
      onClick={() => setPreview(preview === null ? prototypeDocument(html) : null)}>
      {t(preview === null ? 'Requirements.previewPrototype' : 'Requirements.closePrototypePreview')}
    </button>
    {preview !== null && <iframe className="requirement-prototype-frame" title={t('Requirements.prototype')}
      sandbox="" referrerPolicy="no-referrer" srcDoc={preview} />}
  </section>
}

function prototypeDocument(html: string): string {
  // Templates are inert while parsing, including images and frames in the pasted HTML.
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('base, meta, link, script, iframe, frame, object, embed, template, noscript, animate, animateMotion, animateTransform, set').forEach((node) => node.remove())
  template.content.querySelectorAll('a, area').forEach((node) => {
    node.removeAttribute('href')
    node.removeAttribute('xlink:href')
  })
  return '<!doctype html><meta charset="UTF-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\">" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' + template.innerHTML
}
