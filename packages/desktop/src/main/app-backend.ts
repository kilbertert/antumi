import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreEndpoint } from '@antumi/protocol'
import { antumiPaths, readCoreEndpoint } from '@antumi/protocol/node'
import type { BackendLocation, BackendLocationState, BackendProblem } from '../shared/backend-location'
import { ensureBackend, replaceOldDaemon, stopBackendForInstall, type BackendStop } from './backend'
import { readBackendLocation, writeBackendLocation } from './backend-location'
import { readRemoteConfig, RemoteSession } from './remote-core'
import type { WslBackendArchive } from './wsl/wsl-backend'
import { listDistros } from './wsl/wsl-distros'
import { WslSession } from './wsl/wsl-session'
import { z } from 'zod'

// The backend this app talks to, wherever the user chose to run it: on this machine as ever, in a
// WSL distro (docs/WSL.md), or on a remote host over ssh (docs/REMOTE-CORE.md). A distro that will
// not start leaves the app on this machine's; a remote that will not is a problem to show, never
// a cue to run this machine's — the user's work belongs on the machine they named. The rest of
// main asks here rather than which of the three it is.

export type AppBackendOptions = {
  // The user's choice, beside the app's other preferences.
  locationFile: string
  // The browser host's file when core is not on this machine to read the usual one.
  privateHostFile: string
  version: string
  packaged: boolean
  platform: NodeJS.Platform
  resources: string
}

const Manifest = z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })

export class AppBackend {
  private chosen: BackendLocation = { kind: 'local' }
  private session: WslSession | RemoteSession | null = null
  private problem: BackendProblem | null = null
  private decided: Promise<void> | null = null
  private started: Promise<void> | null = null

  constructor(private readonly options: AppBackendOptions) {}

  // The archive pack-wsl-backend made, where the installer put it; null in a build without it.
  private async archive(): Promise<WslBackendArchive | null> {
    if (this.options.platform !== 'win32' || !this.options.packaged) return null
    const folder = join(this.options.resources, 'wsl')
    try {
      const manifest = Manifest.parse(JSON.parse(await readFile(join(folder, 'backend-linux-x64.json'), 'utf8')))
      return { file: join(folder, manifest.file), sha256: manifest.sha256 }
    } catch {
      return null
    }
  }

  // Starts the backend where the user chose, once. One in WSL that will not start leaves the app
  // on this machine's, and `state` saying why. One remote never reaches that fallback: silently
  // serving this machine's core is the failure remote mode exists to prevent.
  start(): Promise<void> {
    this.started ??= this.decide().then(() => {
      if (this.session || this.chosen.kind === 'remote') return undefined
      return ensureBackend()
    })
    return this.started
  }

  // Which backend this is: the one in WSL once it runs, the remote one once its link is up, else
  // this machine's.
  private decide(): Promise<void> {
    this.decided ??= (async () => {
      this.chosen = await readBackendLocation(this.options.locationFile)
      if (this.chosen.kind === 'remote') {
        const remote = readRemoteConfig()
        if (remote.kind === 'on') {
          const session = new RemoteSession(remote.config)
          this.problem = await session.start()
          if (!this.problem) {
            this.session = session
            return
          }
          console.error(`[antumi] the remote backend did not start: ${JSON.stringify(this.problem)}`)
          session.stop()
        } else {
          // Half-configured is an error to show, not "off": remote was chosen.
          this.problem = { kind: 'remote-config', detail: remote.kind === 'broken' ? remote.problem : 'remote.json is missing or unreadable' }
          console.error(`[antumi] remote is chosen but remote.json is not usable: ${this.problem.detail}`)
        }
        return
      }
      const archive = this.chosen.kind === 'wsl' ? await this.archive() : null
      if (this.chosen.kind !== 'wsl' || !archive) return
      const session = new WslSession({ distro: this.chosen.distro, version: this.options.version, archive })
      this.problem = await session.start()
      if (!this.problem) {
        this.session = session
        return
      }
      console.error(`[antumi] the backend in WSL (${this.chosen.distro}) did not start: ${JSON.stringify(this.problem)}`)
      session.stop()
    })()
    return this.decided
  }

