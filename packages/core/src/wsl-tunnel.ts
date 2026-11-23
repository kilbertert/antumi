import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
// Relative, not '@antumi/protocol/node': the helper is bundled alone, and the package index would
// bring zod and every schema with it.
import { writePrivateJson } from '../../protocol/src/node/private-file'
import { listenLoopback, openStdioTunnel, readFirstLine, sentinelLine, TUNNEL_TARGETS, type TunnelHelperConfig } from '../../protocol/src/node/stdio-tunnel'

// The tunnel helper the Windows app starts inside a WSL distro (wsl-tunnel-main.ts, docs/WSL.md
// 连接). It reads its config as the first line of stdin, answers with the sentinel line on stdout,
// and from then on both carry only tunnel frames.

export type TunnelHelper = {
  port: number | null
  // Tears the tunnel down and removes the endpoint file if it is still this helper's.
  stop(): Promise<void>
  // Settles once the tunnel is down and the file handled: the app hung up, or stop() was called.
  stopped: Promise<Error | null>
}

export function parseTunnelHelperConfig(text: string): TunnelHelperConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('config is not JSON')
  }
  if (!isObject(raw)) throw new Error('config is not an object')
  const config: TunnelHelperConfig = {}
  if (raw.listen !== undefined) {
    const listen = raw.listen
    if (!isObject(listen)) throw new Error('listen is not an object')
    const { endpointFile, endpoint } = listen
    if (endpointFile !== undefined && (typeof endpointFile !== 'string' || !path.posix.isAbsolute(endpointFile))) throw new Error('listen.endpointFile is not an absolute path')
    if (endpoint !== undefined && !isObject(endpoint)) throw new Error('listen.endpoint is not an object')
    if ((endpointFile === undefined) !== (endpoint === undefined)) throw new Error('listen.endpointFile and listen.endpoint go together')
    config.listen = endpointFile === undefined || endpoint === undefined ? {} : { endpointFile, endpoint }
  }
  if (raw.dial !== undefined) {
    const dial = raw.dial
    if (!isObject(dial) || typeof dial.port !== 'number' || !Number.isInteger(dial.port) || dial.port < 1 || dial.port > 65535) throw new Error('dial.port is not a port')
    config.dial = { port: dial.port }
  }
  if (!config.listen && !config.dial) throw new Error('config has neither listen nor dial')
  return config
}

// Throws on a config it cannot read or a file it cannot write; nothing has reached stdout then.
export async function startTunnelHelper(options: { stdin: Readable; stdout: Writable; pid?: number }): Promise<TunnelHelper> {
  const pid = options.pid ?? process.pid
  const { line, rest } = await readFirstLine(options.stdin, { maxBytes: 64 * 1024 })
  const config = parseTunnelHelperConfig(line)
  const server = config.listen ? await listenLoopback(0) : null
  const address = server?.address()
  const port = address && typeof address === 'object' ? address.port : null
  const endpointFile = config.listen?.endpointFile

  // The sentinel goes out before the file names the port: a connection core makes after reading
  // the file opens a frame, which must not come ahead of the sentinel.
  options.stdout.write(sentinelLine(port))
  const tunnel = await openStdioTunnel({
    input: options.stdin,
    output: options.stdout,
    head: rest,
    offers: server ? [{ target: TUNNEL_TARGETS.app, server }] : [],
    dials: config.dial ? { [TUNNEL_TARGETS.helper]: config.dial.port } : {}
  })

  const stopped = tunnel.closed.then(async (reason) => {
    server?.close()
    if (endpointFile) await removeOwnEndpoint(endpointFile, pid).catch(() => {})
    return reason
  })
  if (endpointFile && port !== null) {
    try {
      await mkdir(path.dirname(endpointFile), { recursive: true, mode: 0o700 })
      await writePrivateJson(endpointFile, { ...config.listen?.endpoint, port, pid })
    } catch (error) {
      tunnel.close()
      await stopped
      throw error
    }
  }
  return {
    port,
    stop: async () => {
      tunnel.close()
      await stopped
    },
    stopped
  }
}

// A successor helper may already have replaced the file; only the one that wrote it removes it.
async function removeOwnEndpoint(file: string, pid: number): Promise<void> {
  let current: unknown
  try {
    current = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return
  }
  if (isObject(current) && current.pid === pid) await rm(file, { force: true })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
