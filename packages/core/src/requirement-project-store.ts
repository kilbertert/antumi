import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { RequirementCatalog, RequirementIteration, RequirementProject } from '@antumi/protocol'
import { Rejection } from './rejection'

export class RequirementProjectStore {
  private readonly db: DatabaseSync
  constructor(file: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA foreign_keys = ON')
  }
  close(): void { this.db.close() }
  catalog(): RequirementCatalog {
    const projects = this.db.prepare('SELECT id, name, archived, created_at AS createdAt, updated_at AS updatedAt FROM requirement_projects ORDER BY archived, name').all().map((row) => RequirementProject.parse({ ...row, archived: Boolean(row.archived) }))
    const iterations = this.db.prepare('SELECT id, project_id AS projectId, name, status, created_at AS createdAt, updated_at AS updatedAt FROM requirement_iterations ORDER BY created_at').all().map((row) => RequirementIteration.parse(row))
    return { projects, iterations }
  }
  saveProject(input: { id?: string; name: string }): RequirementProject {
    return this.transaction(() => {
      const name = RequirementProject.shape.name.parse(input.name); const at = this.now()
      const duplicate = this.db.prepare('SELECT id FROM requirement_projects WHERE name = ? COLLATE NOCASE AND id != ?').get(name, input.id ?? '')
      if (duplicate) throw new Rejection('requirement-project-duplicate', '业务项目名称已存在')
      if (input.id) {
        const current = this.project(input.id)
        this.db.prepare('UPDATE requirement_projects SET name = ?, updated_at = ? WHERE id = ?').run(name, at, input.id)
        return { ...current, name, updatedAt: at }
      }
      const project = { id: randomUUID(), name, archived: false, createdAt: at, updatedAt: at }
      this.db.prepare('INSERT INTO requirement_projects VALUES (?, ?, 0, ?, ?)').run(project.id, project.name, at, at)
      return project
    })
  }
  archiveProject(id: string, archived: boolean): RequirementProject {
    return this.transaction(() => {
      const current = this.project(id); const at = this.now()
      if (archived && this.db.prepare("SELECT 1 FROM requirement_iterations WHERE project_id = ? AND status != 'closed' LIMIT 1").get(id)) throw new Rejection('requirement-project-open-iterations', '请先关闭项目下的开放迭代')
      this.db.prepare('UPDATE requirement_projects SET archived = ?, updated_at = ? WHERE id = ?').run(Number(archived), at, id)
      return { ...current, archived, updatedAt: at }
    })
  }
  saveIteration(input: { id?: string; projectId: string; name: string; status: 'planned' | 'active' | 'closed' }): RequirementIteration {
    return this.transaction(() => {
      const project = this.project(input.projectId)
      if (project.archived && input.status !== 'closed') throw new Rejection('requirement-project-archived', '归档项目不能创建开放迭代')
      const name = RequirementIteration.shape.name.parse(input.name); const at = this.now()
      const duplicate = this.db.prepare('SELECT id FROM requirement_iterations WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(input.projectId, name, input.id ?? '')
      if (duplicate) throw new Rejection('requirement-iteration-duplicate', '该项目已存在同名迭代')
      if (input.id) {
        const current = this.iteration(input.id)
        if (current.projectId !== input.projectId) throw new Rejection('requirement-iteration-project-changed')
        if (current.status === 'closed' && input.status !== 'closed') throw new Rejection('requirement-iteration-closed', '已关闭的迭代不能重新开放')
      }
      if (input.status === 'active') this.db.prepare("UPDATE requirement_iterations SET status = 'planned', updated_at = ? WHERE project_id = ? AND status = 'active' AND id != ?").run(at, input.projectId, input.id ?? '')
      if (input.id) {
        const current = this.iteration(input.id)
        this.db.prepare('UPDATE requirement_iterations SET name = ?, status = ?, updated_at = ? WHERE id = ?').run(name, input.status, at, input.id)
        return { ...current, name, status: input.status, updatedAt: at }
      }
      const iteration = { id: randomUUID(), projectId: input.projectId, name, status: input.status, createdAt: at, updatedAt: at }
      this.db.prepare('INSERT INTO requirement_iterations VALUES (?, ?, ?, ?, ?, ?)').run(iteration.id, iteration.projectId, iteration.name, iteration.status, at, at)
      return iteration
    })
  }
  assertSelectable(projectId: string | null | undefined, iterationId: string | null | undefined): void {
    if (!projectId && !iterationId) return
    if (!projectId || !iterationId) throw new Rejection('requirement-iteration-required', '业务项目和迭代需要一起选择')
    const project = this.project(projectId); const iteration = this.iteration(iterationId)
    if (iteration.projectId !== project.id) throw new Rejection('requirement-iteration-project-mismatch')
    if (project.archived || iteration.status === 'closed') throw new Rejection('requirement-iteration-closed', '只能选择未关闭的项目迭代')
  }
  selection(projectId: string | null | undefined, iterationId: string | null | undefined): { project: string; release: string } | null {
    if (!projectId && !iterationId) return null
    this.assertSelectable(projectId, iterationId)
    return { project: this.project(projectId!).name, release: this.iteration(iterationId!).name }
  }
  private project(id: string): RequirementProject { const row = this.db.prepare('SELECT id, name, archived, created_at AS createdAt, updated_at AS updatedAt FROM requirement_projects WHERE id = ?').get(id); if (!row) throw new Rejection('requirement-project-not-found'); return RequirementProject.parse({ ...row, archived: Boolean(row.archived) }) }
  private iteration(id: string): RequirementIteration { const row = this.db.prepare('SELECT id, project_id AS projectId, name, status, created_at AS createdAt, updated_at AS updatedAt FROM requirement_iterations WHERE id = ?').get(id); if (!row) throw new Rejection('requirement-iteration-not-found'); return RequirementIteration.parse(row) }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
