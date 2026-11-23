import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer, McpServerInput } from '@antumi/protocol'
import { CredentialStore } from './credential-store'
import { McpServerStore } from './mcp-servers'
import * as files from '@antumi/protocol/node'

let dir: string
let credentials: CredentialStore
let changes: McpServer[][]
let store: McpServerStore

const command = { type: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: null, env: [{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }] }
const github: McpServerInput = { name: 'github', previousName: null, enabled: true, agents: ['claude', 'cursor'], transport: command }

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'antumi-mcp-'))
  credentials = new CredentialStore(path.join(dir, 'credentials.json'))
  changes = []
  store = new McpServerStore(path.join(dir, 'mcp-servers.json'), credentials, (servers) => changes.push([...servers]))
  await store.load()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

describe('MCP server store', () => {
  it('keeps the settings in its file and the env values among the credentials', async () => {
    const saved = await store.save(github)
    expect(saved.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: null, envKeys: ['GITHUB_TOKEN'] })
    expect(readFileSync(path.join(dir, 'mcp-servers.json'), 'utf8')).not.toContain('ghp_secret')
    expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).toContain('ghp_secret')
    expect(changes).toHaveLength(1)

    const reloaded = new McpServerStore(path.join(dir, 'mcp-servers.json'), credentials)
    await reloaded.load()
    expect(reloaded.list().map((server) => server.name)).toEqual(['github'])
  })

  it('hands an agent the enabled servers picked for it, and a launcher their values', async () => {
    await store.save(github)
    expect(store.forAgent('claude').map((server) => server.name)).toEqual(['github'])
    expect(store.resolve('github')).toEqual({ name: 'github', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: null, env: { GITHUB_TOKEN: 'ghp_secret' } } })
    expect(store.forAgent('codex')).toEqual([])
    await store.setEnabled('github', false)
    expect(store.forAgent('claude')).toEqual([])
  })

  it('keeps a stored value an edit leaves out, and drops a key the edit removes', async () => {
    await store.save({ ...github, transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }, { key: 'GITHUB_HOST', value: 'github.com' }] } })
    await store.save({ ...github, previousName: 'github', transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: null }] } })
    expect(store.resolve('github')?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_secret' } })
    expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).not.toContain('github.com')
  })

  it('carries the secrets over a rename and keeps the server in its place', async () => {
    await store.save(github)
    await store.save({ ...github, name: 'docs', transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: [] } })
    await store.save({ ...github, name: 'gh', previousName: 'github', transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: null }] } })
    expect(store.list().map((server) => server.name)).toEqual(['gh', 'docs'])
    expect(store.resolve('gh')?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_secret' } })
    expect(credentials.get('mcp', 'github')).toBeNull()
  })

  it('refuses a taken name, a missing value and a token sent in the clear', async () => {
    await store.save(github)
    await expect(store.save(github)).rejects.toMatchObject({ reason: 'mcp-name-taken' })
    await expect(store.save({ ...github, name: 'other', transport: { ...command, env: [{ key: 'TOKEN', value: null }] } })).rejects.toMatchObject({ reason: 'mcp-secret-missing' })
    await expect(store.save({ ...github, name: 'remote', transport: { type: 'http', url: 'http://mcp.example.com/mcp', headers: [] } })).rejects.toMatchObject({ reason: 'mcp-insecure-url' })
    await expect(store.save({ ...github, name: 'local', transport: { type: 'http', url: 'http://127.0.0.1:3000/mcp', headers: [] } })).resolves.toMatchObject({ name: 'local' })
  })

  it('removes a server with its secrets', async () => {
    await store.save(github)
    await store.remove('github')
    expect(store.list()).toEqual([])
    expect(credentials.get('mcp', 'github')).toBeNull()
  })

  it.each([
    { ...command, command: 'other-command' },
    { ...command, args: ['-y', 'another-package'] },
    { ...command, cwd: path.resolve('another-directory') }
  ])('requires new credentials when the executable invocation changes: %j', async (transport) => {
    await store.save(github)
    const before = store.resolve('github')
    await expect(store.save({ ...github, previousName: 'github', transport: { ...transport, env: [{ key: 'GITHUB_TOKEN', value: null }] } }))
      .rejects.toMatchObject({ reason: 'mcp-secret-target-changed' })
    expect(store.resolve('github')).toEqual(before)
    expect(changes).toHaveLength(1)
    await store.load()
    expect(store.resolve('github')).toEqual(before)
    await store.save({ ...github, previousName: 'github', transport: { ...transport, env: [{ key: 'GITHUB_TOKEN', value: 'new-secret' }] } })
    expect(store.resolve('github')?.transport).toMatchObject({ command: transport.command, args: transport.args, cwd: transport.cwd, env: { GITHUB_TOKEN: 'new-secret' } })
  })

  it('binds retained HTTP credentials to the full normalized URL', async () => {
    const remote = { ...github, name: 'design', transport: { type: 'http' as const, url: 'https://design.example.test/mcp', headers: [{ key: 'Authorization', value: 'Bearer old-secret' }] } }
    await store.save(remote)
    for (const url of ['https://other.example.test/mcp', 'https://design.example.test/other', 'https://design.example.test/mcp?tenant=other']) {
      await expect(store.save({ ...remote, previousName: 'design', transport: { ...remote.transport, url, headers: [{ key: 'Authorization', value: null }] } }))
        .rejects.toMatchObject({ reason: 'mcp-secret-target-changed' })
      expect(store.resolve('design')?.transport).toMatchObject({ url: remote.transport.url, headers: { Authorization: 'Bearer old-secret' } })
    }
    await store.save({ ...remote, previousName: 'design', name: 'prototype', agents: ['codex'], transport: { ...remote.transport, url: 'https://design.example.test:443/mcp', headers: [{ key: 'Authorization', value: null }] } })
    expect(store.resolve('prototype')?.transport).toMatchObject({ headers: { Authorization: 'Bearer old-secret' } })
    expect(credentials.get('mcp', 'design')).toBeNull()
    await store.save({ ...remote, previousName: 'prototype', transport: { ...remote.transport, url: 'https://other.example.test/mcp', headers: [{ key: 'Authorization', value: 'Bearer new-secret' }] } })
    expect(store.resolve('design')?.transport).toMatchObject({ url: 'https://other.example.test/mcp', headers: { Authorization: 'Bearer new-secret' } })
    expect(JSON.stringify(store.list())).not.toMatch(/old-secret|new-secret/)
  })

  it('keeps the previous target and credentials after a settings write fails', async () => {
    await store.save(github)
    const before = store.resolve('github')
    const write = files.writePrivateJson
    vi.spyOn(files, 'writePrivateJson').mockImplementation(async (file, value) => {
      if (file === path.join(dir, 'mcp-servers.json')) throw new Error('settings-write-failed')
      return write(file, value)
    })
    await expect(store.save({ ...github, previousName: 'github', transport: { ...command, command: 'new-command', env: [{ key: 'GITHUB_TOKEN', value: 'new-secret' }] } }))
      .rejects.toThrow('settings-write-failed')
    expect(store.resolve('github')).toEqual(before)
    expect(JSON.stringify(store.list())).not.toContain('credentialRef')
    expect(readFileSync(path.join(dir, 'credentials.json'), 'utf8')).not.toContain('new-secret')
    await store.load()
    expect(store.resolve('github')).toEqual(before)
    await credentials.load()
    expect(store.resolve('github')).toEqual(before)
  })

  it('reads existing name-bound credentials and upgrades them when saved', async () => {
    const now = Date.now()
    await credentials.set('mcp', 'github', { kind: 'mcp', payload: { 'env:GITHUB_TOKEN': 'legacy-secret' }, account: null, updatedAt: now })
    await files.writePrivateJson(path.join(dir, 'mcp-servers.json'), { version: 1, servers: [{ name: 'github', enabled: true, agents: ['claude'],
      transport: { type: 'stdio', command: command.command, args: command.args, cwd: null, envKeys: ['GITHUB_TOKEN'] }, createdAt: now, updatedAt: now }] })
    await store.load()
    expect(store.resolve('github')?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'legacy-secret' } })
    await store.save({ ...github, previousName: 'github', transport: { ...command, env: [{ key: 'GITHUB_TOKEN', value: null }] } })
    expect(store.resolve('github')?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'legacy-secret' } })
    expect(credentials.get('mcp', 'github')).toBeNull()
    expect(credentials.instances('mcp')).toHaveLength(1)
  })
})
