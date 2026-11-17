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

function waitForPortFree(port: number, until: number): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = () => {
      void isPortFree(port).then((free) => {
        if (free) return resolve(true)
        if (Date.now() > until) return resolve(false)
        setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

// The executable name behind a PID, for telling our own ssh apart from anything else.
function processName(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const args = process.platform === 'win32'
      ? ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']
      : ['-p', String(pid), '-o', 'comm=']
    const child = spawn(process.platform === 'win32' ? 'tasklist' : 'ps', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { child.kill(); resolve(null) }, 4_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
    child.once('close', () => {
      clearTimeout(timer)
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0)
      if (!first) return resolve(null)
      const name = process.platform === 'win32' ? (first.split('","')[0] ?? first).replace(/^"/, '') : first.trim()
      resolve(name || null)
    })
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

// Which process holds a port, so a stale forward of our own can be told apart from someone
// else's. Windows: netstat -ano prints the PID in the last column. Elsewhere: lsof.
function pidOnPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const command = process.platform === 'win32'
      ? { cmd: 'netstat', args: ['-ano'] }
      : { cmd: 'lsof', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'] }
    const child = spawn(command.cmd, command.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { child.kill(); resolve(null) }, 5_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
    child.once('close', () => {
      clearTimeout(timer)
      if (process.platform === 'win32') {
        const line = out.split(/\r?\n/).find((row) => row.includes(`:${port} `) && /LISTENING/i.test(row))
        const pid = line?.trim().split(/\s+/).at(-1)
        resolve(pid && /^\d+$/.test(pid) ? Number(pid) : null)
      } else {
        const pid = out.trim().split(/\s+/)[0]
        resolve(pid && /^\d+$/.test(pid) ? Number(pid) : null)
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



  // An ssh process listening on our port with nothing of ours behind it is a forward a previous
  // run left behind (a crash, a killed parent). It is ours to clear; anything else is not.
  async function clearStaleForward(): Promise<boolean> {
    if (await isPortFree(config.corePort)) return true
    const pid = await pidOnPort(config.corePort)
    if (pid === null) return false
    const name = await processName(pid)
    if (name === null || !/^ssh(\.exe)?$/i.test(name)) return false
    try { process.kill(pid) } catch { return false }
    return await waitForPortFree(config.corePort, Date.now() + 5_000)
  }

  async function ensureOnce(): Promise<CoreEndpoint> {
    // Reuse a link that is already good (another window, or this app's earlier attempt).
    if (!(await isPortFree(config.corePort)) && await waitForPort(config.corePort, Date.now() + 1_000)) {
      const live = await readRemoteEndpoint(config, sshArgs)
      if (live) return { ...live, port: config.corePort }
    }
    // Otherwise a forward from a previous run is squatting on our port; clear it rather than
    // failing, because the user's fix would be "find and kill an ssh.exe" — not something a
    // window that says "waiting for core" tells them.
    if (!(await clearStaleForward())) {
      if (!(await isPortFree(config.corePort))) {
        throw new Error(`port ${config.corePort} is in use by another program on this machine; change corePort in remote.json`)
      }
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

// The two probes behind "clear our own leftover forward, refuse a foreign listener". Exported for
// the test that pins that distinction; not part of the mode's API.
export const __testPortFree = isPortFree
export const __testPidOnPort = pidOnPort
