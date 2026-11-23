import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccounts, AgentUsage, Terminal } from '@antumi/protocol'
import { AgentAccountStore } from './agent-accounts'
import type { CredentialRecord } from './credential-store'
import { UsageService } from './usage-service'
import type { UsageReading } from './usage-source'

const NOW = 1_790_000_000_000

const usage = (account: string, usedPercent: number): AgentUsage => ({
  agent: 'claude', account, status: 'ok', plan: null, error: null, updatedAt: NOW, resetCredits: null,
  windows: [{ kind: 'session', model: null, usedPercent, windowMinutes: 300, resetsAt: NOW + 3_600_000 }]
})

describe('AgentAccountStore', () => {
  let root: string
  let own: string
  let signIns: Array<{ command: string; args: readonly string[]; env: Record<string, string> }>
  let exits: Array<() => void>
  let changes: AgentAccounts[]
  let touched: Array<[string, string, boolean]>
  let ids: string[]
  let bin: string
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }

  const store = () => new AgentAccountStore(path.join(root, 'agent-accounts.json'), path.join(root, 'agent-accounts'), {
    signIn: async (argv, env) => {
      signIns.push({ ...argv, env })
      return { id: `t${signIns.length}` } as unknown as Terminal
    },
    waitForExit: () => new Promise((resolve) => exits.push(() => resolve(0))),
    accountChanged: (agent, id, removed) => touched.push([agent, id, removed]),
    changed: (accounts) => changes.push(accounts),
    newId: () => ids.shift() ?? 'extra',
    signOut: async () => {}
  })

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-accounts-'))
    own = path.join(root, 'own-claude')
    mkdirSync(own, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = own
    process.env.CODEX_HOME = path.join(root, 'own-codex')
    // No CLI of the machine's own speaks for an account here.
    bin = path.join(root, 'bin')
    mkdirSync(bin)
    vi.stubEnv('PATH', bin)
    signIns = []
    exits = []
    changes = []
    touched = []
    ids = ['work', 'spare']
  })

  afterEach(() => {
    for (const [name, value] of [['CLAUDE_CONFIG_DIR', saved.claude], ['CODEX_HOME', saved.codex]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('lists the user’s own account of each agent that has accounts, active until another is picked', async () => {
    const accounts = store()
    await accounts.load()
    expect(accounts.list()).toMatchObject({
      accounts: [{ id: 'default', agent: 'claude', signedIn: false }, { id: 'default', agent: 'codex', signedIn: false }, { id: 'default', agent: 'codebuddy' }],
      active: { claude: 'default', codex: 'default', codebuddy: 'default' },
      autoSwitch: true
    })
    expect(await accounts.launch('claude')).toEqual({ id: 'default', env: null })
    expect(await accounts.launch('cursor')).toBeNull()
  })

  it('adds CodeBuddy’s other accounts as API keys, kept in the credential store and run in a folder of their own', async () => {
    const codebuddyOwn = path.join(root, 'own-codebuddy')
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', codebuddyOwn)
    vi.stubEnv('CODEBUDDY_INTERNET_ENVIRONMENT', 'internal')
    const kept = new Map<string, CredentialRecord>()
    const credentials = {
      get: (provider: string, instance: string) => kept.get(`${provider}/${instance}`) ?? null,
      set: async (provider: string, instance: string, record: CredentialRecord) => { kept.set(`${provider}/${instance}`, record) },
      delete: async (provider: string, instance: string) => { kept.delete(`${provider}/${instance}`) }
    }
    const signOuts: string[] = []
    const signInFolders: Array<[string, string | undefined]> = []
    const keyed = () => new AgentAccountStore(path.join(root, 'agent-accounts.json'), path.join(root, 'agent-accounts'), {
      signIn: async (argv, _env, _title, _agent, cwd) => { signInFolders.push([argv.command, cwd]); return { id: 'sign-in' } as unknown as Terminal }, waitForExit: async () => 0, accountChanged: (agent, id, removed) => touched.push([agent, id, removed]),
      changed: (accounts) => changes.push(accounts), newId: () => ids.shift() ?? 'extra', signOut: async (command) => { signOuts.push(command) }, credentials
    })
    const accounts = keyed()
    await accounts.load()
    await expect(accounts.add('codebuddy', 'CN', undefined)).rejects.toMatchObject({ reason: 'account-key-required' })
    await expect(accounts.add('claude', 'x', { apiKey: 'k', edition: 'china' })).rejects.toMatchObject({ reason: 'account-key-unsupported' })
    await expect(accounts.add('codebuddy', 'CN', { apiKey: 'k', edition: 'mars' })).rejects.toMatchObject({ reason: 'account-key-unsupported' })
    const added = await accounts.add('codebuddy', 'CN', { apiKey: 'cn-key', edition: 'china' })
    expect(added).toEqual({ account: expect.objectContaining({ id: 'work', agent: 'codebuddy', label: 'CN', edition: 'china', signedIn: true }) })
    expect(readFileSync(path.join(root, 'agent-accounts.json'), 'utf8')).not.toContain('cn-key')
    const home = path.join(root, 'agent-accounts', 'codebuddy', 'work')
    expect(await accounts.launch('codebuddy', 'work')).toEqual({ id: 'work', env: { CODEBUDDY_CONFIG_DIR: home, CODEBUDDY_API_KEY: 'cn-key', CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } })
    // Its sessions are the user's own, so a conversation moved to it resumes there.
    expect(existsSync(path.join(codebuddyOwn, 'projects'))).toBe(true)
    expect(realpathSync(path.join(home, 'projects'))).toBe(realpathSync(path.join(codebuddyOwn, 'projects')))
    // The international edition clears an edition the user's shell would otherwise pass on.
    await accounts.setKey('codebuddy', 'work', { apiKey: 'intl-key', edition: 'international' })
    expect((await accounts.launch('codebuddy', 'work'))?.env).toMatchObject({ CODEBUDDY_API_KEY: 'intl-key', CODEBUDDY_INTERNET_ENVIRONMENT: '' })
    await expect(accounts.login('codebuddy', 'work')).rejects.toMatchObject({ reason: 'account-key-unsupported' })
    // The user's own signs in in its CLI, started in an empty folder rather than the home one it warns of.
    await accounts.login('codebuddy', 'default')
    expect(signInFolders).toEqual([['codebuddy', path.join(root, 'agent-accounts', 'codebuddy', '.sign-in')]])
    expect(existsSync(path.join(root, 'agent-accounts', 'codebuddy', '.sign-in'))).toBe(true)
    await expect(accounts.setKey('codebuddy', 'default', { apiKey: 'k', edition: 'china' })).rejects.toMatchObject({ reason: 'account-key-unsupported' })
    const reloaded = keyed()
    await reloaded.load()
    expect(reloaded.list().accounts.find((account) => account.agent === 'codebuddy' && account.id === 'work')).toMatchObject({ signedIn: true, edition: 'international' })
    kept.clear()
    await expect(reloaded.launch('codebuddy', 'work')).rejects.toMatchObject({ reason: 'account-key-missing' })
    await reloaded.remove('codebuddy', 'work')
    expect(signOuts).toEqual([])
    expect(existsSync(home)).toBe(false)
    expect(existsSync(path.join(codebuddyOwn, 'projects'))).toBe(true)
  })

  it('keeps polling Cursor’s own usage alongside managed accounts and after one is removed', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', 'Work')
    let now = NOW
    const claude = vi.fn(async (_home?: string): Promise<UsageReading> => ({ signedIn: true, windows: [], plan: 'max' }))
    const cursor = vi.fn(async (): Promise<UsageReading> => ({
      signedIn: true, plan: 'Pro', windows: [{ kind: 'monthly', model: null, usedPercent: 42, windowMinutes: 43_200, resetsAt: null }]
    }))
    const service = new UsageService({ claude, cursor }, () => {}, () => now, {}, () => accounts.homes())
    await service.refresh()
    expect(claude.mock.calls).toEqual([[undefined], [path.join(root, 'agent-accounts', 'claude', 'work')]])
    expect(cursor).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(service.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'claude', account: 'default', status: 'ok' }),
      expect.objectContaining({ agent: 'claude', account: 'work', status: 'ok' }),
      expect.objectContaining({ agent: 'cursor', account: 'default', status: 'ok', windows: [expect.objectContaining({ kind: 'monthly', usedPercent: 42 })] })
    ]))
    expect(accounts.list().accounts.some((account) => account.agent === 'cursor')).toBe(false)

    await accounts.remove('claude', 'work')
    now += 30_000
    await service.refresh()
    expect(cursor).toHaveBeenCalledTimes(2)
    expect(service.list().map((entry) => [entry.agent, entry.account])).toEqual([['claude', 'default'], ['cursor', 'default']])
  })

  it('adds an account by signing in, in its own folder, and reads who signed in once the terminal ends', async () => {
    const accounts = store()
    await accounts.load()
    const { account } = await accounts.add('claude', 'Work')
    const home = path.join(root, 'agent-accounts', 'claude', 'work')
    expect(account).toMatchObject({ id: 'work', label: 'Work', signedIn: false })
    expect(signIns).toEqual([{ command: 'claude', args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: home } }])
    expect(existsSync(path.join(home, 'projects'))).toBe(true)
    writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }))
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.com' } }))
    exits.shift()?.()
    await vi.waitFor(() => expect(touched).toEqual([['claude', 'work', false]]))
    expect(accounts.list().accounts.find((each) => each.id === 'work')).toMatchObject({ signedIn: true, email: 'me@work.com' })
  })

  it('keeps a sign-in it cannot check, and drops one Claude Code says is gone', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', 'Work')
    const home = path.join(root, 'agent-accounts', 'claude', 'work')
    writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }))
    exits.shift()?.()
    await vi.waitFor(() => expect(touched).toEqual([['claude', 'work', false]]))
    const signedIn = () => accounts.list().accounts.find((each) => each.id === 'work')?.signedIn
    rmSync(path.join(home, '.credentials.json'))
    await accounts.refreshIdentity('claude', 'work')
    expect(signedIn()).toBe(true)
    writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.stdout.write('{"loggedIn":false}'); process.exit(1)`, { mode: 0o755 })
    await accounts.refreshIdentity('claude', 'work')
    expect(signedIn()).toBe(false)
  })

  it('starts the agent in the active account’s folder, and keeps the pick across a restart', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', null)
    await accounts.activate('claude', 'work')
    const home = path.join(root, 'agent-accounts', 'claude', 'work')
    expect(await accounts.launch('claude')).toEqual({ id: 'work', env: { CLAUDE_CONFIG_DIR: home } })
    const again = store()
    await again.load()
    expect(again.activeOf('claude')).toBe('work')
    await expect(again.activate('claude', 'nope')).rejects.toMatchObject({ reason: 'account-unknown' })
  })

  it('moves an agent off a spent account to the one with the most room, and only once', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', null)
    await accounts.add('claude', null)
    // Signed in, as a finished sign-in would find them.
    for (const id of ['work', 'spare']) writeFileSync(path.join(root, 'agent-accounts', 'claude', id, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }))
    exits.splice(0).forEach((exit) => exit())
    await vi.waitFor(() => expect(touched).toHaveLength(2))
    const readings = [usage('default', 100), usage('work', 70), usage('spare', 20)]
    expect(accounts.switchFrom('claude', 'default', readings, NOW)).toBe('spare')
    expect(accounts.activeOf('claude')).toBe('spare')
    // Another conversation hitting the same limit finds the agent moved already.
    expect(accounts.switchFrom('claude', 'default', readings, NOW)).toBe('spare')
    await accounts.setAutoSwitch(false)
    expect(accounts.switchFrom('claude', 'spare', [...readings, usage('spare', 100)], NOW)).toBeNull()
  })

  it('removes an account, its links and folder, never what they lead to, and falls back to the user’s own', async () => {
    const accounts = store()
    await accounts.load()
    await accounts.add('claude', null)
    await accounts.activate('claude', 'work')
    writeFileSync(path.join(own, 'projects', 'kept.jsonl'), '{}')
    await accounts.remove('claude', 'work')
    expect(existsSync(path.join(root, 'agent-accounts', 'claude', 'work'))).toBe(false)
    expect(existsSync(path.join(own, 'projects', 'kept.jsonl'))).toBe(true)
    expect(accounts.activeOf('claude')).toBe('default')
    expect(touched.at(-1)).toEqual(['claude', 'work', true])
    await expect(accounts.remove('claude', 'default')).rejects.toMatchObject({ reason: 'account-default' })
  })
})
