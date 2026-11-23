import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentLaunch, AgentStage } from '../agent-adapter'
import { clearMcpReadyFile } from '../mcp-ready-file'

// The primary agents Antumi adds for its own modes, as CodeArts lists them for ACP.
export const CODEARTS_AGENTS = { auto: 'antumi-auto', plan: 'antumi-plan', readOnly: 'antumi-readonly', bypass: 'antumi-bypass' } as const

// What the plugin holds the session to: the folders it may write beside the project, those it may
// only read, those never edited whatever the mode, and the file it writes once loaded.
export type CodeartsRules = { ready: string; writable: string[]; readable: string[]; fenced: string[] }

type Stage = Pick<AgentStage, 'sessionsRoot' | 'conversationId' | 'stageId'>

export function codeartsPluginFile(stage: Stage): string {
  return path.join(stage.sessionsRoot, stage.conversationId, 'codearts', `antumi-permissions-${stage.stageId}.mjs`)
}

export function codeartsPluginReadyFile(stage: Stage): string {
  return path.join(stage.sessionsRoot, stage.conversationId, 'codearts', `antumi-permissions-${stage.stageId}.ready`)
}

// A readable entry is a file, or a folder's whole content written folder/** or folder/*.
const folderOf = (entry: string) => entry.replace(/[/\\]\*\*?$/, '')

export function codeartsRules(stage: Stage, launch: Pick<AgentLaunch, 'extraProjects' | 'references' | 'readable' | 'knowledgeBase'>): CodeartsRules {
  const vault = launch.knowledgeBase
  const fenced = [...(launch.references ?? []), ...(vault && !vault.write ? [vault.path] : [])]
  return {
    ready: codeartsPluginReadyFile(stage),
    writable: [...launch.extraProjects, ...(vault?.write ? [vault.path] : [])],
    readable: [...fenced, ...(launch.readable ?? []).map(folderOf)],
    fenced
  }
}

// CodeArts answers a permission request from its own run mode and whitelist, never from the rules
// of an agent its config defines, and allows every edit. Its plugins see each request first and
// may settle it, which is where Antumi's modes are kept. The plugin names a request's session
// mode from the last prompt a primary agent of Antumi's or Build took: a subagent's session runs
// for the one that started it, and the process holds one conversation at a time.
export function codeartsPluginSource(rules: CodeartsRules): string {
  return `import { mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'

const RULES = ${JSON.stringify(rules)}
const AGENTS = ${JSON.stringify(CODEARTS_AGENTS)}
const PRIMARY = new Set(['build', ...Object.values(AGENTS)])
const EDITS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit', 'deleteFile', 'external_directory_write'])
const OUTSIDE = new Set(['external_directory', 'external_directory_read', 'external_directory_write'])
// Commands its blacklist or sandbox flags as dangerous: the automatic agent refuses them.
const RISKY = new Set(['blacklisted_bash', 'sandbox_risk_command'])
const LOCKED = new Set([...EDITS, 'bash', 'task'])

// Real, through the nearest folder that exists: a file not written yet, under a folder behind a
// link (/tmp on macOS), is where that folder really is.
const real = (file) => {
  try { return realpathSync(file) } catch {}
  const parent = path.dirname(file)
  return parent === file ? file : path.join(real(parent), path.basename(file))
}
const roots = (list) => [...new Set(list.flatMap((dir) => [path.resolve(dir), real(path.resolve(dir))]))]
const within = (file, list) => list.some((root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
const EXTRA = roots(RULES.writable)
const READABLE = roots(RULES.readable)
const FENCED = roots(RULES.fenced)
const secret = (file) => /^\\.env(\\..+)?$/.test(path.basename(file)) && path.basename(file) !== '.env.example'

export const AntumiPermissions = async ({ directory, worktree }) => {
  const base = worktree && worktree !== '/' ? worktree : directory
  // The project the session works in is its to write, as the other projects are.
  const WRITABLE = [...EXTRA, ...roots([directory, base])]
  const sessions = new Map()
  let current = 'build'
  const targets = (input) => {
    const meta = input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
    const named = [meta.filepath, meta.filePath, ...(Array.isArray(input.patterns) ? input.patterns : [])]
    return named.filter((entry) => typeof entry === 'string' && entry).map((entry) => entry.replace(/[*?[{].*$/, '')).filter(Boolean).map((entry) => real(path.resolve(base, entry)))
  }
  const decide = (input) => {
    const mode = sessions.get(input.sessionID) ?? current
    const permission = String(input.permission ?? '')
    const files = targets(input)
    if (EDITS.has(permission) && files.some((file) => within(file, FENCED))) return 'deny'
    if (mode === AGENTS.bypass) return 'allow'
    if (mode === AGENTS.auto) {
      if (permission === 'question' || RISKY.has(permission)) return 'deny'
      if (OUTSIDE.has(permission)) {
        const write = permission === 'external_directory_write'
        return files.length && files.every((file) => within(file, WRITABLE) || (!write && within(file, READABLE))) ? 'allow' : 'deny'
      }
      if (permission === 'read' && files.some(secret)) return 'deny'
      return 'allow'
    }
    if ((mode === AGENTS.readOnly || mode === AGENTS.plan) && LOCKED.has(permission)) return 'deny'
    return undefined
  }
  await mkdir(path.dirname(RULES.ready), { recursive: true })
  await writeFile(RULES.ready, '')
  return {
    'chat.message': async (input) => {
      if (!input || !PRIMARY.has(input.agent)) return
      current = input.agent
      if (input.sessionID) sessions.set(input.sessionID, input.agent)
    },
    'permission.ask': async (input, output) => {
      const verdict = decide(input ?? {})
      if (verdict) output.status = verdict
    }
  }
}
`
}

// Written for one start, beside the conversation's other launch files; its ready file cleared, as
// one left from an earlier start would read as this one's.
export async function writeCodeartsPlugin(stage: Stage, launch: Pick<AgentLaunch, 'extraProjects' | 'references' | 'readable' | 'knowledgeBase'>): Promise<string> {
  const file = codeartsPluginFile(stage)
  await clearMcpReadyFile(codeartsPluginReadyFile(stage))
  await writeFile(file, codeartsPluginSource(codeartsRules(stage, launch)), { mode: 0o600 })
  return file
}
