import type { ChildProcess } from 'node:child_process'
import { BROWSER_HOST_PROTOCOL_VERSION, connectTunnelHelper, type TunnelHelperLink } from '@antumi/protocol/node'
import type { WslBackendPlace } from './wsl-backend'
import { nodeWslHost, spawnInDistro, type WslHost } from './wsl-command'

// The loopback connections between the app and a backend in a WSL distro, carried over the stdio
// of one tunnel helper there (docs/WSL.md, 连接): core reaches the browser host through it, and
// the UI reaches core through it where Windows' 127.0.0.1 does not get into the distro.

// What the tunnel joins: core's port in the distro, and the browser host's here once it is up.
export type WslLinkEnds = { corePort: number; browserHost: { port: number; token: string } | null }

export type WslLinkOptions = {
  host?: WslHost
  log?: (line: string) => void
  // How long after the helper went before it is started again; doubles up to a minute.
  retryMs?: number
}

const sameEnds = (a: WslLinkEnds | null, b: WslLinkEnds) =>
  a !== null && a.corePort === b.corePort && a.browserHost?.port === b.browserHost?.port && a.browserHost?.token === b.browserHost?.token

export class WslLink {
  private ends: WslLinkEnds | null = null
  private child: ChildProcess | null = null
  private link: TunnelHelperLink | null = null
  private retry: NodeJS.Timeout | null = null
  private failures = 0
  // Counts starts, so what an earlier helper reports late is told from the current one's.
  private run = 0
  private stopped = false

  constructor(private readonly place: WslBackendPlace, private readonly options: WslLinkOptions = {}) {}

  // The port on this machine that reaches core through the tunnel; null while it is down.
  corePort(): number | null {
    return this.link?.localPort ?? null
  }

  // Brings the tunnel to these ends, leaving one that already joins them as it is. A helper that
  // goes is started again by itself; false when this start did not come up.
  async connect(ends: WslLinkEnds): Promise<boolean> {
    if (this.stopped) return false
    if (sameEnds(this.ends, ends) && this.link) return true
    this.ends = ends
    this.drop()
    const run = ++this.run
    const log = this.options.log ?? ((line: string) => console.error(line))
    let child: ChildProcess
    try {
      child = spawnInDistro(this.place.distro, [this.place.node, `${this.place.dir}/wsl-tunnel.mjs`], { host: this.options.host ?? nodeWslHost })
    } catch (error) {
      log(`[antumi] the WSL tunnel did not start: ${String(error)}`)
      this.again(run)
      return false
    }
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString().trimEnd()))
    child.on('error', (error) => log(`[antumi] the WSL tunnel: ${String(error)}`))
    if (!child.stdout || !child.stdin) return false
    try {
      const link = await connectTunnelHelper({
        fromHelper: child.stdout,
        toHelper: child.stdin,
        config: {
          dial: { port: ends.corePort },
          // The file core reads to find the browser host, naming the helper's port in its place.
          ...(ends.browserHost ? { listen: { endpointFile: `${this.place.home}/.antumi/browser/host.json`, endpoint: { token: ends.browserHost.token, protocolVersion: BROWSER_HOST_PROTOCOL_VERSION } } } : {})
        },
        ...(ends.browserHost ? { appPort: ends.browserHost.port } : {})
      })
      if (run !== this.run) {
        link.close()
        child.kill()
        return false
      }
      this.link = link
      this.failures = 0
      void link.closed.then((reason) => {
        if (run !== this.run) return
        if (reason) log(`[antumi] the WSL tunnel broke: ${reason.message}`)
        this.drop()
        this.again(run)
      })
      return true
    } catch (error) {
      if (run !== this.run) return false
      log(`[antumi] the WSL tunnel did not come up: ${String(error)}`)
      this.drop()
      this.again(run)
      return false
    }
  }

  // The helper leaves as its stdin closes, taking the browser host's file in the distro with it.
  stop(): void {
    this.stopped = true
    this.run += 1
    this.drop()
  }

  private drop(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.link?.close()
    this.link = null
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
  }

  private again(run: number): void {
    const ends = this.ends
    if (this.stopped || run !== this.run || !ends) return
    const wait = Math.min((this.options.retryMs ?? 1000) * 2 ** this.failures, 60_000)
    this.failures += 1
    this.retry = setTimeout(() => {
      this.retry = null
      if (run !== this.run) return
      this.ends = null
      void this.connect(ends)
    }, wait)
    this.retry.unref()
  }
}
