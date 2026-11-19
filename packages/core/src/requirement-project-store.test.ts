import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from './task-store'
import { RequirementProjectStore } from './requirement-project-store'

describe('RequirementProjectStore', () => {
  let dir: string
  let store: RequirementProjectStore
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'antumi-requirement-projects-'))
    const database = path.join(dir, 'antumi.db')
    const db = new DatabaseSync(database)
    db.exec('PRAGMA foreign_keys = ON')
    for (const migration of MIGRATIONS) db.exec(migration)
    db.close()
    store = new RequirementProjectStore(database)
  })
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  it('allows only one active iteration per business project and requires it closed before archiving', () => {
    const project = store.saveProject({ name: '门店运营' })
    const first = store.saveIteration({ projectId: project.id, name: '1.2', status: 'active' })
    const second = store.saveIteration({ projectId: project.id, name: '1.3', status: 'active' })
    expect(store.catalog().iterations.find((each) => each.id === first.id)?.status).toBe('planned')
    expect(store.catalog().iterations.find((each) => each.id === second.id)?.status).toBe('active')
    expect(() => store.archiveProject(project.id, true)).toThrow(/关闭项目下的开放迭代/)
  })
  it('rejects duplicate names and does not reopen closed iterations', () => {
    const project = store.saveProject({ name: '门店运营' })
    store.saveIteration({ projectId: project.id, name: '1.2', status: 'planned' })
    expect(() => store.saveProject({ name: '门店运营' })).toThrow(/名称已存在/)
    expect(() => store.saveIteration({ projectId: project.id, name: '1.2', status: 'active' })).toThrow(/同名迭代/)
    const closed = store.saveIteration({ projectId: project.id, name: '1.1', status: 'closed' })
    expect(() => store.saveIteration({ id: closed.id, projectId: project.id, name: '1.1', status: 'planned' })).toThrow(/不能重新开放/)
  })
  it('rolls back failed activation without changing another project or the active iteration', () => {
    const project = store.saveProject({ name: '甲项目' })
    const other = store.saveProject({ name: '乙项目' })
    const active = store.saveIteration({ projectId: project.id, name: '1.0', status: 'active' })
    const foreign = store.saveIteration({ projectId: other.id, name: '2.0', status: 'planned' })
    expect(() => store.saveIteration({ id: foreign.id, projectId: project.id, name: '2.0', status: 'active' })).toThrow()
    expect(store.catalog().iterations.find((each) => each.id === active.id)?.status).toBe('active')
    expect(() => store.selection(project.id, foreign.id)).toThrow()
    store.saveIteration({ id: active.id, projectId: project.id, name: active.name, status: 'closed' })
    expect(store.archiveProject(project.id, true).archived).toBe(true)
    expect(() => store.saveIteration({ projectId: project.id, name: '1.1', status: 'planned' })).toThrow(/归档/)
    expect(store.archiveProject(project.id, false).archived).toBe(false)
    expect(() => store.saveIteration({ projectId: project.id, name: '1.1', status: 'planned' })).not.toThrow()
  })
})
