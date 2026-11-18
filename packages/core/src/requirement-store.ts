import { DatabaseSync } from 'node:sqlite'
import { Requirement, type TaskSource } from '@antumi/protocol'
import { z } from 'zod'
import { Rejection } from './rejection'

// Tables belong to TaskStore's additive migrations, including the atomic task-handoff link.
export class RequirementStore {
  private readonly db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }
  close(): void { this.db.close() }
  list(): Requirement[] {
    return this.db.prepare('SELECT data FROM requirements ORDER BY updated_at DESC').all().map((row) => this.read(row))
  }
  get(id: string): Requirement {
    const row = this.db.prepare('SELECT data FROM requirements WHERE id = ?').get(id)
    if (!row) throw new Rejection('requirement-not-found')
    return this.read(row)
  }
  bySource(source: Pick<TaskSource, 'provider' | 'instance' | 'key'>, binding: string): Requirement | null {
    const row = this.db.prepare('SELECT data FROM requirements WHERE provider = ? AND instance = ? AND binding = ? AND source_key = ?').get(source.provider, source.instance, binding, source.key)
    return row ? this.read(row) : null
  }
  add(requirement: Requirement): Requirement {
    requirement = Requirement.parse(requirement)
    const source = requirement.revisions[0]!.source
    this.db.prepare('INSERT OR IGNORE INTO requirements (id, provider, instance, source_key, binding, version, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(requirement.id, source.provider, source.instance, source.key, requirement.binding, requirement.version, JSON.stringify(requirement), requirement.updatedAt)
    return this.bySource(source, requirement.binding)!
  }
  save(requirement: Requirement, version: number): Requirement {
    const next = Requirement.parse({ ...requirement, version: version + 1 })
    const written = this.db.prepare('UPDATE requirements SET data = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?')
      .run(JSON.stringify(next), next.version, next.updatedAt, next.id, version)
    if (!written.changes) throw new Rejection('requirement-conflict', '需求已在另一窗口更新，请重新加载后保存')
    return next
  }
  private read(row: unknown): Requirement {
    return Requirement.parse(JSON.parse(z.object({ data: z.string() }).parse(row).data))
  }
}
