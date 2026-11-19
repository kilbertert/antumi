import { z } from 'zod'
import { RequirementFields, RequirementEvidence, RequirementPrototypeHtml } from '@antumi/protocol'

const Draft = z.object({
  version: z.number().int().positive(), fields: RequirementFields,
  fieldsDirty: z.boolean(), solutionDirty: z.boolean(),
  solutionId: z.string().uuid().nullable(), markdown: z.string().max(50_000),
  prototypeHtml: RequirementPrototypeHtml.optional(),
  feedback: z.string().max(10_000), confirmer: z.string().max(10_000), evidence: z.array(RequirementEvidence).max(20).default([]), query: z.string().max(200).default(''), file: z.string().nullable().default(null), excerpt: z.string().max(6_000).default('')
})
export type RequirementDraft = z.infer<typeof Draft>
const key = (id: string) => `antumi.requirement-draft.${id}`

export function requirementDraft(id: string): RequirementDraft | null {
  try {
    const draft = Draft.safeParse(JSON.parse(localStorage.getItem(key(id)) ?? 'null'))
    return draft.success ? draft.data : null
  } catch { return null }
}

// Keep the editing version: a restored draft may not overwrite a newer core revision.
export function keepRequirementDraft(id: string, draft: RequirementDraft | null): void {
  try {
    if (draft) localStorage.setItem(key(id), JSON.stringify(draft))
    else localStorage.removeItem(key(id))
  } catch { /* As with composer drafts, this window still holds edits if storage is unavailable. */ }
}
