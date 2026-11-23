import { randomBytes } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { connectTunnelHelper, listenLoopback, openStdioTunnel, readFirstLine, sentinelLine, TUNNEL_TARGETS, type StdioTunnel, type StdioTunnelOptions } from './stdio-tunnel'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const each of cleanup.splice(0)) each()
})

function track<T extends { close(): unknown }>(value: T): T {
  cleanup.push(() => void value.close())
  return value
}

async function echoServer(): Promise<{ server: Server; port: number }> {
  const server = track(createServer({ allowHalfOpen: true }, (socket) => socket.on('error', () => {}).pipe(socket)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

async function closedPort(): Promise<number> {
  const server = await listenLoopback(0)
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

// Two ends joined in memory, the way a child's stdout and stdin join them.
function pipes(highWaterMark?: number) {
  const aToB = new PassThrough(highWaterMark === undefined ? {} : { highWaterMark })
  const bToA = new PassThrough(highWaterMark === undefined ? {} : { highWaterMark })
  return { aToB, bToA, a: { input: bToA, output: aToB }, b: { input: aToB, output: bToA } }
}

function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port, allowHalfOpen: true }, () => {
      socket.off('error', reject).on('error', () => {})
      resolve(socket)
    })
    socket.once('error', reject)
    cleanup.push(() => socket.destroy())
  })
}