  // Re-read on every call: core rewrites its endpoint with a new port/token on restart. Nothing
  // until it is known which backend this is: the renderer must not find this machine's core while
  // the chosen one is still starting — and never when remote was chosen and did not come up.
  async coreEndpoint(): Promise<CoreEndpoint | null> {
    await this.decide()
    if (this.session) return this.session.endpoint()
    if (this.chosen.kind === 'remote') return null
    return readCoreEndpoint()
  }

  async replaceOldDaemon(): Promise<void> {
    await this.decide()
    if (this.session) return this.session.replaceOldDaemon()
    if (this.chosen.kind === 'remote') return
    return replaceOldDaemon()
  }

  // Where the browser host says it listens. Core in WSL is told through the tunnel instead, and a
  // core of this machine, left running from before, must not find the host as its own — least of
  // all when remote was chosen, where no local core should answer at all.
  browserHostFile(): string {
    return this.session || this.chosen.kind === 'remote' ? this.options.privateHostFile : antumiPaths().browserHostFile
  }

  browserHostStarted(host: { port: number; token: string }): void {
    this.session?.setBrowserHost(host)
  }

  // Whether the remote host runs the backend: its files are core's, not this machine's to open.
  isRemote(): boolean {
    return this.chosen.kind === 'remote'
  }

  // Why a chosen remote is not up, for the banner that would otherwise just say "waiting for
  // core"; null once it is, and always for the other locations.
  remoteProblem(): string | null {
    const problem = this.problem
    return this.chosen.kind === 'remote' && problem && (problem.kind === 'remote-config' || problem.kind === 'remote-link') ? problem.detail : null
  }

  // What the installer needs stopped: this machine's daemon and core — or, when the backend is
  // remote, only the link to it, which is this app's own child. The far side is untouched either
  // way: replacing this app's files cannot disturb it.
  async stopForInstall(): Promise<BackendStop> {
    await this.decide()
    if (this.session instanceof RemoteSession) {
      this.session.stop()
      return { stopped: true }
    }
    return stopBackendForInstall()
  }

  // A path chosen on this machine as core names it; null for one core cannot reach.
  toBackendPath(path: string): string | null {
    return this.session ? this.session.linuxPath(path) : path
  }

  // A path core named as this machine opens it; null for one with no spelling here.
  fromBackendPath(path: string): string | null {
    return this.session ? this.session.windowsPath(path) : path
  }

  // Where a folder dialog opens when the renderer names no place: the distro's home, or the
  // system's own choice.
  dialogStart(): string | undefined {
    return this.session?.homeFolder() ?? undefined
  }

  async state(): Promise<BackendLocationState> {
    await this.decide()
    const supported = (await this.archive()) !== null
    const listed = supported ? await listDistros() : null
    const remote = readRemoteConfig()
    return {
      supported,
      chosen: this.chosen,
      // A remote that would not come up still reads remote: nothing else is serving, and the
      // problem says so — unlike WSL there is no fallback to report.
      running: this.session ? (this.session instanceof WslSession ? 'wsl' : 'remote') : this.chosen.kind === 'remote' ? 'remote' : 'local',
      distros: listed?.status === 'ok' ? listed.distros.map(({ name, version, isDefault }) => ({ name, version, isDefault })) : supported ? null : [],
      remote: remote.kind === 'off' ? null : remote.kind === 'on' ? { host: remote.config.sshHost, error: null } : { host: null, error: remote.problem },
      problem: this.problem
    }
  }

  // Kept for the next start: the app talks to one backend for as long as it runs.
  async choose(location: BackendLocation): Promise<void> {
    await writeBackendLocation(this.options.locationFile, location)
    this.chosen = location
  }

  // Lets go of the tunnel to a backend in WSL or over ssh; daemon and core run on wherever they are.
  stop(): void {
    this.session?.stop()
  }
}
