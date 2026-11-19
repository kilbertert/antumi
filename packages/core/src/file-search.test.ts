import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findFiles, searchFiles, searchKnowledgeFiles } from './file-search'

describe('findFiles', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-find-file-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(path.join(root, 'src/rules/deep'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true })
    writeFileSync(path.join(root, 'src/rules/inventory.json'), '{}')
    writeFileSync(path.join(root, 'src/rules/deep/inventory.json'), '{}')
    writeFileSync(path.join(root, 'node_modules/pkg/inventory.json'), '{}')
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
    execFileSync('git', ['add', 'src/rules/inventory.json'], { cwd: root })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds a file by its name, tracked or not, the shallowest first, never an ignored one', async () => {
    expect(await findFiles([root], 'inventory.json')).toEqual([
      path.join(root, 'src/rules/inventory.json'),
      path.join(root, 'src/rules/deep/inventory.json')
    ])
  })

  it('takes the tail of a path, and finds nothing outside a repo', async () => {
    expect(await findFiles([root], 'deep/inventory.json')).toEqual([path.join(root, 'src/rules/deep/inventory.json')])
    expect(await findFiles([root], './rules/inventory.json')).toEqual([path.join(root, 'src/rules/inventory.json')])
    expect(await findFiles([os.tmpdir()], 'inventory.json')).toEqual([])
  })
})

describe('searchFiles', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-search-files-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(path.join(root, 'src/components'), { recursive: true })
    mkdirSync(path.join(root, 'dist'), { recursive: true })
    writeFileSync(path.join(root, 'src/components/ChatComposer.tsx'), '')
    writeFileSync(path.join(root, 'src/composer.ts'), '')
    writeFileSync(path.join(root, 'src/chat-composer-notes.md'), '')
    writeFileSync(path.join(root, 'README.md'), '')
    writeFileSync(path.join(root, 'dist/composer.js'), '')
    writeFileSync(path.join(root, '.gitignore'), 'dist\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const relatives = async (roots: string[], query: string) => (await searchFiles(roots, query)).map((match) => `${match.kind === 'directory' ? 'd' : 'f'}:${match.relative}`)

  it('ranks a name starting with the query over one containing it, then paths, then scattered letters', async () => {
    expect(await relatives([root], 'compo')).toEqual([
      'd:src/components',
      'f:src/composer.ts',
      'f:src/chat-composer-notes.md',
      'f:src/components/ChatComposer.tsx'
    ])
    expect(await relatives([root], 'notesmd')).toEqual(['f:src/chat-composer-notes.md'])
  })

  it('gives the top level for an empty query, folders first, never an ignored one', async () => {
    expect(await relatives([root], '')).toEqual(['d:src', 'f:README.md', 'f:.gitignore'])
  })

  it('answers with absolute paths and the root each came from', async () => {
    const [first] = await searchFiles([root], 'readme')
    expect(first).toEqual({ path: path.join(root, 'README.md'), root, relative: 'README.md', kind: 'file' })
  })

  it('walks a folder outside git, skipping dot folders and node_modules', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'antumi-search-plain-'))
    try {
      mkdirSync(path.join(plain, 'notes'), { recursive: true })
      mkdirSync(path.join(plain, 'node_modules/pkg'), { recursive: true })
      mkdirSync(path.join(plain, '.cache'), { recursive: true })
      writeFileSync(path.join(plain, 'notes/plan.md'), '')
      writeFileSync(path.join(plain, 'node_modules/pkg/plan.md'), '')
      writeFileSync(path.join(plain, '.cache/plan.md'), '')
      expect(await relatives([plain], 'plan')).toEqual(['f:notes/plan.md'])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('searchKnowledgeFiles', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'antumi-search-knowledge-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds terms in Markdown bodies rather than only file names', async () => {
    writeFileSync(path.join(root, 'operations.md'), '# Store operations\nUse the existing payment boundary.')
    writeFileSync(path.join(root, 'unrelated.txt'), 'employee personal note')
    writeFileSync(path.join(root, '.private.md'), 'payment boundary')
    const read = async (_roots: readonly string[], file: string) => ({ text: await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8')) })
    const result = await searchKnowledgeFiles([root], 'payment boundary', read)
    expect(result).toEqual({ matches: [{ path: path.join(root, 'operations.md'), root, relative: 'operations.md', kind: 'file' }], truncated: false })
  })

  it('limits content reads to the documented candidate bound', async () => {
    for (let index = 0; index < 305; index++) writeFileSync(path.join(root, `note-${index}.md`), 'needle')
    let reads = 0
    const result = await searchKnowledgeFiles([root], 'needle', async () => { reads++; return { text: 'needle' } })
    expect(result.truncated).toBe(true)
    expect(reads).toBe(300)
    expect(result.matches).toHaveLength(20)
  })
})