// Not events.once: the reset that closes it is an error event.
function closeOf(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

function collect(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  return new Promise((resolve, reject) => {
    socket.once('end', () => resolve(Buffer.concat(chunks)))
    socket.once('error', reject)
  })
}

async function roundTrip(port: number, payload: Buffer): Promise<Buffer> {
  const socket = await connect(port)
  const received = collect(socket)
  socket.end(payload)
  return received
}

async function pair(options: { highWaterMark?: number; a?: Partial<StdioTunnelOptions>; b?: Partial<StdioTunnelOptions> }) {
  const joined = pipes(options.highWaterMark)
  const a = track(await openStdioTunnel({ ...joined.a, ...options.a }))
  const b = track(await openStdioTunnel({ ...joined.b, ...options.b }))
  return { ...joined, a, b }
}

function port(tunnel: StdioTunnel, target: string): number {
  const found = tunnel.ports[target]
  if (found === undefined) throw new Error(`no port for ${target}`)
  return found
}

describe('stdio tunnel', () => {
  it('carries both directions at once over one pair of streams', async () => {
    const echoA = await echoServer()
    const echoB = await echoServer()
    const { a, b } = await pair({
      a: { offers: [{ target: 'to-b' }], dials: { 'to-a': echoA.port } },
      b: { offers: [{ target: 'to-a' }], dials: { 'to-b': echoB.port } }
    })
    const [one, two] = await Promise.all([roundTrip(port(a, 'to-b'), Buffer.from('from a')), roundTrip(port(b, 'to-a'), Buffer.from('from b'))])
    expect(one.toString()).toBe('from a')
    expect(two.toString()).toBe('from b')
  })

  it('passes 5 MB byte for byte', async () => {
    const echo = await echoServer()
    const { a } = await pair({ a: { offers: [{ target: 'x' }] }, b: { dials: { x: echo.port } } })
    const payload = randomBytes(5 * 1024 * 1024)
    const received = await roundTrip(port(a, 'x'), payload)
    expect(received.length).toBe(payload.length)
    expect(received.equals(payload)).toBe(true)
  })

  it('keeps many streams apart', async () => {
    const echo = await echoServer()
    const { a } = await pair({ a: { offers: [{ target: 'x' }] }, b: { dials: { x: echo.port } } })
    const payloads = Array.from({ length: 60 }, () => randomBytes(64 * 1024 + Math.floor(Math.random() * 64 * 1024)))
    const received = await Promise.all(payloads.map((payload) => roundTrip(port(a, 'x'), payload)))
    received.forEach((buffer, index) => expect(buffer.equals(payloads[index] ?? Buffer.alloc(0))).toBe(true))
  })

  it('does not buffer without bound toward a reader that stalls', async () => {
    let accepted: (socket: Socket) => void = () => {}
    const held = new Promise<Socket>((resolve) => (accepted = resolve))
    const sink = track(createServer({ allowHalfOpen: true }, (socket) => accepted(socket.on('error', () => {}).pause())))
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
    const address = sink.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const { a, aToB } = await pair({ highWaterMark: 64 * 1024, a: { offers: [{ target: 'x' }] }, b: { dials: { x: address.port } } })
    const client = await connect(port(a, 'x'))
    const chunk = randomBytes(1024 * 1024)
    // Writes well past what the kernel and the pipes would hold if nothing pushed back.
    for (let index = 0; index < 64; index++) client.write(chunk)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(aToB.readableLength + aToB.writableLength).toBeLessThan(2 * 1024 * 1024)
    expect(client.writableLength).toBeGreaterThan(16 * 1024 * 1024)
    // Once the reader reads, it all arrives.
    let total = 0
    const reader = await held
    const done = new Promise<void>((resolve) => {
      reader.on('data', (data: Buffer) => {
        total += data.length
        if (total === 64 * chunk.length) resolve()
      })
    })
    reader.resume()
    await done
  })

  it('passes a half-close each way', async () => {
    const server = track(createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('error', () => {})
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('end', () => socket.end(`got ${Buffer.concat(chunks).toString()}`))
    }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const { a } = await pair({ a: { offers: [{ target: 'x' }] }, b: { dials: { x: address.port } } })
    const reply = await roundTrip(port(a, 'x'), Buffer.from('hello'))
    expect(reply.toString()).toBe('got hello')
  })

  it('closes the accepted socket when the dial is refused or the target unknown', async () => {
    const { a } = await pair({ a: { offers: [{ target: 'x' }, { target: 'nowhere' }] }, b: { dials: { x: await closedPort() } } })
    for (const target of ['x', 'nowhere']) {
      // On Linux the reset can land before the client's own connect has returned: closed all the same.
      const socket = await connect(port(a, target)).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ECONNRESET') return null
        throw error
      })
      if (!socket) continue
      socket.on('error', () => {})
      socket.write('anyone?')
      await closeOf(socket)
    }
  })

  it('closes every socket on both sides when the peer vanishes mid-stream', async () => {
    let accepted: (socket: Socket) => void = () => {}
    const reached = new Promise<Socket>((resolve) => (accepted = resolve))
    // Reading, as a real target would: a socket that does not read never sees the reset.
    const server = track(createServer({ allowHalfOpen: true }, (socket) => accepted(socket.on('error', () => {}).resume())))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const { a, b, aToB } = await pair({ a: { offers: [{ target: 'x' }] }, b: { dials: { x: address.port } } })
    const client = await connect(port(a, 'x'))
    client.on('error', () => {})
    client.write(randomBytes(256 * 1024))
    const farClosed = closeOf(await reached)
    aToB.destroy()
    await Promise.all([closeOf(client), farClosed])
    expect(await b.closed).toBeInstanceOf(Error)
    await a.closed
  })

  it('close() destroys its sockets and ends the other side', async () => {
    const echo = await echoServer()
    const { a, b } = await pair({ a: { offers: [{ target: 'x' }] }, b: { dials: { x: echo.port } } })
    const client = await connect(port(a, 'x'))
    client.on('error', () => {})
    client.write('hi')
    await new Promise((resolve) => client.once('data', resolve))
    a.close()
    await closeOf(client)
    expect(await a.closed).toBeNull()
    expect(await b.closed).toBeNull()
  })

  it('uses a server it is handed and leaves it listening', async () => {
    const echo = await echoServer()
    const handed = track(await listenLoopback(0))
    const { a } = await pair({ a: { offers: [{ target: 'x', server: handed }] }, b: { dials: { x: echo.port } } })
    expect((await roundTrip(port(a, 'x'), Buffer.from('mine'))).toString()).toBe('mine')
    a.close()
    await a.closed
    expect(handed.listening).toBe(true)
  })

  it('fails on a frame that cannot be one', async () => {
    const joined = pipes()
    const a = track(await openStdioTunnel(joined.a))
    joined.bToA.write(Buffer.from([9, 0, 0, 0, 0, 1, 0, 0, 0, 0]))
    expect((await a.closed)?.message).toMatch(/unknown frame/)
  })
})

