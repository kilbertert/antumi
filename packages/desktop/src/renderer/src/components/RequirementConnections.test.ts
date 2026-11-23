import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, ModelProvider, type RpcConnection } from '@antumi/protocol'
import { useCore } from '../core-store'
import { RequirementConnections } from './RequirementConnections'

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const render = () => renderToStaticMarkup(createElement(RequirementConnections, { onSettings: () => {} }))
const connect = (features: string[]) => {
  const client = createRpcClient(() => {})
  const rpc: RpcConnection = { ...client, features, close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc, sources: [] })
}
beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('requirement connections', () => {
  it('reports configured credentials and shared MCPs without displaying settings or values', () => {
    connect(['model-providers', 'mcp-servers', 'plugins'])
    useCore.setState({
      sources: [{ provider: 'zentao', name: '禅道', settings: [], instances: [{ instance: 'default', enabled: true,
        settings: { site: 'https://private.example.test' }, credential: { configured: true, source: 'store', account: 'private-account' } }] }],
      modelProviders: [ModelProvider.parse({ id: 'example', name: 'Example', preset: 'custom', anthropic: null,
        openai: { chatUrl: 'https://models.example.test', responsesUrl: null }, models: [{ id: 'example', label: null, contextWindow: null, maxOutput: null, efforts: [] }], defaultModel: 'example', smallModel: 'example', agents: ['codex'],
        hasKey: true, revision: 1, createdAt: 0, updatedAt: 0 })],
      mcpServers: [true, false].map((enabled, index) => ({ name: `design-${index}`, enabled, agents: ['codex'],
        transport: { type: 'http', url: 'https://private-mcp.example.test', headerKeys: ['Authorization'] }, createdAt: 0, updatedAt: 0 }))
    })
    const html = render()
    expect(html).toContain('已启用且凭据已配置')
    expect(html).toContain('1 个已配置 Key')
    expect(html).toContain('1 个已启用并共享给 Agent')
    expect(html).toContain('配置禅道')
    expect(html).toContain('配置模型服务商')
    expect(html).toContain('配置 MCP')
    expect(html).not.toMatch(/private-account|private\.example|private-mcp|Authorization/)
  })

  it('shows installation and empty states without claiming a successful connection', () => {
    connect(['plugins', 'model-providers', 'mcp-servers'])
    expect(render()).toContain('尚未安装来源插件')
    expect(render()).toContain('0 个已配置 Key')
    expect(render()).toContain('0 个已启用并共享给 Agent')
    expect(render()).toContain('不代表连通性测试已通过')
  })

  it('keeps older Core settings unavailable and distinguishes disabled sources', () => {
    connect([])
    expect(render()).not.toContain('>配置 MCP</button>')
    expect(render()).not.toContain('>配置模型服务商</button>')
    expect(render()).not.toContain('>配置禅道</button>')
    useCore.setState({ sources: [{ provider: 'zentao', name: '禅道', settings: [], instances: [{ instance: 'default', enabled: false, settings: {},
      credential: { configured: true, source: 'store', account: null } }] }] })
    expect(render()).toContain('请配置凭据并启用来源')
  })
})
