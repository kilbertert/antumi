import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLineDecoder, DaemonRequest, daemonSchemas } from '@antumi/protocol/node'
import { DaemonClient } from './daemon-client'

describe('daemon method discovery', () => {
  const close: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of close.splice(0).reverse()) await cleanup()
  })

  async function connect(cleanPipe: boolean) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'antumi-probe-'))
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\antumi-probe-${randomUUID()}` : path.join(root, 'd.sock')
    const startProcess = vi.fn(() => ({ sessionId: 'never-started' }))
    const requests: unknown[] = []
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('data', createLineDecoder((line) => {
        const request = DaemonRequest.parse(JSON.parse(line))
        requests.push(request)
        const reply = (body: object) => socket.write(`${JSON.stringify({ id: request.id, ...body })}\n`)
        if (request.method === 'info') {
          reply({ result: { version: '0.21.7-beta.3', pid: 42, features: ['agent-cli-maintenance'] } })
        } else if (request.method === 'spawnPipeClean' && cleanPipe) {
          const params = daemonSchemas.spawnPipeClean.params.safeParse(request.params)
          if (params.success) reply({ result: startProcess() })
          else reply({ error: params.error.message })
        } else {
          reply({ error: 'unknown-method' })
        }
      }))
    })
    close.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const client = new DaemonClient(socketPath)
    close.push(async () => client.stop())
    const connected = new Promise<void>((resolve) => client.onConnect(resolve))
    client.start()
    await connected
    return { client, startProcess, requests, sockets }
  }

  it('recognizes an implemented method without a feature flag, without starting a process', async () => {
    const { client, startProcess, requests } = await connect(true)
    expect((await client.request('info', {})).features).not.toContain('clean-pipe')
    await expect(client.supports('spawnPipeClean')).resolves.toBe(true)
    expect(startProcess).not.toHaveBeenCalled()
    expect(requests).toContainEqual({ id: 2, method: 'spawnPipeClean', params: null })
  })

  it('recognizes a daemon that truly predates the method', async () => {
    const { client, startProcess } = await connect(false)
    await expect(client.supports('spawnPipeClean')).resolves.toBe(false)
    expect(startProcess).not.toHaveBeenCalled()
  })

  it('does not mistake a disconnected daemon for an unsupported method', async () => {
    const { client, sockets } = await connect(true)
    const disconnected = new Promise<void>((resolve) => {
      for (const socket of sockets) socket.once('close', resolve)
    })
    client.stop()
    await disconnected
    await expect(client.supports('spawnPipeClean')).rejects.toMatchObject({ reason: 'daemon-unavailable' })
  })
})
