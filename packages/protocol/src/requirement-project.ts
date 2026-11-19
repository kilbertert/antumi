import { z } from 'zod'

const Name = z.string().trim().min(1).max(200)
export const RequirementProject = z.object({
  id: z.string().uuid(), name: Name, archived: z.boolean(), createdAt: z.number(), updatedAt: z.number()
})
export type RequirementProject = z.infer<typeof RequirementProject>

export const RequirementIterationStatus = z.enum(['planned', 'active', 'closed'])
export type RequirementIterationStatus = z.infer<typeof RequirementIterationStatus>
export const RequirementIteration = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), name: Name, status: RequirementIterationStatus,
  createdAt: z.number(), updatedAt: z.number()
})
export type RequirementIteration = z.infer<typeof RequirementIteration>

export const RequirementCatalog = z.object({ projects: z.array(RequirementProject), iterations: z.array(RequirementIteration) })
export type RequirementCatalog = z.infer<typeof RequirementCatalog>
