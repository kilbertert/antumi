import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import type { CoreEndpoint } from '@antumi/protocol'
import { antumiPaths, readCoreEndpoint, writeCoreEndpoint } from '@antumi/protocol/node'

// Remote core: the app's window runs here, the agents and their git checkouts run on another
// machine. The boundary already exists in Antumi (desktop is only a client; core owns tasks,
// git and the agent processes), so this file does not move any logic — it only points the
// client's end of that boundary across a link instead of at loopback.
//
// The link is an SSH local forward, the same shape VS Code Remote and JetBrains Gateway use:
//   ssh -N -L 127.0.0.1:<corePort>:127.0.0.1:<corePort> <sshHost>
// The remote core keeps listening on *its* loopback, so nothing on either machine gains an
// exposed port. coreUrl() and every RPC client stay untouched: they still dial 127.0.0.1, which
// now terminates at the local end of the tunnel. Keeping the address in one place is why this
// does not sprawl into the protocol layer.

// Operator-owned, owner-only, and optional: no file means the app behaves exactly as upstream.
export const RemoteCoreConfig = z.object({
  // A Host alias from the user's ssh config; the user's own keys and agent do the auth.
  sshHost: z.string().trim().min(1).max(255),
  // The port on BOTH ends. Fixed rather than allocated so a reconnect lands on the same address
  // and core.json never has to be rewritten for a new number.
  corePort: z.number().int().min(1024).max(65535),
  // Where core's home is on the far side (its core.json, worktrees, sessions live there).
  remoteHome: z.string().trim().min(1).max(4096),
  // How to start a core there. Idempotent by contract: an already-running core is reused.
  // Left out, the remote core is assumed to be managed by the host (a service, a tmux, nothing).
  startCommand: z.string().trim().min(1).max(2000).optional(),
  // Extra ssh arguments (a jump host, a non-default key). Never a command: this is argv, not a shell.
  sshArgs: z.array(z.string().min(1).max(500)).max(20).optional()
})
export type RemoteCoreConfig = z.infer<typeof RemoteCoreConfig>

export function remoteConfigPath(): string {
  return join(antumiPaths().home, 'remote.json')
}

// Anything unreadable or malformed is treated as "not configured" rather than as a half-working
// mode: silently running local while the user believes they are remote is the expensive failure.
// The reason is returned so the UI can say what is wrong instead of just falling back.
export type RemoteState =
  | { kind: 'off' }
  | { kind: 'broken'; problem: string }
  | { kind: 'on'; config: RemoteCoreConfig }

