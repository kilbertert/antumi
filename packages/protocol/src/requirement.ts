import { z } from 'zod'
import { SourceSnapshot, TaskSource } from './source'
import { MAX_TASK_REPOS } from './task-limits'

const Text = z.string().trim().max(10_000)
export const RequirementFields = z.object({
  owner: Text, reviewer: Text, project: Text, release: Text,
  goal: Text, users: Text, scope: Text, nonGoals: Text,
  acceptance: Text, constraints: Text, questions: Text,
  repos: z.array(z.string().trim().min(1)).max(MAX_TASK_REPOS),
  businessProjectId: z.string().uuid().nullable().optional(), iterationId: z.string().uuid().nullable().optional()
})
export type RequirementFields = z.infer<typeof RequirementFields>
export const EMPTY_REQUIREMENT_FIELDS: RequirementFields = {
  owner: '', reviewer: '', project: '', release: '', goal: '', users: '', scope: '',
  nonGoals: '', acceptance: '', constraints: '', questions: '', repos: []
}
export const RequirementRevision = z.object({
  number: z.number().int().positive(), fields: RequirementFields,
  source: TaskSource, snapshot: SourceSnapshot, createdAt: z.number()
})
export type RequirementRevision = z.infer<typeof RequirementRevision>
export const RequirementEvidence = z.object({
  path: z.string().min(1).max(32_768), project: z.string().min(1).max(32_768), relative: z.string().min(1).max(32_768),
  excerpt: z.string().trim().min(1).max(6_000), mtimeMs: z.number().nonnegative(), checkedAt: z.number().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export type RequirementEvidence = z.infer<typeof RequirementEvidence>
export const RequirementKnowledgeEvidence = z.object({
  path: z.string().min(1).max(32_768), project: z.string().min(1).max(32_768), relative: z.string().min(1).max(32_768),
  excerpt: z.string().trim().min(1).max(6_000), mtimeMs: z.number().nonnegative(), checkedAt: z.number().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export type RequirementKnowledgeEvidence = z.infer<typeof RequirementKnowledgeEvidence>
export const RequirementKnowledgeSearch = z.object({ matches: z.array(z.object({ path: z.string(), root: z.string(), relative: z.string(), kind: z.literal('file') })), truncated: z.boolean() })
export const RequirementEvidenceFile = z.object({
  path: z.string(), project: z.string(), relative: z.string(), text: z.string(), mtimeMs: z.number(), checkedAt: z.number(), sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export type RequirementEvidenceFile = z.infer<typeof RequirementEvidenceFile>
export const SolutionStatus = z.enum(['draft', 'review', 'changes', 'accepted'])
export const MAX_PROTOTYPE_HTML_LENGTH = 50_000
export const RequirementPrototypeHtml = z.string().max(MAX_PROTOTYPE_HTML_LENGTH)
export const RequirementSolution = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(),
  markdown: z.string().trim().max(50_000), status: SolutionStatus,
  evidence: z.array(RequirementEvidence).max(20).default([]),
  knowledgeEvidence: z.array(RequirementKnowledgeEvidence).max(20).default([]),
  evidenceStale: z.boolean().optional(),
  prototypeHtml: RequirementPrototypeHtml.optional(),
  reviews: z.array(z.object({ decision: z.enum(['changes', 'accepted']),
    confirmer: Text.min(1), feedback: Text, createdAt: z.number() })),
  createdAt: z.number(), updatedAt: z.number()
})
export type RequirementSolution = z.infer<typeof RequirementSolution>
export const Requirement = z.object({
  id: z.string().uuid(), binding: z.string().min(1).max(64), version: z.number().int().positive(), title: z.string().min(1).max(200),
  revisions: z.array(RequirementRevision).min(1), solutions: z.array(RequirementSolution),
  createdAt: z.number(), updatedAt: z.number()
})
export type Requirement = z.infer<typeof Requirement>
export const RequirementRef = z.object({ id: z.string().uuid() })
export const RequirementEdit = RequirementRef.extend({ version: z.number().int().positive() })

export function solutionBlocker(requirement: Requirement, solution: RequirementSolution, action: 'submit' | 'accept' | 'handoff'): string | null {
  const latest = requirement.revisions.at(-1)!
  if (solution.revision !== latest.number) return 'requirement-stale'
  if (solution.evidenceStale) return 'requirement-evidence-changed'
  if (action === 'handoff') return solution.status === 'accepted' ? null : 'solution-not-accepted'
  if (action === 'accept' && solution.status !== 'review') return 'solution-not-reviewing'
  if (action === 'submit' && !['draft', 'changes'].includes(solution.status)) return 'solution-not-editable'
  const { owner, goal, scope, acceptance, questions, repos } = latest.fields
  if (!owner || !goal || !scope || !acceptance || repos.length === 0 || questions || !solution.markdown) return 'requirement-incomplete'
  return null
}
