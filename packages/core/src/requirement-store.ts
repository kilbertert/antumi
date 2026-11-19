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
    this.db.exec('CREATE TABLE IF NOT EXISTS requirement_solution_evidence (requirement_id TEXT NOT NULL, solution_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (requirement_id, solution_id))')
    this.db.exec('CREATE TABLE IF NOT EXISTS requirement_prototypes (requirement_id TEXT NOT NULL, solution_id TEXT NOT NULL, html TEXT NOT NULL, PRIMARY KEY (requirement_id, solution_id))')
    this.db.exec('CREATE TABLE IF NOT EXISTS requirement_knowledge_evidence (requirement_id TEXT NOT NULL, solution_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (requirement_id, solution_id))')
  }
  close(): void { this.db.close() }
  list(): Requirement[] {
    return this.db.prepare('SELECT data FROM requirements ORDER BY updated_at DESC').all().map((row) => this.read(row, false))
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
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const written = this.db.prepare('UPDATE requirements SET data = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?')
        .run(this.summaryJson(next), next.version, next.updatedAt, next.id, version)
      if (!written.changes) throw new Rejection('requirement-conflict', '需求已在另一窗口更新，请重新加载后保存')
      const insert = this.db.prepare('INSERT INTO requirement_solution_evidence (requirement_id, solution_id, data) VALUES (?, ?, ?) ON CONFLICT(requirement_id, solution_id) DO UPDATE SET data = excluded.data')
      this.db.prepare('DELETE FROM requirement_solution_evidence WHERE requirement_id = ?').run(next.id)
      const putKnowledge = this.db.prepare('INSERT INTO requirement_knowledge_evidence (requirement_id, solution_id, data) VALUES (?, ?, ?) ON CONFLICT(requirement_id, solution_id) DO UPDATE SET data = excluded.data')
      for (const solution of next.solutions) {
        insert.run(next.id, solution.id, JSON.stringify({ evidence: solution.evidence, evidenceStale: solution.evidenceStale }))
      }
      this.db.prepare('DELETE FROM requirement_knowledge_evidence WHERE requirement_id = ?').run(next.id)
      for (const solution of next.solutions) putKnowledge.run(next.id, solution.id, JSON.stringify({ evidence: solution.knowledgeEvidence }))
      // Older Core versions rewrite the requirement and evidence rows but leave this snapshot alone.
      const putPrototype = this.db.prepare('INSERT INTO requirement_prototypes VALUES (?, ?, ?) ON CONFLICT(requirement_id, solution_id) DO UPDATE SET html = excluded.html')
      const removePrototype = this.db.prepare('DELETE FROM requirement_prototypes WHERE requirement_id = ? AND solution_id = ?')
      for (const { id, prototypeHtml } of next.solutions) {
        if (prototypeHtml) putPrototype.run(next.id, id, prototypeHtml)
        else if (prototypeHtml === '') removePrototype.run(next.id, id)
      }
      this.db.exec('COMMIT')
      return next
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private read(row: unknown, includePrototype = true): Requirement {
    const requirement = Requirement.parse(JSON.parse(z.object({ data: z.string() }).parse(row).data))
    const evidence = new Map(this.db.prepare('SELECT solution_id, data FROM requirement_solution_evidence WHERE requirement_id = ?').all(requirement.id)
      .map((item) => z.object({ solution_id: z.string(), data: z.string() }).parse(item))
      .map(({ solution_id, data }) => [solution_id, z.object({ evidence: Requirement.shape.solutions.element.shape.evidence, evidenceStale: Requirement.shape.solutions.element.shape.evidenceStale }).parse(JSON.parse(data))]))
    const knowledgeEvidence = new Map(this.db.prepare('SELECT solution_id, data FROM requirement_knowledge_evidence WHERE requirement_id = ?').all(requirement.id)
      .map((item) => z.object({ solution_id: z.string(), data: z.string() }).parse(item))
      .map(({ solution_id, data }) => [solution_id, z.object({ evidence: Requirement.shape.solutions.element.shape.knowledgeEvidence }).parse(JSON.parse(data)).evidence]))
    const prototypes = includePrototype
      ? this.db.prepare('SELECT solution_id, html FROM requirement_prototypes WHERE requirement_id = ?').all(requirement.id)
      : []
    const htmlById = new Map(prototypes.map((item) => z.object({ solution_id: z.string(), html: z.string() }).parse(item))
      .map(({ solution_id, html }) => [solution_id, html]))
    return Requirement.parse({ ...requirement, solutions: requirement.solutions.map((solution) => ({
      ...solution, ...evidence.get(solution.id), knowledgeEvidence: knowledgeEvidence.get(solution.id), prototypeHtml: htmlById.get(solution.id)
    })) })
  }
  private summaryJson(requirement: Requirement): string {
    return JSON.stringify({ ...requirement, solutions: requirement.solutions.map(({ evidence: _evidence, knowledgeEvidence: _knowledgeEvidence, evidenceStale: _evidenceStale, prototypeHtml: _prototypeHtml, ...solution }) => solution) })
  }
}
