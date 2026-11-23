import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'

// Loopback TCP connections carried over a pair of byte streams, the stdio of a `wsl.exe` child
// (docs/WSL.md, 连接): neither side's 127.0.0.1 reliably reaches the other, those pipes always do.
// Both ends run the same multiplexer. An end offers a target by taking local connections and
// opening a stream for each; the other end dials that target's fixed port for every stream it is
// opened. Both directions share one tunnel.
//
// Node built-ins only: the WSL helper (core/src/wsl-tunnel-main.ts) is bundled from this alone.
//
// Each frame: type (u8), opener (u8: 0 when the sender opened the stream, 1 when the receiver
// did), stream id (u32 BE, chosen by the opener), payload length (u32 BE), payload.
//   OPEN  payload is the target's name
//   DATA  payload is bytes for the stream
//   END   the sender's side will write no more (half-close)
//   RESET the stream is gone: a refused dial, a socket error, or a close before both ends ended

const FRAME = { open: 1, data: 2, end: 3, reset: 4 } as const
const HEADER_BYTES = 10
// What a socket hands over in one piece is far less; this is where a corrupt stream is caught.
const MAX_FRAME_BYTES = 1024 * 1024
const DATA_SLICE_BYTES = 256 * 1024

// The helper's first line on stdout, after which both directions carry only frames.
export const TUNNEL_SENTINEL = 'ANTUMI-TUNNEL 1 '

// Streams are named by the end that dials them: the helper's listening port reaches the app, the
// app's listening port reaches the helper's dial target.
export const TUNNEL_TARGETS = { app: 'app', helper: 'helper' } as const

// The helper's first line on stdin. `listen`: take connections on the distro's 127.0.0.1 for the
// app, naming the port in `endpointFile` as `{ ...endpoint, port, pid }`. `dial`: connect each
// stream the app opens to this port in the distro.
export type TunnelHelperConfig = {
  listen?: { endpointFile?: string; endpoint?: Record<string, unknown> }
  dial?: { port: number }
}

// A server handed in should be created with allowHalfOpen, or a half-close ends both directions.
export type TunnelOffer = { target: string; server: Server } | { target: string; port?: number }

export type StdioTunnelOptions = {
  input: Readable
  output: Writable
  // Bytes already read from `input` past a header line.
  head?: Buffer
  offers?: TunnelOffer[]
  // Port on 127.0.0.1 each target's streams are connected to.
  dials?: Record<string, number>
}

export type StdioTunnel = {
  // The listening port of each offered target.
  ports: Record<string, number>
  close(): void
  // Settles once torn down: null when closed or the peer ended, else what broke the tunnel.
  closed: Promise<Error | null>
}

type Stream = {
  id: number
  mine: boolean
  socket: Socket
  sentEnd: boolean
  gotEnd: boolean
  gone: boolean
}

export async function openStdioTunnel(options: StdioTunnelOptions): Promise<StdioTunnel> {
  const listening: { target: string; server: Server; owned: boolean }[] = []
  try {
    for (const offer of options.offers ?? []) {
      if ('server' in offer) listening.push({ target: offer.target, server: offer.server, owned: false })
      else listening.push({ target: offer.target, server: await listenLoopback(offer.port ?? 0), owned: true })
    }
  } catch (error) {
    for (const entry of listening) if (entry.owned) entry.server.close()
    throw error
  }
  return runTunnel(options, listening)
}

