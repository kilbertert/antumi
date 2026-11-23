import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRpcClient, RpcRequest, type Conversation, type RpcConnection } from '@antumi/protocol'
import { keepChatDelivery, useChatDeliveries } from './chat-deliveries'
import { sendChatDelivery } from './chat-delivery-send'
import { useCore } from './core-store'

const id = '11111111-1111-4111-8111-111111111111'
const ref = '22222222-2222-4222-8222-222222222222'
const conversation: Conversation = { id, title: 'Chat', titleLocked: true, agent: 'claude', workspacePath: '/repo', projectPaths: [], managedWorkspace: false, sessionId: 'session', createdAt: 0, updatedAt: 0 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function connect() {
  const requests: ReturnType<typeof RpcRequest.parse>[] = []
  const client = createRpcClient((frame) => requests.push(RpcRequest.parse(JSON.parse(frame))))
  const rpc: RpcConnection = { ...client, features: ['deferred-conversation-start', 'chat-references', 'chat-options'], close() {}, closed: Promise.resolve() }
  const reply = () => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: requests.at(-1)?.id, result: { ok: true } }))
  useCore.setState({ rpc, conversations: { [id]: conversation }, error: null })
  return { rpc, requests, reply }
}

beforeEach(() => {
  useChatDeliveries.setState({}, true)
  useCore.setState(useCore.getInitialState(), true)
  keepChatDelivery(id, { ref, text: '> 引用\n\n修复', images: [], references: [], stageId: 'pending', at: 1 })
})

describe('sending a chat delivery', () => {
  it('waits for readiness while keeping the local message and sends its fixed reference', async () => {
    const { requests, reply } = connect()
    const ready = Promise.withResolvers<boolean>()
    const prepare = vi.fn(() => ready.promise)
    const delivery = sendChatDelivery(id, ref, prepare)
    await settle()
    expect(prepare).toHaveBeenCalledWith(false)
    expect(requests).toHaveLength(0)
    expect(useChatDeliveries.getState()[id]?.[0]?.phase).toBe('sending')
    ready.resolve(true)
    await settle()
    expect(requests[0]).toMatchObject({ method: 'conversations.send', params: { id, ref, text: '> 引用\n\n修复', references: [] } })
    reply()
    await delivery
    expect(useChatDeliveries.getState()[id]?.[0]?.phase).toBe('sent')
  })

  it('keeps preparation failures on the bubble without issuing a send', async () => {
    const { requests } = connect()
    useCore.setState({ error: '启动失败' })
    await sendChatDelivery(id, ref, async () => false)
    expect(requests).toHaveLength(0)
    expect(useChatDeliveries.getState()[id]?.[0]).toMatchObject({ phase: 'failed', error: '启动失败', text: '> 引用\n\n修复' })
  })

  it('queues a retry when another turn has started in the meantime', async () => {
    const { requests, reply } = connect()
    useCore.setState({ conversations: { [id]: { ...conversation, chat: { turn: 'running' } } } })
    const delivery = sendChatDelivery(id, ref, async () => true)
    await settle()
    expect(requests[0]).toMatchObject({ params: { ref, queue: true } })
    reply()
    await delivery
  })

  it('keeps an offline message for retry without trying to start an agent', async () => {
    const prepare = vi.fn(async () => true)
    await sendChatDelivery(id, ref, prepare)
    expect(prepare).not.toHaveBeenCalled()
    expect(useChatDeliveries.getState()[id]?.[0]?.phase).toBe('failed')
  })

  it('does not risk resending a retained message through a core without reference support', async () => {
    const { rpc, requests } = connect()
    useCore.setState({ rpc: { ...rpc, features: [] } })
    await sendChatDelivery(id, ref, async () => true)
    expect(requests).toHaveLength(0)
    expect(useChatDeliveries.getState()[id]?.[0]).toMatchObject({ phase: 'failed', error: '当前后台版本不支持安全重试，请更新后台' })
  })
})
