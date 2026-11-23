import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CODEARTS_AGENTS, codeartsPluginReadyFile, codeartsRules, writeCodeartsPlugin } from './codearts-permissions'
import { codeartsConfig } from './codearts-config'

type Ask = { sessionID: string; permission: string; patterns?: string[]; metadata?: Record<string, unknown> }
const Hook = <Input>() => z.custom<(input: Input, output: { status: string }) => Promise<void>>((value) => typeof value === 'function')
const Hooks = z.object({ 'chat.message': Hook<{ sessionID: string; agent: string }>(), 'permission.ask': Hook<Ask>() })
const Plugin = z.object({ AntumiPermissions: z.custom<(input: { directory: string; worktree: string }) => Promise<unknown>>((value) => typeof value === 'function') })

let root: string
let project: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'antumi-codearts-plugin-')))
  project = path.join(root, 'project')
  mkdirSync(project)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const stage = () => ({ sessionsRoot: path.join(root, 'sessions'), conversationId: 'conversation', stageId: 'stage' })
const launch = { extraProjects: ['/work/other'], references: ['/work/reference'], readable: ['/antumi/attachments/image.png', '/antumi/pasted/**'], knowledgeBase: { path: '/vault', write: false } }

// The plugin as CodeArts loads it: its module imported, its export called with the instance's
// folders, and its hooks driven as a session would.
async function loaded() {
  const file = await writeCodeartsPlugin(stage(), launch)
  const module = Plugin.parse(await import(`${pathToFileURL(file).href}?${Date.now()}`))
  const hooks = Hooks.parse(await module.AntumiPermissions({ directory: project, worktree: project }))
  const prompt = (sessionID: string, agent: string) => hooks['chat.message']({ sessionID, agent }, { status: 'ask' })
  const ask = async (input: Ask) => {
    const output = { status: 'ask' }
    await hooks['permission.ask'](input, output)
    return output.status
  }
  return { prompt, ask }
}