export function listenLoopback(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer({ allowHalfOpen: true })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

function runTunnel(options: StdioTunnelOptions, listening: { target: string; server: Server; owned: boolean }[]): StdioTunnel {
  const { input, output } = options
  const dials = options.dials ?? {}
  const mine = new Map<number, Stream>()
  const theirs = new Map<number, Stream>()
  let nextId = 1
  let finished = false
  let settle: (reason: Error | null) => void = () => {}
  const closed = new Promise<Error | null>((resolve) => (settle = resolve))

  // Backpressure is per direction, not per stream: a full pipe pauses every local socket, and a
  // socket that will not drain pauses the whole inbound pipe. Simple and bounded, at the price of
  // head-of-line blocking: one slow reader holds up the other streams going its way.
  let outboundBlocked = false
  const stalled = new Set<Stream>()

  const send = (type: number, stream: Pick<Stream, 'id' | 'mine'>, payload?: Buffer) => {
    if (finished) return
    const header = Buffer.alloc(HEADER_BYTES)
    header.writeUInt8(type, 0)
    header.writeUInt8(stream.mine ? 0 : 1, 1)
    header.writeUInt32BE(stream.id, 2)
    header.writeUInt32BE(payload?.length ?? 0, 6)
    let ok = output.write(header)
    if (payload?.length) ok = output.write(payload)
    if (!ok && !outboundBlocked) {
      outboundBlocked = true
      for (const each of [...mine.values(), ...theirs.values()]) each.socket.pause()
    }
  }

  const onDrain = () => {
    outboundBlocked = false
    for (const each of [...mine.values(), ...theirs.values()]) each.socket.resume()
  }

  const unstall = (stream: Stream) => {
    if (stalled.delete(stream) && stalled.size === 0 && !finished) input.resume()
  }

  const forget = (stream: Stream) => {
    stream.gone = true
    ;(stream.mine ? mine : theirs).delete(stream.id)
    unstall(stream)
  }

  const attach = (stream: Stream) => {
    const { socket } = stream
    ;(stream.mine ? mine : theirs).set(stream.id, stream)
    if (outboundBlocked) socket.pause()
    socket.on('data', (chunk: Buffer) => {
      for (let at = 0; at < chunk.length; at += DATA_SLICE_BYTES) send(FRAME.data, stream, chunk.subarray(at, at + DATA_SLICE_BYTES))
    })
    socket.on('end', () => {
      stream.sentEnd = true
      send(FRAME.end, stream)
    })
    socket.on('drain', () => unstall(stream))
    socket.on('error', () => {})
    socket.on('close', () => {
      if (stream.gone) return
      // Closed before both sides ended: the peer's socket must not wait for more.
      if (!(stream.sentEnd && stream.gotEnd)) send(FRAME.reset, stream)
      forget(stream)
    })
  }

  const offerConnection = (target: string) => (socket: Socket) => {
    if (finished) {
      abort(socket)
      return
    }
    const stream: Stream = { id: nextId, mine: true, socket, sentEnd: false, gotEnd: false, gone: false }
    nextId = nextId >= 0xffffffff ? 1 : nextId + 1
    // Known before it is announced: an in-memory peer may answer within the write.
    attach(stream)
    send(FRAME.open, stream, Buffer.from(target, 'utf8'))
  }
  const handlers = listening.map((entry) => {
    const handler = offerConnection(entry.target)
    entry.server.on('connection', handler)
    return { server: entry.server, handler, owned: entry.owned }
  })
  const ports = Object.fromEntries(listening.map((entry) => [entry.target, portOf(entry.server)]))

  const opened = (id: number, target: string) => {
    const port = dials[target]
    const socket = port === undefined ? null : createConnection({ host: '127.0.0.1', port, allowHalfOpen: true })
    if (!socket || theirs.has(id)) {
      // An unknown target, or an id still in use: refuse the stream without touching the old one.
      send(FRAME.reset, { id, mine: false })
      if (socket) abort(socket)
      return
    }
    attach({ id, mine: false, socket, sentEnd: false, gotEnd: false, gone: false })
  }

  const deliver = (type: number, opener: number, id: number, payload: Buffer) => {
    if (type === FRAME.open) {
      if (opener !== 0) throw new Error('tunnel: OPEN for a stream this end owns')
      opened(id, payload.toString('utf8'))
      return
    }
    // Frames for a stream already gone are late, not wrong.
    const stream = (opener === 0 ? theirs : mine).get(id)
    if (type === FRAME.data) {
      if (stream && !stream.gotEnd && !stream.socket.write(payload)) {
        stalled.add(stream)
        input.pause()
      }
    } else if (type === FRAME.end) {
      if (stream && !stream.gotEnd) {
        stream.gotEnd = true
        stream.socket.end()
      }
    } else if (type === FRAME.reset) {
      if (stream) {
        forget(stream)
        abort(stream.socket)
      }
    } else {
      throw new Error(`tunnel: unknown frame type ${type}`)
    }
  }

  let pending: Buffer = Buffer.alloc(0)
  // A write of ours can bring the peer's answer back within it (in-memory streams do), so input
  // that arrives while frames are being read waits its turn instead of reading `pending` twice.
  const queued: Buffer[] = []
  let reading = false
  const onData = (chunk: Buffer) => {
    queued.push(chunk)
    if (reading) return
    reading = true
    try {
      for (let next = queued.shift(); next && !finished; next = queued.shift()) {
        pending = pending.length ? Buffer.concat([pending, next]) : next
        let at = 0
        while (!finished && pending.length - at >= HEADER_BYTES) {
          const length = pending.readUInt32BE(at + 6)
          if (length > MAX_FRAME_BYTES) throw new Error(`tunnel: frame of ${length} bytes`)
          if (pending.length - at < HEADER_BYTES + length) break
          const type = pending.readUInt8(at)
          const opener = pending.readUInt8(at + 1)
          const id = pending.readUInt32BE(at + 2)
          const payload = pending.subarray(at + HEADER_BYTES, at + HEADER_BYTES + length)
          at += HEADER_BYTES + length
          deliver(type, opener, id, payload)
        }
        pending = pending.subarray(at)
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reading = false
    }
  }

  const onEnd = () => finish(null)
  // Closed without an end: the peer's process went away rather than hanging up.
  const onClose = () => finish(new Error('tunnel: input closed without ending'))
  const onError = (error: Error) => finish(error)

  function finish(reason: Error | null) {
    if (finished) return
    finished = true
    input.off('data', onData)
    input.off('end', onEnd)
    input.off('close', onClose)
    output.off('drain', onDrain)
    for (const { server, handler, owned } of handlers) {
      server.off('connection', handler)
      if (owned) server.close()
    }
    for (const stream of [...mine.values(), ...theirs.values()]) {
      stream.gone = true
      abort(stream.socket)
    }
    mine.clear()
    theirs.clear()
    stalled.clear()
    try {
      output.end()
    } catch {
      // process.stdout may refuse to end; the helper exits instead.
    }
    input.destroy()
    settle(reason)
  }

  input.on('data', onData)
  input.on('end', onEnd)
  input.on('close', onClose)
  input.on('error', onError)
  output.on('drain', onDrain)
  output.on('error', onError)
  if (options.head?.length) onData(options.head)
  if (!finished) input.resume()

  return { ports, close: () => finish(null), closed }
}

// A reset rather than a FIN: a client that allows half-open sockets would wait on a FIN forever.
function abort(socket: Socket) {
  if (socket.destroyed) return
  socket.on('error', () => {})
  socket.resetAndDestroy()
}

function portOf(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('tunnel: offered server is not listening on a port')
  return address.port
}

export type FirstLine = { line: string; rest: Buffer }

// Reads one line ahead of the frames and leaves `input` paused; bytes after the newline in the same
// chunk come back as `rest`. With `prefix`, bytes that cannot begin it fail at once rather than
// waiting for a newline that may never come.
export function readFirstLine(input: Readable, options: { maxBytes: number; timeoutMs?: number; prefix?: string }): Promise<FirstLine> {
  return new Promise((resolve, reject) => {
    let buffered: Buffer = Buffer.alloc(0)
    const prefix = options.prefix === undefined ? null : Buffer.from(options.prefix, 'utf8')
    const timer = options.timeoutMs === undefined ? null : setTimeout(() => fail(new Error(`no first line within ${options.timeoutMs} ms`)), options.timeoutMs)
    const done = () => {
      if (timer) clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('close', onEnd)
      input.off('error', fail)
    }
    function fail(error: Error) {
      done()
      input.pause()
      reject(error)
    }
    const onEnd = () => fail(new Error('stream ended before its first line'))
    const onData = (chunk: Buffer) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
      const newline = buffered.indexOf(0x0a)
      const head = newline === -1 ? buffered : buffered.subarray(0, newline)
      if (prefix) {
        const span = Math.min(head.length, prefix.length)
        if (!head.subarray(0, span).equals(prefix.subarray(0, span)) || (newline !== -1 && head.length < prefix.length)) {
          fail(new Error(`unexpected output before the first line: ${JSON.stringify(head.subarray(0, 200).toString('utf8'))}`))
          return
        }
      }
      if (newline === -1) {
        if (buffered.length > options.maxBytes) fail(new Error(`first line longer than ${options.maxBytes} bytes`))
        return
      }
      done()
      input.pause()
      resolve({ line: buffered.subarray(0, newline).toString('utf8').replace(/\r$/, ''), rest: buffered.subarray(newline + 1) })
    }
    input.on('data', onData)
    input.on('end', onEnd)
    input.on('close', onEnd)
    input.on('error', fail)
    input.resume()
  })
}

export type TunnelHelperLink = {
  // Where the helper listens in the distro for the app's target, or null without `listen`.
  remotePort: number | null
  // Where this end listens for the helper's dial target, with `dial`.
  localPort?: number
  close(): void
  closed: Promise<Error | null>
}

// The app's end of the helper (core/src/wsl-tunnel-main.ts), over the stdio of a child someone
// else started: sends the config, waits for the sentinel, then runs the tunnel with roles mirrored.
// `appPort` is where streams the helper takes are connected here; `listenPort` (0 for any) is where
// this end takes connections for the helper's `dial`.
export async function connectTunnelHelper(options: {
  fromHelper: Readable
  toHelper: Writable
  config: TunnelHelperConfig
  appPort?: number
  listenPort?: number
  timeoutMs?: number
}): Promise<TunnelHelperLink> {
  const { fromHelper, toHelper, config } = options
  if (config.listen && options.appPort === undefined) throw new Error('tunnel: listen needs appPort')
  toHelper.write(`${JSON.stringify(config)}\n`)
  const { line, rest } = await readFirstLine(fromHelper, { maxBytes: 4096, timeoutMs: options.timeoutMs ?? 15_000, prefix: TUNNEL_SENTINEL })
  const remotePort = sentinelPort(line.slice(TUNNEL_SENTINEL.length))
  const tunnel = await openStdioTunnel({
    input: fromHelper,
    output: toHelper,
    head: rest,
    offers: config.dial ? [{ target: TUNNEL_TARGETS.helper, port: options.listenPort ?? 0 }] : [],
    dials: config.listen && options.appPort !== undefined ? { [TUNNEL_TARGETS.app]: options.appPort } : {}
  })
  const localPort = tunnel.ports[TUNNEL_TARGETS.helper]
  return { remotePort, ...(localPort === undefined ? {} : { localPort }), close: tunnel.close, closed: tunnel.closed }
}

export function sentinelLine(port: number | null): string {
  return `${TUNNEL_SENTINEL}${JSON.stringify({ port })}\n`
}

function sentinelPort(text: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`tunnel: unreadable sentinel ${JSON.stringify(text)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('port' in parsed)) throw new Error('tunnel: sentinel without a port')
  const { port } = parsed
  if (port === null || (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536)) return port
  throw new Error('tunnel: sentinel port is not a port')
}
