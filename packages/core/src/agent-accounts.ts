import { agentCliAccess } from './agent-cli-access'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  AGENT_KINDS, AgentAccountId, AgentKind, DEFAULT_ACCOUNT, accountsSupported, activeAccount, agentDescriptor, pickAccount, quotaVerdict, accountUsage,
  type AccountKey, type AgentAccount, type AgentAccounts, type AgentUsage, type Terminal
} from '@antumi/protocol'
import { planLaunch, readJsonIfExists, writePrivateJson } from '@antumi/protocol/node'
import { adapterOf } from './agents'
import type { AccountSupport } from './agents/agent-adapter'
import type { CredentialStore } from './credential-store'
import { Rejection } from './rejection'

// What the file keeps of an account; whether it is signed in is read again at each load.
const Saved = z.object({
  id: AgentAccountId,
  agent: AgentKind,
  label: z.string().nullable(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  createdAt: z.number(),
  // An account that signs in with an API key, for this edition; its key is in the credential store.
  edition: z.string().nullable().optional()
})
type Saved = z.infer<typeof Saved>
const SavedFile = z.object({
  version: z.literal(1),
  accounts: z.array(Saved),
  active: z.partialRecord(AgentKind, AgentAccountId),
  autoSwitch: z.boolean()
})

const LOGOUT_TIMEOUT_MS = 30_000

export type AccountDeps = {
  // Signs in, in a terminal the user follows.
  signIn(argv: { command: string; args: readonly string[] }, env: Record<string, string>, title: string, agent?: AgentKind, cwd?: string): Promise<Terminal>
  waitForExit(terminalId: string): Promise<number | null>
  // An account was signed in, or out, or removed: its usage is worth reading now, or no more.
  accountChanged(agent: AgentKind, id: string, removed: boolean): void
  changed(accounts: AgentAccounts): void
  newId?(): string
  // Runs the CLI's sign-out to its end, whatever it says.
  signOut?(command: string, args: readonly string[], env: Record<string, string>): Promise<void>
  // Where an account's API key is kept, never in the accounts file.
  credentials?: Pick<CredentialStore, 'get' | 'set' | 'delete'>
}

const KEY_CREDENTIAL = 'agent-account'
const keyInstance = (agent: AgentKind, id: string) => `${agent}/${id}`

// What an agent's process starts on: the account, and the variables pointing it at its folder
// (none for the user's own).
export type AccountLaunch = { id: string; env: Record<string, string> | null }

// The edition a key is for, as the agent's descriptor names it.
function keyEdition(agent: AgentKind, edition: string): string {
  const editions = agentDescriptor(agent).accountKeys?.editions ?? []
  if (!editions.some((each) => each.id === edition)) throw new Rejection('account-key-unsupported', `${agentDescriptor(agent).label} 没有这个版本：${edition}`)
  return edition
}

function support(agent: AgentKind): AccountSupport {
  const accounts = adapterOf(agent).accounts
  if (!accountsSupported(agent) || !accounts) throw new Rejection('account-unsupported', `${agentDescriptor(agent).label} 不支持多账号`)
  return accounts
}

// The agents' accounts (Settings → Agent → 账号): the list in one file, each account but the user's
// own in a folder under `root`, named by its id and never moved, since Claude Code keys its sign-in
// by the folder's exact path. Changes run one at a time.
export class AgentAccountStore {
  private saved: Saved[] = []
  private active: Partial<Record<AgentKind, string>> = {}
  private autoSwitch = true
  private readonly signedIn = new Map<string, boolean>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly root: string,
    private readonly deps: AccountDeps
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.file)
      const parsed = raw === undefined ? null : SavedFile.safeParse(raw)
      if (parsed && !parsed.success) console.error(`[antumi-core] ${this.file} is not a list of accounts; ignoring it until one is saved`)
      if (parsed?.success) ({ accounts: this.saved, active: this.active, autoSwitch: this.autoSwitch } = parsed.data)
    } catch (error) {
      console.error(`[antumi-core] cannot read ${this.file}:`, error instanceof Error ? error.message : error)
    }
    await Promise.all(this.list().accounts.map((account) => this.check(account.agent, account.id)))
  }

  list(): AgentAccounts {
    const accounts = AGENT_KINDS.filter(accountsSupported).flatMap((agent) => {
      const own = this.saved.find((each) => each.agent === agent && each.id === DEFAULT_ACCOUNT)
      return [own ?? { id: DEFAULT_ACCOUNT, agent, label: null, email: null, plan: null, createdAt: 0 }, ...this.saved.filter((each) => each.agent === agent && each.id !== DEFAULT_ACCOUNT)]
    })
    return {
      accounts: accounts.map((account): AgentAccount => ({ ...account, signedIn: this.signedIn.get(key(account.agent, account.id)) ?? false })),
      active: Object.fromEntries(AGENT_KINDS.filter(accountsSupported).map((agent) => [agent, this.activeOf(agent)])),
      autoSwitch: this.autoSwitch
    }
  }

  autoSwitching(): boolean {
    return this.autoSwitch
  }

  activeOf(agent: AgentKind): string {
    const id = activeAccount({ active: this.active }, agent)
    return this.find(agent, id) ? id : DEFAULT_ACCOUNT
  }

  // The folder an account runs in; undefined for the user's own.
  home(agent: AgentKind, id: string): string | undefined {
    return id === DEFAULT_ACCOUNT ? undefined : path.join(this.root, agent, id)
  }

  // Where the agent's next process runs, its folder readied; null for an agent without accounts.
  async launch(agent: AgentKind, picked?: string): Promise<AccountLaunch | null> {
    const accounts = adapterOf(agent).accounts
    if (!accountsSupported(agent) || !accounts) return null
    const id = picked ?? this.activeOf(agent)
    this.require(agent, id)
    const home = this.home(agent, id)
    if (!home) return { id, env: null }
    await accounts.prepare(home)
    return { id, env: { ...accounts.env(home), ...this.keyEnv(agent, id, accounts) } }
  }

  // An API key account's variables; nothing for one signed in in a terminal.
  private keyEnv(agent: AgentKind, id: string, accounts: AccountSupport): Record<string, string> {
    const edition = this.find(agent, id)?.edition
    if (!edition) return {}
    const apiKey = this.deps.credentials?.get(KEY_CREDENTIAL, keyInstance(agent, id))?.payload.apiKey
    if (!apiKey || !accounts.keys) throw new Rejection('account-key-missing', '这个账号没有 API Key，请在设置 → 账号里重新填写')
    return accounts.keys(apiKey, edition)
  }

  // Whether it is one of the agent's accounts: a conversation may keep one that was removed since.
  exists(agent: AgentKind, id: string): boolean {
    return this.find(agent, id) !== null
  }

  // Usage also reads the user's own login for agents without managed accounts.
  homes(): Array<{ agent: AgentKind; id: string; home: string | undefined }> {
    const accounts = this.list().accounts
    return AGENT_KINDS.flatMap((agent) => accountsSupported(agent)
      ? accounts.filter((account) => account.agent === agent).map((account) => ({ agent, id: account.id, home: this.home(agent, account.id) }))
      : [{ agent, id: DEFAULT_ACCOUNT, home: undefined }])
  }

  async refreshIdentity(agent: AgentKind, id: string): Promise<void> {
    // Usage also polls the user's own login of agents without accounts, which has no identity to refresh.
    if (!accountsSupported(agent)) return
    this.require(agent, id)
    await this.check(agent, id)
  }

  // With a key, signed in with it at once; without, in a terminal, unless the agent takes only keys.
  async add(agent: AgentKind, label: string | null, given?: AccountKey): Promise<{ account: AgentAccount; terminal?: Terminal }> {
    const accounts = support(agent)
    const keys = agentDescriptor(agent).accountKeys
    if (given && !(keys && accounts.keys)) throw new Rejection('account-key-unsupported', `${agentDescriptor(agent).label} 不支持 API Key 账号`)
    if (!given && keys?.only) throw new Rejection('account-key-required', `${agentDescriptor(agent).label} 的其他账号要用 API Key 添加`)
    const edition = given ? keyEdition(agent, given.edition) : null
    return this.serially(async () => {
      const id = this.deps.newId?.() ?? randomBytes(4).toString('hex')
      const home = this.home(agent, id)!
      await accounts.prepare(home)
      if (given) await this.saveKey(agent, id, given.apiKey)
      await this.write([...this.saved, { id, agent, label: label || null, email: null, plan: null, createdAt: Date.now(), ...(edition ? { edition } : {}) }])
      if (given) {
        this.signedIn.set(key(agent, id), true)
        this.deps.changed(this.list())
        this.deps.accountChanged(agent, id, false)
        return { account: this.require(agent, id) }
      }
      const terminal = await this.signIn(agent, id)
      return { account: this.require(agent, id), terminal }
    })
  }

  async setKey(agent: AgentKind, id: string, given: AccountKey): Promise<AgentAccount> {
    support(agent)
    const edition = keyEdition(agent, given.edition)
    return this.serially(async () => {
      const current = this.require(agent, id)
      if (!current.edition) throw new Rejection('account-key-unsupported', '这个账号在终端里登录，不用 API Key')
      await this.saveKey(agent, id, given.apiKey)
      this.signedIn.set(key(agent, id), true)
      await this.write(this.upsert({ ...this.find(agent, id)!, edition }))
      this.deps.accountChanged(agent, id, false)
      return this.require(agent, id)
    })
  }

  private async saveKey(agent: AgentKind, id: string, apiKey: string): Promise<void> {
    if (!this.deps.credentials) throw new Rejection('account-key-unsupported', '无法保存 API Key')
    await this.deps.credentials.set(KEY_CREDENTIAL, keyInstance(agent, id), { kind: 'api-key', payload: { apiKey }, account: null, updatedAt: Date.now() })
  }

  async login(agent: AgentKind, id: string): Promise<Terminal> {
    const accounts = support(agent)
    this.require(agent, id)
    const home = this.home(agent, id)
    if (home) await accounts.prepare(home)
    return this.signIn(agent, id)
  }

  async rename(agent: AgentKind, id: string, label: string | null): Promise<AgentAccount> {
    support(agent)
    return this.serially(async () => {
      const current = this.require(agent, id)
      await this.write(this.upsert({ ...current, label: label || null }))
      return this.require(agent, id)
    })
  }

  // Signs it out, so its keychain item goes too, then drops its folder: its links first, which
  // lead into the user's own folder.
  async remove(agent: AgentKind, id: string): Promise<void> {
    const accounts = support(agent)
    if (id === DEFAULT_ACCOUNT) throw new Rejection('account-default', '本机账号不能删除')
    return this.serially(async () => {
      this.require(agent, id)
      const home = this.home(agent, id)!
      // A key account has nothing signed in to sign out of: its key goes instead.
      if (this.find(agent, id)?.edition) await this.deps.credentials?.delete(KEY_CREDENTIAL, keyInstance(agent, id))
      else await agentCliAccess.use(agent, () => (this.deps.signOut ?? runQuietly)(agentDescriptor(agent).cli, accounts.logout, accounts.env(home)))
      const active = { ...this.active }
      if (active[agent] === id) delete active[agent]
      this.active = active
      await this.write(this.saved.filter((each) => !(each.agent === agent && each.id === id)))
      for (const name of await readdir(home).catch(() => [])) {
        const entry = path.join(home, name)
        if ((await lstat(entry)).isSymbolicLink()) await unlink(entry)
      }
      await rm(home, { recursive: true, force: true })
      this.signedIn.delete(key(agent, id))
      this.deps.accountChanged(agent, id, true)
    })
  }

  async activate(agent: AgentKind, id: string): Promise<AgentAccounts> {
    support(agent)
    this.require(agent, id)
    await this.setActive(agent, id)
    return this.list()
  }

  // Takes effect at once, for whatever starts next; the file follows.
  private setActive(agent: AgentKind, id: string): Promise<void> {
    if (this.activeOf(agent) === id) return Promise.resolve()
    this.active = { ...this.active, [agent]: id }
    return this.serially(() => this.write(this.saved))
  }

  async setAutoSwitch(autoSwitch: boolean): Promise<AgentAccounts> {
    return this.serially(async () => {
      this.autoSwitch = autoSwitch
      await this.write(this.saved)
      return this.list()
    })
  }

  // An account ran out: with auto-switch on, the agent moves to the next with quota, unless it has
  // moved off that account already. The account it is on afterwards, or null where it stays.
  switchFrom(agent: AgentKind, spent: string, usage: readonly AgentUsage[], now: number): string | null {
    if (!this.autoSwitch || !accountsSupported(agent)) return null
    const current = this.activeOf(agent)
    if (current !== spent && quotaVerdict(accountUsage(usage, agent, current), now).state !== 'exhausted') return current
    const next = pickAccount(this.list().accounts, usage, agent, spent, now)
    if (!next) return null
    this.setActive(agent, next.id).catch((error: unknown) => console.error('[antumi-core] cannot save the active account', error))
    return next.id
  }

  // A reading came in: an active account found spent moves its agent on, as a limit hit would.
  observeUsage(usage: readonly AgentUsage[], now: number): void {
    if (!this.autoSwitch) return
    for (const agent of AGENT_KINDS.filter(accountsSupported)) {
      const current = this.activeOf(agent)
      if (quotaVerdict(accountUsage(usage, agent, current), now).state === 'exhausted') this.switchFrom(agent, current, usage, now)
    }
  }

  // The plan a reading names, kept for when the account is not being read.
  notePlan(agent: AgentKind, id: string, plan: string | null): void {
    const current = this.find(agent, id)
    if (!current || !plan || current.plan === plan) return
    void this.serially(() => this.write(this.upsert({ ...current, plan }))).catch(() => {})
  }

  private async signIn(agent: AgentKind, id: string): Promise<Terminal> {
    const accounts = support(agent)
    if (this.find(agent, id)?.edition) throw new Rejection('account-key-unsupported', '这个账号用 API Key 登录，请在设置 → 账号里更换 Key')
    const home = this.home(agent, id)
    const name = this.require(agent, id)
    const title = `登录 ${agentDescriptor(agent).label}${name.label ? `（${name.label}）` : ''}`
    const folder = accounts.signInFolder ? path.join(this.root, agent, '.sign-in') : undefined
    if (folder) await mkdir(folder, { recursive: true, mode: 0o700 })
    const terminal = await agentCliAccess.use(agent, () => this.deps.signIn({ command: agentDescriptor(agent).cli, args: accounts.login }, home ? accounts.env(home) : {}, title, agent, folder))
    void this.deps.waitForExit(terminal.id).then(() => this.check(agent, id)).then(() => this.deps.accountChanged(agent, id, false))
    return terminal
  }

  async refresh(agent: AgentKind): Promise<void> {
    await Promise.all(this.list().accounts.filter((account) => account.agent === agent).map((account) => this.check(agent, account.id)))
  }

  // Reads again whether the account is signed in and as whom.
  private async check(agent: AgentKind, id: string): Promise<void> {
    if (agentCliAccess.blocked(agent)) return
    return agentCliAccess.use(agent, () => this.checkIdentity(agent, id))
  }

  private async checkIdentity(agent: AgentKind, id: string): Promise<void> {
    const adapter = adapterOf(agent)
    const home = this.home(agent, id)
    // Unknown keeps what was last known: a failed check is no sign-out.
    const known = this.signedIn.get(key(agent, id)) ?? false
    const keyed = this.find(agent, id)?.edition
    const signedIn = keyed ? Boolean(this.deps.credentials?.get(KEY_CREDENTIAL, keyInstance(agent, id))) : adapter.signedIn ? await adapter.signedIn(home).catch(() => null) ?? known : false
    const { email } = await adapter.accounts?.identity(home).catch(() => ({ email: null })) ?? { email: null }
    const current = this.find(agent, id)
    const changed = this.signedIn.get(key(agent, id)) !== signedIn
    this.signedIn.set(key(agent, id), signedIn)
    if (current && email && current.email !== email) {
      await this.serially(() => this.write(this.upsert({ ...current, email }))).catch(() => {})
    } else if (changed) {
      this.deps.changed(this.list())
    }
  }

  private find(agent: AgentKind, id: string): Saved | null {
    if (!accountsSupported(agent)) return null
    return this.saved.find((each) => each.agent === agent && each.id === id) ??
      (id === DEFAULT_ACCOUNT ? { id, agent, label: null, email: null, plan: null, createdAt: 0 } : null)
  }

  private require(agent: AgentKind, id: string): AgentAccount {
    if (!this.find(agent, id)) throw new Rejection('account-unknown', '没有这个账号')
    return this.list().accounts.find((each) => each.agent === agent && each.id === id)!
  }

  // The list with this account in, the user's own included once something is kept of it.
  private upsert(account: Saved): Saved[] {
    const known = this.saved.some((each) => each.agent === account.agent && each.id === account.id)
    return known ? this.saved.map((each) => (each.agent === account.agent && each.id === account.id ? account : each)) : [account, ...this.saved]
  }

  private serially<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.catch(() => {}).then(action)
    this.chain = result
    return result
  }

  private async write(accounts: Saved[]): Promise<void> {
    await writePrivateJson(this.file, { version: 1, accounts, active: this.active, autoSwitch: this.autoSwitch })
    this.saved = accounts
    this.deps.changed(this.list())
  }
}

function key(agent: AgentKind, id: string): string {
  return `${agent}/${id}`
}

// The CLI's sign-out, which may find nothing to sign out of: whatever it says, the folder goes.
function runQuietly(command: string, args: readonly string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    try {
      const launch = planLaunch(command, [...args], process.cwd(), { ...process.env, ...env })
      execFile(launch.file, launch.args, { env: launch.env, timeout: LOGOUT_TIMEOUT_MS, windowsHide: true }, () => resolve())
    } catch {
      resolve()
    }
  })
}
