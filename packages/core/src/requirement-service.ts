import { randomUUID } from 'node:crypto'
import { EMPTY_REQUIREMENT_FIELDS, MAX_DETAILS_LENGTH, RequirementFields, solutionBlocker, type Requirement, type RequirementSolution, type RequirementRevision, type RpcParsedParams, type Task } from '@antumi/protocol'
import { RequirementStore } from './requirement-store'
import { Rejection } from './rejection'
import type { SourceService } from './source-service'
import type { TaskService } from './task-service'
import { normalizeRepoPath } from './workspace'

export class RequirementService {
  constructor(private readonly store: RequirementStore,
    private readonly sources: Pick<SourceService, 'requirementSnapshot' | 'requirementBinding'>,
    private readonly tasks: Pick<TaskService, 'createRequirementTask'>,
    private readonly emit: (requirement: Requirement) => void,
    private readonly now: () => number = Date.now) {}
  list(): Requirement[] { return this.store.list() }
  get(id: string): Requirement { return this.store.get(id) }
  async import({ provider, instance, key }: RpcParsedParams<'requirements.import'>): Promise<Requirement> {
    const existing = this.store.bySource({ provider, instance, key }, this.sources.requirementBinding(provider, instance))
    if (existing) return existing
    const { source, snapshot, binding } = await this.sources.requirementSnapshot(provider, instance, key)
    const at = this.now()
    return this.changed(this.store.add({ id: randomUUID(), binding, version: 1, title: source.title || source.key,
      revisions: [{ number: 1, fields: { ...EMPTY_REQUIREMENT_FIELDS, repos: [] }, source, snapshot, createdAt: at }],
      solutions: [], createdAt: at, updatedAt: at }))
  }
  async revise({ id, version, fields, refreshSource }: RpcParsedParams<'requirements.revise'>): Promise<Requirement> {
    let requirement = this.expected(id, version)
    const previous = requirement.revisions.at(-1)!
    const normalized = RequirementFields.parse({ ...fields, repos: [...new Set(fields.repos.map(normalizeRepoPath))] })
    const fetched = refreshSource ? await this.sources.requirementSnapshot(previous.source.provider, previous.source.instance, previous.source.key) : previous
    if (refreshSource && 'binding' in fetched && fetched.binding !== requirement.binding) throw new Rejection('requirement-source-changed', '禅道站点已更换，请重新导入；旧需求历史已保留')
    requirement = this.expected(id, version)
    const at = this.now()
    return this.save({ ...requirement, revisions: [...requirement.revisions, { number: previous.number + 1,
      fields: normalized, source: fetched.source, snapshot: fetched.snapshot, createdAt: at }], updatedAt: at }, version)
  }
  solution({ id, version, solutionId, markdown }: RpcParsedParams<'requirements.solution'>): Requirement {
    markdown = markdown.trim()
    const requirement = this.expected(id, version)
    const current = solutionId ? this.findSolution(requirement, solutionId) : null
    if (current && (current.revision !== requirement.revisions.at(-1)!.number || !['draft', 'changes'].includes(current.status))) throw new Rejection('solution-not-editable')
    const at = this.now()
    const next: RequirementSolution = current ? { ...current, markdown, updatedAt: at } : {
      id: randomUUID(), revision: requirement.revisions.at(-1)!.number, markdown, status: 'draft', reviews: [], createdAt: at, updatedAt: at
    }
    return this.save({ ...requirement, solutions: [...requirement.solutions.filter((each) => each.id !== next.id), next], updatedAt: at }, version)
  }
  review({ id, version, solutionId, action, confirmer, feedback }: RpcParsedParams<'requirements.review'>): Requirement {
    const requirement = this.expected(id, version)
    const solution = this.findSolution(requirement, solutionId)
    const blocker = action === 'changes' ? (solution.status === 'review' && solution.revision === requirement.revisions.at(-1)!.number ? null : 'solution-not-reviewing')
      : solutionBlocker(requirement, solution, action === 'submit' ? 'submit' : 'accept')
    if (blocker) throw new Rejection(blocker)
    if (action !== 'submit' && confirmer?.trim() !== requirement.revisions.at(-1)!.fields.owner) throw new Rejection('requirement-owner-confirmation', '请记录需求负责人的确认')
    if (action === 'changes' && !feedback?.trim()) throw new Rejection('review-feedback-required')
    const at = this.now()
    const next: RequirementSolution = { ...solution, status: action === 'submit' ? 'review' : action, updatedAt: at,
      reviews: action === 'submit' ? solution.reviews : [...solution.reviews, { decision: action, confirmer: confirmer!.trim(), feedback: feedback?.trim() ?? '', createdAt: at }] }
    return this.save({ ...requirement, solutions: requirement.solutions.map((each) => each.id === solutionId ? next : each), updatedAt: at }, version)
  }
  handoff({ id, version, solutionId }: RpcParsedParams<'requirements.handoff'>): Task {
    const requirement = this.expected(id, version)
    const solution = this.findSolution(requirement, solutionId)
    const blocker = solutionBlocker(requirement, solution, 'handoff')
    if (blocker) throw new Rejection(blocker)
    const revision = requirement.revisions.at(-1)!
    const details = `${requirementBrief(requirement, revision)}\n\n## 已采纳方案\n${solution.markdown}\n\n## 评审\n${solution.reviews.map((review) => `${review.confirmer}: ${review.feedback || review.decision}`).join('\n')}`
    if (details.length > MAX_DETAILS_LENGTH) throw new Rejection('requirement-brief-too-long', '需求与方案超过任务长度上限，请精简后交接')
    return this.tasks.createRequirementTask(solution.id, { title: requirement.title, details,
      repos: revision.fields.repos, source: revision.source, snapshot: revision.snapshot })
  }
  private expected(id: string, version: number): Requirement {
    const requirement = this.get(id)
    if (requirement.version !== version) throw new Rejection('requirement-conflict', '需求已更新，请重新加载')
    return requirement
  }
  private findSolution(requirement: Requirement, id: string): RequirementSolution {
    const solution = requirement.solutions.find((each) => each.id === id)
    if (!solution) throw new Rejection('solution-not-found')
    return solution
  }
  private save(requirement: Requirement, version: number): Requirement { return this.changed(this.store.save(requirement, version)) }
  private changed(requirement: Requirement): Requirement { this.emit(requirement); return requirement }
}

export function requirementBrief(requirement: Requirement, revision: RequirementRevision): string {
  const fields = revision.fields
  return `# ${requirement.title}\n需求 ${requirement.id} / 修订 ${revision.number}\n项目：${fields.project} / 版本：${fields.release}\n需求负责人：${fields.owner} / 研发评审人：${fields.reviewer}\n\n## 目标\n${fields.goal}\n## 用户\n${fields.users}\n## 范围\n${fields.scope}\n## 非目标\n${fields.nonGoals}\n## 验收条件\n${fields.acceptance}\n## 约束\n${fields.constraints}\n## 待确认\n${fields.questions}`
}