export function readRemoteConfig(): RemoteState {
  const file = remoteConfigPath()
  if (!existsSync(file)) return { kind: 'off' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { kind: 'broken', problem: `remote.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = RemoteCoreConfig.safeParse(raw)
  if (!parsed.success) return { kind: 'broken', problem: `remote.json is incomplete: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}` }
  return { kind: 'on', config: parsed.data }
}

export type RemoteLink = {
  // Resolves once the tunnel is up and core.json describes the endpoint the renderer should dial.
  ensure(): Promise<CoreEndpoint>
  stop(): void
  config: RemoteCoreConfig
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

function waitForPort(port: number, until: number): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      const settle = (ok: boolean) => {
        socket.destroy()
        if (ok) return resolve(true)
        if (Date.now() > until) return resolve(false)
        setTimeout(attempt, 250)
      }
      socket.setTimeout(800, () => settle(false))
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
    }
    attempt()
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The remote core's endpoint as the far side wrote it. Read over ssh rather than through the
// tunnel: the tunnel only forwards the core's websocket port, and this file also carries the
// token and the running core's version, which the app needs before it can trust the endpoint.
function readRemoteEndpoint(config: RemoteCoreConfig, sshArgs: string[]): Promise<CoreEndpoint | null> {
  return new Promise((resolve) => {
    const remoteFile = `${config.remoteHome.replace(/\/+$/, '')}/core.json`
    const child = spawn('ssh', [...sshArgs, config.sshHost, `cat ${shellQuote(remoteFile)}`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      try {
        const parsed = z.object({ port: z.number().int(), token: z.string(), pid: z.number().int(), protocolVersion: z.number().int(), version: z.string().optional() }).safeParse(JSON.parse(out))
        resolve(parsed.success ? parsed.data : null)
      } catch {
        resolve(null)
      }
    })
  })
}

// One argv element, quoted for the remote login shell. The paths this is used with are operator
// supplied, so it is escaped rather than trusted.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function createRemoteLink(config: RemoteCoreConfig): RemoteLink {
  const sshArgs = config.sshArgs ?? []
  let tunnel: ChildProcess | null = null
  let starting: Promise<CoreEndpoint> | null = null

  function stop(): void {
    if (tunnel && !tunnel.killed) tunnel.kill()
    tunnel = null
  }

  async function ensureOnce(): Promise<CoreEndpoint> {
    // A stale tunnel from a previous app run would make the port look taken; nothing else knows
    // about it, so it is ours to clear.
    if (!(await isPortFree(config.corePort))) {
      // Either our own tunnel (already up) or something the user runs on that port. Probe it: if
      // core answers, reuse the link instead of failing a start the user cannot see the cause of.
      if (await waitForPort(config.corePort, Date.now() + 1_000)) {
        const endpoint = await readRemoteEndpoint(config, sshArgs)
        if (endpoint) return endpoint
      }
      throw new Error(`port ${config.corePort} is already in use on this machine`)
    }

    if (config.startCommand) {
      await runSsh(config, config.startCommand).catch(() => undefined)
    }

    const endpoint = await readRemoteEndpoint(config, sshArgs)
    if (!endpoint) throw new Error(`no core at ${config.remoteHome} on ${config.sshHost}; start one there (or set startCommand)`)

    tunnel = spawn('ssh', [...sshArgs, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', `127.0.0.1:${config.corePort}:127.0.0.1:${endpoint.port}`, config.sshHost], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      // Its own process group: quitting the app must not leave an orphan forward behind, and the
      // normal quit path kills it explicitly. Windows has no process groups to detach from.
      detached: process.platform !== 'win32'
    })
    tunnel.stderr?.setEncoding('utf8')
    let lastError = ''
    tunnel.stderr?.on('data', (chunk: string) => { lastError = chunk.trim() })
    tunnel.once('exit', () => { tunnel = null })

    if (!(await waitForPort(config.corePort, Date.now() + 20_000))) {
      stop()
      throw new Error(`ssh tunnel to ${config.sshHost} did not come up${lastError ? `: ${lastError}` : ''}`)
    }

    // The renderer reads core.json through the preload bridge, so the local file must describe the
    // local end of the tunnel. Keeping that contract is what leaves core-store, the MCP clients and
    // the browser host looking for a *local* core entirely unchanged.
    await writeCoreEndpoint({ port: config.corePort, token: endpoint.token, pid: endpoint.pid, protocolVersion: endpoint.protocolVersion, version: endpoint.version })
    return { ...endpoint, port: config.corePort }
  }

  return {
    config,
    stop,
    ensure() {
      // Concurrent callers (the window, the requests card, a backend re-check) share one start.
      if (!starting) {
        starting = ensureOnce().finally(() => { starting = null })
      }
      return starting
    }
  }
}

function runSsh(config: RemoteCoreConfig, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...(config.sshArgs ?? []), config.sshHost, command], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`remote start command exited ${code}`))
    })
  })
}

// The endpoint a remote-mode app should show as "connected": what the tunnel forwards to. Used by
// the few places that need to say whether core is up without starting anything.
export async function remoteEndpointIfUp(config: RemoteCoreConfig): Promise<CoreEndpoint | null> {
  const local = await readCoreEndpoint()
  if (local && local.port === config.corePort && (await waitForPort(config.corePort, Date.now() + 800))) return local
  return null
}

export { sleep as remoteSleep }