describe('CodeArts permission plugin', () => {
  it('reports itself loaded, so a start without it fails', async () => {
    expect(existsSync(codeartsPluginReadyFile(stage()))).toBe(false)
    await loaded()
    expect(existsSync(codeartsPluginReadyFile(stage()))).toBe(true)
  })

  it('leaves Build to CodeArts’ own run mode, but never lets it edit a reference project', async () => {
    const { prompt, ask } = await loaded()
    await prompt('s', 'build')
    expect(await ask({ sessionID: 's', permission: 'bash', patterns: ['rm -rf build'] })).toBe('ask')
    expect(await ask({ sessionID: 's', permission: 'edit', patterns: ['src/a.ts'], metadata: { filepath: path.join(project, 'src', 'a.ts') } })).toBe('ask')
    expect(await ask({ sessionID: 's', permission: 'edit', patterns: [], metadata: { filepath: '/work/reference/a.ts' } })).toBe('deny')
    expect(await ask({ sessionID: 's', permission: 'external_directory_write', patterns: ['/vault/*'] })).toBe('deny')
  })

  it('lets the automatic agent work in its projects and refuses the rest rather than asking', async () => {
    const { prompt, ask } = await loaded()
    await prompt('s', CODEARTS_AGENTS.auto)
    expect(await ask({ sessionID: 's', permission: 'bash', patterns: ['npm test'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'edit', patterns: ['src/a.ts'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'external_directory', patterns: ['/work/other/*'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'external_directory_write', patterns: ['/work/other/src/*'] })).toBe('allow')
    // A reference project, an attachment and a pasted file are read, never written.
    expect(await ask({ sessionID: 's', permission: 'external_directory_read', patterns: ['/work/reference/*'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'external_directory', patterns: ['/antumi/attachments/image.png'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'external_directory_read', patterns: ['/antumi/pasted/a.txt'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'external_directory_write', patterns: ['/work/reference/*'] })).toBe('deny')
    expect(await ask({ sessionID: 's', permission: 'external_directory', patterns: ['/etc/*'] })).toBe('deny')
    // Its own project, named through a link to it, is its own.
    symlinkSync(project, path.join(root, 'linked'))
    expect(await ask({ sessionID: 's', permission: 'external_directory_write', patterns: [path.join(root, 'linked', 'new', 'e2e.txt')] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'read', patterns: ['.env'] })).toBe('deny')
    expect(await ask({ sessionID: 's', permission: 'read', patterns: ['config/.env.local'] })).toBe('deny')
    expect(await ask({ sessionID: 's', permission: 'read', patterns: ['.env.example'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'question', patterns: ['*'] })).toBe('deny')
    expect(await ask({ sessionID: 's', permission: 'blacklisted_bash', patterns: ['mkfs /dev/disk2'] })).toBe('deny')
  })

  it('keeps planning and read-only agents from editing or running anything, and lets bypass ask nothing', async () => {
    const { prompt, ask } = await loaded()
    for (const agent of [CODEARTS_AGENTS.plan, CODEARTS_AGENTS.readOnly]) {
      await prompt('s', agent)
      expect(await ask({ sessionID: 's', permission: 'bash', patterns: ['ls'] })).toBe('deny')
      expect(await ask({ sessionID: 's', permission: 'write', patterns: ['a.txt'] })).toBe('deny')
      expect(await ask({ sessionID: 's', permission: 'deleteFile', patterns: ['a.txt'] })).toBe('deny')
      expect(await ask({ sessionID: 's', permission: 'read', patterns: ['a.txt'] })).toBe('ask')
    }
    await prompt('s', CODEARTS_AGENTS.bypass)
    expect(await ask({ sessionID: 's', permission: 'bash', patterns: ['rm -rf /tmp/x'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'blacklisted_bash', patterns: ['rmdir /tmp/x'] })).toBe('allow')
    expect(await ask({ sessionID: 's', permission: 'edit', patterns: [], metadata: { filepath: '/work/reference/a.ts' } })).toBe('deny')
  })

  it('holds a subagent’s session to the mode of the agent that started it', async () => {
    const { prompt, ask } = await loaded()
    await prompt('parent', CODEARTS_AGENTS.readOnly)
    await prompt('child', 'general')
    expect(await ask({ sessionID: 'child', permission: 'bash', patterns: ['ls'] })).toBe('deny')
    expect(await ask({ sessionID: 'unknown', permission: 'edit', patterns: ['a.ts'] })).toBe('deny')
  })

  it('fences reference projects and a vault the stage may not write, and lets it read pasted files', () => {
    expect(codeartsRules(stage(), launch)).toEqual({
      ready: codeartsPluginReadyFile(stage()),
      writable: ['/work/other'],
      readable: ['/work/reference', '/vault', '/antumi/attachments/image.png', '/antumi/pasted'],
      fenced: ['/work/reference', '/vault']
    })
    expect(codeartsRules(stage(), { ...launch, knowledgeBase: { path: '/vault', write: true } })).toMatchObject({ writable: ['/work/other', '/vault'], fenced: ['/work/reference'] })
  })
})

describe('CodeArts config', () => {
  const config = (extra: Parameters<typeof codeartsConfig>[0] = {}, plugin?: string) => z.looseObject({ agent: z.record(z.string(), z.looseObject({ mode: z.string(), permission: z.record(z.string(), z.string()) })), plugin: z.array(z.string()).optional() }).parse(JSON.parse(codeartsConfig(extra, plugin)))

  it('adds Antumi’s agents, taking edit and command tools away from planning and read-only ones', () => {
    const parsed = config()
    expect(Object.keys(parsed.agent)).toEqual([CODEARTS_AGENTS.auto, CODEARTS_AGENTS.plan, CODEARTS_AGENTS.readOnly])
    for (const agent of [CODEARTS_AGENTS.plan, CODEARTS_AGENTS.readOnly]) expect(parsed.agent[agent]).toMatchObject({ mode: 'primary', permission: { edit: 'deny', write: 'deny', deleteFile: 'deny', bash: 'deny', task: 'deny' } })
    expect(parsed.plugin).toBeUndefined()
  })

  it('offers bypass only where the stage may bypass, and loads the plugin it is given', () => {
    expect(Object.keys(config({ allowBypass: true }).agent)).toContain(CODEARTS_AGENTS.bypass)
    expect(Object.keys(config({ allowBypass: true, readOnly: { dirs: ['/work'] } }).agent)).not.toContain(CODEARTS_AGENTS.bypass)
    expect(Object.keys(config({ allowBypass: true, planOnly: { dirs: ['/work'] } }).agent)).not.toContain(CODEARTS_AGENTS.bypass)
    expect(config({}, '/sessions/plugin.mjs').plugin).toEqual([pathToFileURL('/sessions/plugin.mjs').href])
  })
})
