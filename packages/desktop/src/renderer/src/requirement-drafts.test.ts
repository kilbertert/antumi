import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_REQUIREMENT_FIELDS } from '@antumi/protocol'
import { keepRequirementDraft, requirementDraft } from './requirement-drafts'

afterEach(() => vi.unstubAllGlobals())
describe('requirement drafts', () => {
  it('restores fields and reviews with their original version and clears only the confirmed draft', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
    const draft = { version: 2, fields: EMPTY_REQUIREMENT_FIELDS, fieldsDirty: true, solutionDirty: false,
      solutionId: null, markdown: 'draft', prototypeHtml: '<h1>Preview</h1>', feedback: 'needs review', confirmer: 'owner', evidence: [], query: '', file: null, excerpt: '' }
    keepRequirementDraft('one', draft)
    keepRequirementDraft('two', { ...draft, version: 3 })
    expect(requirementDraft('one')).toEqual(draft)
    keepRequirementDraft('one', null)
    expect(requirementDraft('one')).toBeNull()
    expect(requirementDraft('two')?.version).toBe(3)
    data.set('antumi.requirement-draft.bad', '{bad')
    expect(requirementDraft('bad')).toBeNull()
  })
  it('does not interrupt editing when local storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    expect(requirementDraft('one')).toBeNull()
    expect(() => keepRequirementDraft('one', null)).not.toThrow()
  })
})
