import type { CoreEndpoint } from '@antumi/protocol'
import type { WslBackendProblem } from '../../shared/backend-location'
import { ensureWslBackend, replaceOldWslDaemon, wslCoreEndpoint, type WslBackendArchive, type WslBackendPlace, type WslBackendStart } from './wsl-backend'
import { isDistroRunning } from './wsl-distros'
import { WslLink, type WslLinkEnds } from './wsl-link'
import { linuxPathForBackend, windowsPathForLinux, wslUncPath } from './wsl-paths'

// The app's side of a backend in a WSL distro, for as long as the app runs: started once, found
// again when it went (the distro was shut down), reached through the tunnel, and its Linux paths
// told from this machine's.

export type WslSessionOptions = { distro: string; version: string; archive: WslBackendArchive; log?: (line: string) => void }

// What a session runs through; tests stand theirs in.
export type WslSessionParts = {
  ensure(options: WslSessionOptions): Promise<WslBackendStart>
  coreEndpoint(place: WslBackendPlace): Promise<CoreEndpoint | null>
  replaceDaemon(place: WslBackendPlace, version: string): Promise<void>
  link(place: WslBackendPlace, log?: (line: string) => void): { connect(ends: WslLinkEnds): Promise<boolean>; corePort(): number | null; stop(): void }
  now(): number
}

const realParts: WslSessionParts = {
  ensure: (options) => ensureWslBackend(options),
  coreEndpoint: (place) => wslCoreEndpoint(place),
  // A check on a timer must not start a distro the user stopped: only one that runs is asked.
  replaceDaemon: async (place, version) => {
    if ((await isDistroRunning(place.distro)) === 'running') await replaceOldWslDaemon(place, version)
  },
  link: (place, log) => new WslLink(place, log ? { log } : {}),
  now: () => Date.now()
}

// Asking the distro costs a wsl.exe and a Node each time, and a renderer that lost core asks often.
const ENDPOINT_FRESH_MS = 3000
// A backend that will not start is not tried again sooner than this.
const RESTART_EVERY_MS = 20_000

export class WslSession {
  private place: WslBackendPlace | null = null
  private link: ReturnType<WslSessionParts['link']> | null = null
  private browserHost: WslLinkEnds['browserHost'] = null
  private known: { endpoint: CoreEndpoint; at: number } | null = null
  private starting: Promise<WslBackendProblem | null> | null = null
  private startedAt = 0
  private stopped = false

  constructor(private readonly options: WslSessionOptions, private readonly parts: WslSessionParts = realParts) {}

  get distro(): string {
    return this.place?.distro ?? this.options.distro
  }

  // Installs and starts the backend where it is not there yet. Null once core answers.
  start(): Promise<WslBackendProblem | null> {
    this.starting ??= this.begin().finally(() => { this.starting = null })
    return this.starting
  }

  private async begin(): Promise<WslBackendProblem | null> {
    this.startedAt = this.parts.now()
    const started = await this.parts.ensure(this.options)
    if (!started.ok) return started.problem
    if (this.stopped) return null
    this.place = started.place
    this.link ??= this.parts.link(started.place, this.options.log)
    this.known = { endpoint: started.endpoint, at: this.parts.now() }
    await this.join(started.endpoint)
    return null
  }

  private join(endpoint: CoreEndpoint): Promise<boolean> {
    return this.link?.connect({ corePort: endpoint.port, browserHost: this.browserHost }) ?? Promise.resolve(false)
  }

  // Core as this machine reaches it: its endpoint, with the tunnel's port here in place of its own
  // in the distro. Null while it cannot be reached; a core that went is started again by asking.
  async endpoint(): Promise<CoreEndpoint | null> {
    const place = this.place
    if (!place || this.stopped) return null
    const now = this.parts.now()
    let endpoint = this.known && now - this.known.at < ENDPOINT_FRESH_MS ? this.known.endpoint : await this.parts.coreEndpoint(place)
    if (!endpoint) {
      this.known = null
      if (now - this.startedAt >= RESTART_EVERY_MS) void this.start()
      return null
    }
    if (!this.known || this.known.endpoint !== endpoint) this.known = { endpoint, at: now }
    if (!(await this.join(endpoint))) return null
    const port = this.link?.corePort() ?? null
    return port === null ? null : { ...endpoint, port }
  }

  // The browser host once it listens here, which core then reaches through the tunnel.
  setBrowserHost(host: WslLinkEnds['browserHost']): void {
    this.browserHost = host
    if (this.known) void this.join(this.known.endpoint)
  }

  async replaceOldDaemon(): Promise<void> {
    if (this.place && !this.stopped) await this.parts.replaceDaemon(this.place, this.options.version)
  }

  // A path chosen on this machine as core names it; null for one the distro cannot reach.
  linuxPath(windowsPath: string): string | null {
    return linuxPathForBackend(this.distro, windowsPath)
  }

  // A path core named as this machine opens it, `~` being the distro's home; null for one with no
  // spelling here.
  windowsPath(linuxPath: string): string | null {
    const home = this.place?.home
    const absolute = home && (linuxPath === '~' || linuxPath.startsWith('~/')) ? `${home}${linuxPath.slice(1)}` : linuxPath
    return windowsPathForLinux(this.distro, absolute)
  }

  // Where a folder dialog starts: the distro's home, as Windows reaches it.
  homeFolder(): string | null {
    return this.place ? wslUncPath(this.place.distro, this.place.home) : null
  }

  // Lets go of the tunnel; daemon and core run on, as they do when a local app quits.
  stop(): void {
    this.stopped = true
    this.link?.stop()
    this.link = null
  }
}