describe('first line', () => {
  it('returns the bytes after the newline', async () => {
    const input = new PassThrough()
    input.write('{"a":1}\r\nFRAMES')
    const { line, rest } = await readFirstLine(input, { maxBytes: 100 })
    expect(line).toBe('{"a":1}')
    expect(rest.toString()).toBe('FRAMES')
  })

  it('rejects output ahead of the sentinel at once', async () => {
    const input = new PassThrough()
    input.write('Welcome to Ubuntu')
    await expect(readFirstLine(input, { maxBytes: 4096, prefix: 'ANTUMI-TUNNEL 1 ' })).rejects.toThrow(/before the first line/)
  })

  it('times out', async () => {
    await expect(readFirstLine(new PassThrough(), { maxBytes: 10, timeoutMs: 30 })).rejects.toThrow(/within 30 ms/)
  })
})

function frame(type: number, opener: number, id: number, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(10)
  header.writeUInt8(type, 0)
  header.writeUInt8(opener, 1)
  header.writeUInt32BE(id, 2)
  header.writeUInt32BE(payload.length, 6)
  return Buffer.concat([header, payload])
}

describe('connectTunnelHelper', () => {
  it('sends the config, reads the sentinel and frames sent in the same chunk', async () => {
    const echo = await echoServer()
    const fromHelper = new PassThrough()
    const toHelper = new PassThrough()
    const config = { listen: {}, dial: { port: 1 } }
    const linking = connectTunnelHelper({ fromHelper, toHelper, config, appPort: echo.port })
    const sent = await readFirstLine(toHelper, { maxBytes: 1000 })
    expect(JSON.parse(sent.line)).toEqual(config)
    // The helper opens a stream to the app and half-closes it, all with its sentinel.
    fromHelper.write(Buffer.concat([Buffer.from(sentinelLine(40123)), frame(1, 0, 7, Buffer.from(TUNNEL_TARGETS.app)), frame(2, 0, 7, Buffer.from('ping')), frame(3, 0, 7)]))
    const link = track(await linking)
    expect(link.remotePort).toBe(40123)
    expect(link.localPort).toBeGreaterThan(0)
    // The echo's answer comes back as frames for stream 7, flagged as opened by the receiver.
    const chunks: Buffer[] = []
    toHelper.on('data', (chunk: Buffer) => chunks.push(chunk))
    toHelper.resume()
    const expected = Buffer.concat([frame(2, 1, 7, Buffer.from('ping')), frame(3, 1, 7)])
    while (Buffer.concat(chunks).length < expected.length) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(Buffer.concat(chunks).subarray(0, expected.length).equals(expected)).toBe(true)
  })

  it('refuses a helper that prints something else first', async () => {
    const fromHelper = new PassThrough()
    const linking = connectTunnelHelper({ fromHelper, toHelper: new PassThrough(), config: { dial: { port: 1 } } })
    fromHelper.write('node: not found\n')
    await expect(linking).rejects.toThrow(/not found/)
  })

  it('gives up on a helper that says nothing', async () => {
    await expect(connectTunnelHelper({ fromHelper: new PassThrough(), toHelper: new PassThrough(), config: { dial: { port: 1 } }, timeoutMs: 30 })).rejects.toThrow(/within/)
  })
})
