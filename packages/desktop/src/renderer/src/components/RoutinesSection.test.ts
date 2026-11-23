import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, type Routine, type RpcConnection, type ScheduledRun } from '@antumi/protocol'
import { useCore } from '../core-store'
import { RoutinesSection } from './RoutinesSection'

const captured = vi.hoisted(() => ({ nodes: [] as { type: unknown; props: Record<string, unknown> }[] }))

vi.mock('react/jsx-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>()
  const capture = (...args: Parameters<typeof runtime.jsx>) => {
    const [type, props] = args
    if (props && typeof props === 'object') captured.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsx(...args)
  }
  return { ...runtime, jsx: capture, jsxs: capture }
})

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args
    if (props && typeof props === 'object') captured.nodes.push({ type, props: Object.fromEntries(Object.entries(props)) })
    return runtime.jsxDEV(...args)
  } }
})

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const now = new Date(2026, 10, 20, 12).getTime()
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const routine = (n: number, patch: Partial<Routine> = {}): Routine => ({
  id: id(n),
  title: `任务${n}`,
  enabled: true,
  schedule: { kind: 'daily', time: '13:00' },
  target: { kind: 'new', agent: 'claude', projectPaths: [], text: '执行任务' },
  nextRunAt: now + 3600_000,
  lastFiredAt: null,
  unread: 0,
  lastRun: null,
  createdAt: now,
  updatedAt: now,
  ...patch
})

const failedRun = (): ScheduledRun => ({
  id: id(20),
  title: '任务2',
  agent: 'claude',
  target: { kind: 'routine', routineId: id(2) },
  notBefore: null,
  resetsAt: null,
  status: 'failed',
  conversationId: null,
  attempts: 1,
  error: 'chat-start-failed',
  createdAt: now - 3600_000,
  settledAt: null,
  routineId: id(2),
  dueAt: now - 3600_000,
  finishedAt: null,
  outcome: null,
  seenAt: null
})

function render() {
  captured.nodes = []
  return renderToStaticMarkup(createElement(RoutinesSection))
}

function node(type: unknown, label: string) {
  const found = captured.nodes.find((entry) => entry.type === type && entry.props['aria-label'] === label)
  if (!found) throw new Error(`missing ${String(type)}: ${label}`)
  return found.props
}

function connect() {
  const sent: Array<{ id: number; method: string; params: unknown }> = []
  const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
  const rpc: RpcConnection = { ...client, features: ['routines'], close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc, connection: 'connected' })
  return sent
}

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  captured.nodes = []
  vi.spyOn(Date, 'now').mockReturnValue(now)
})

describe('routine list controls', () => {
  it('shows automatic state separately from a one-time run', () => {
    useCore.setState({ routines: [
      routine(1),
      routine(2, { enabled: false, lastRun: failedRun() }),
      routine(3, { enabled: false, schedule: { kind: 'manual' }, nextRunAt: null })
    ] })

    const markup = render()
    expect(markup).toContain('data-state="enabled">已启用')
    expect(markup).toContain('data-state="paused">已暂停')
    expect(markup).toContain('data-state="manual">仅手动')
    expect(markup).toContain('上次失败：Agent 没能以聊天界面启动')
    expect(markup).toContain('不会自动运行')
    expect(markup.match(/>立即运行一次</g)).toHaveLength(3)

    const switches = captured.nodes.filter((entry) => entry.type === 'input' && entry.props.role === 'switch')
    expect(switches.map((entry) => [entry.props['aria-label'], entry.props.checked])).toEqual([
      ['自动运行：任务1', true],
      ['自动运行：任务2', false]
    ])
  })

  it('sends distinct RPCs for the automatic switch and the one-time action', () => {
    const sent = connect()
    useCore.setState({ routines: [routine(1)] })
    render()

    const toggle = node('input', '自动运行：任务1').onChange
    if (typeof toggle !== 'function') throw new Error('automatic switch has no change handler')
    toggle({ currentTarget: { checked: false } })
    expect(sent).toEqual([expect.objectContaining({ method: 'routines.update', params: { id: id(1), enabled: false } })])

    render()
    const run = node('button', '立即运行一次：任务1').onClick
    if (typeof run !== 'function') throw new Error('run-once button has no click handler')
    run()
    run()
    expect(sent.map((request) => request.method)).toEqual(['routines.update', 'routines.runNow'])
    expect(sent[1]?.params).toEqual({ id: id(1) })
  })
})
