import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RequirementPrototype } from './RequirementPrototype'

vi.mock('../i18n', () => ({ t: (key: string) => key }))

describe('RequirementPrototype', () => {
  it('shows the generation action only when the caller grants it', () => {
    const editable = renderToStaticMarkup(createElement(RequirementPrototype, {
      html: '<h1>Review</h1>', onChange: () => {}, onRequest: () => {}
    }))
    const readOnly = renderToStaticMarkup(createElement(RequirementPrototype, { html: '<h1>Review</h1>' }))

    expect(editable).toContain('Requirements.generatePrototype')
    expect(editable).toContain('Requirements.prototypeSource')
    expect(readOnly).not.toContain('Requirements.generatePrototype')
    expect(readOnly).not.toContain('Requirements.prototypeSource')
    expect(readOnly).toContain('Requirements.previewPrototype')
  })
})
