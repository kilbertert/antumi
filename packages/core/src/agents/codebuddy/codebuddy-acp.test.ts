import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isPlanApproval, type ChatItem } from '@antumi/protocol'
import type { ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { codebuddyDialect } from './codebuddy-dialect'

const Frame = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional() })
const Record = z.object({ dir: z.enum(['in', 'out']), at: z.number(), frame: Frame })
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim().split('\n').map((line) => Record.parse(JSON.parse(line)))
const recording = read('codebuddy-session.jsonl')
const planRecording = read('codebuddy-plan.jsonl')
const resumedRecording = read('codebuddy-resume.jsonl')
const subagentRecording = read('codebuddy-subagent.jsonl')
const answerTo = (records: typeof recording, id: string) => records.find((record) => record.dir === 'in' && record.frame.id === id)!.frame
const init = answerTo(recording, 'codebuddy-init').result
const openedResult = answerTo(recording, 'codebuddy-session').result
const options: ChatStageOptions = { cwd: '/work', extraDirs: [], resume: null }
const receive = (driver: AcpDriver, frame: unknown) => driver.apply({ dir: 'in', at: 10, frame })
const send = (driver: AcpDriver, frame: unknown) => driver.apply({ dir: 'out', at: 5, frame })
const due = (driver: AcpDriver) => { const frames = driver.due(); frames.forEach((frame) => send(driver, frame)); return frames.map((frame) => Frame.parse(frame)) }
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
const replayed = (records: typeof recording, extra: Partial<ChatStageOptions> = {}) => {
  const driver = new AcpDriver(codebuddyDialect, 'stage', { ...options, ...extra })
  records.forEach((record) => driver.apply(record))
  return driver
}
function opened(extra: Partial<ChatStageOptions> = {}) {
  const driver = new AcpDriver(codebuddyDialect, 'stage', { ...options, ...extra })
  due(driver)
  receive(driver, { id: 'codebuddy-init', result: init })
  due(driver)
  receive(driver, { id: 'codebuddy-session', result: openedResult })
  return driver
}
const planOptions = [{ kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' }, { kind: 'allow_once', name: 'Allow', optionId: 'allow' }, { kind: 'reject_once', name: 'Reject', optionId: 'reject' }, { kind: 'reject_once', name: 'Exit plan mode', optionId: 'reject_and_exit_plan' }]

describe('CodeBuddy Code ACP', () => {
  it('opens its session past the switch it lists as a boolean option, with its five modes and the configured model', () => {
    const driver = opened()
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)).toMatchObject({ permissionMode: 'ask', permissionModes: ['ask', 'acceptEdits', 'plan', 'auto', 'bypass'], model: 'custom-local:smoke' })
    expect(driver.setOption('permissionMode', 'auto')).toMatchObject([{ method: 'session/set_config_option', params: { sessionId: 'provider-session', configId: 'mode', value: 'auto' } }])
    expect(opened({ allowBypass: true }).setOption('permissionMode', 'bypass')).toMatchObject([{ params: { value: 'bypassPermissions' } }])
    expect(() => driver.setOption('permissionMode', 'readOnly')).toThrow()
  })

  it('replays a recorded session: a reply, an approved command and an approved Antumi MCP call', () => {
    const driver = replayed(recording)
    expect(driver.failure()).toBeNull()
    expect(items(driver, 'user').map((item) => item.text)).toEqual(['say hi', 'RUN-BASH please', 'RUN-MCP please'])
    expect(items(driver, 'assistant').map((item) => item.text)).toEqual(['CodeBuddy ACP smoke OK', expect.stringContaining('antumi-codebuddy-smoke'), 'done: echo:hi'])
    expect(items(driver, 'tool')).toMatchObject([
      { name: 'commandExecution', title: 'printf antumi-codebuddy-smoke', status: 'done', output: expect.stringContaining('Stdout: antumi-codebuddy-smoke') },
      { name: 'antumi.echo', status: 'done', output: 'echo:hi' }
    ])
    // Its permission requests carry no title: the call they belong to names them.
    expect(items(driver, 'approval')).toMatchObject([{ tool: 'commandExecution', title: 'printf antumi-codebuddy-smoke', resolution: 'allowed' }, { tool: 'antumi.echo', title: 'mcp__antumi__echo', resolution: 'allowed' }])
    expect(items(driver, 'turn').map((turn) => turn.state)).toEqual(['completed', 'completed', 'completed'])
  })

  it('reviews the plan from the file it wrote, and puts the session back in Antumi’s mode along with the approval', () => {
    const driver = replayed(planRecording)
    expect(driver.failure()).toBeNull()
    const plan = items(driver, 'approval')[0]!
    expect(isPlanApproval(plan)).toBe(true)
    expect(plan).toMatchObject({ tool: 'ExitPlanMode', detail: '# Plan\n\n1. Create notes.txt\n2. Write a line\n', runModes: ['ask'], resolution: 'allowed' })
    expect(planRecording.filter((record) => record.dir === 'out' && record.frame.method === 'session/set_config_option').map((record) => record.frame.params)).toMatchObject([{ value: 'plan' }, { value: 'default' }])
    expect(items(driver, 'state').at(-1)?.permissionMode).toBe('ask')
  })

  it('answers a plan approval with the mode switch CodeBuddy would otherwise make unannounced, and nothing more for a rejection', () => {
    const driver = opened()
    send(driver, driver.send('plan it').logged)
    const toolCall = { toolCallId: 'exit', rawInput: {}, _meta: { 'codebuddy.ai/toolName': 'ExitPlanMode', 'codebuddy.ai/planFilePath': '/home/.codebuddy/plans/p.md' } }
    receive(driver, { jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 'provider-session', toolCall, options: planOptions } })
    const plan = items(driver, 'approval')[0]!
    expect(plan).toMatchObject({ detail: '计划文件：/home/.codebuddy/plans/p.md', runModes: ['ask'] })
    expect(driver.respond(plan.requestId, { decision: 'allow' })).toEqual([
      { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
      { jsonrpc: '2.0', id: 'codebuddy-plan-run-number%3A7', method: 'session/set_config_option', params: { sessionId: 'provider-session', configId: 'mode', value: 'default' } }
    ])
    expect(driver.respond(plan.requestId, { decision: 'deny' })).toEqual([{ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } }])
  })

  it('keeps a subagent’s steps, which run in the parent’s session, on its Task card rather than in the chat', () => {
    const driver = replayed(subagentRecording)
    expect(driver.failure()).toBeNull()
    // Its one command, announced twice, counts once; its words are the card's report, not a reply.
    expect(items(driver, 'tool')).toMatchObject([{
      name: 'Task', title: 'Print the marker', status: 'done', metrics: { tools: 1 },
      input: expect.stringContaining('RUN-BASH now and report'), output: expect.stringContaining('done: Stdout: antumi-codebuddy-smoke')
    }])
    expect(items(driver, 'assistant').map((item) => item.text)).toEqual([expect.stringMatching(/^done: done: /)])
    // Its permission request names neither the call nor its tool: the subagent's call announced them.
    expect(items(driver, 'approval')).toMatchObject([{ tool: 'commandExecution', title: 'printf antumi-codebuddy-smoke', detail: expect.stringContaining('子 Agent 的请求：'), resolution: 'allowed' }])
  })

  it('resumes through session/load without repeating the history it replays', () => {
    const driver = replayed(resumedRecording, { resume: 'provider-session' })
    expect(driver.failure()).toBeNull()
    expect(resumedRecording.find((record) => record.dir === 'out' && record.frame.method === 'session/load')?.frame.params).toMatchObject({ sessionId: 'provider-session', cwd: '/work' })
    expect(items(driver, 'user').map((item) => item.text)).toEqual(['say hi again'])
    expect(items(driver, 'assistant').map((item) => item.text)).toEqual(['CodeBuddy ACP smoke OK'])
    expect(items(driver, 'tool')).toEqual([])
  })

  it('refuses a prompt longer than the line its ACP reads, which would stall the process, before it goes', () => {
    const driver = opened()
    const image = (bytes: number) => ({ id: `${'a'.repeat(64)}.png`, width: 4, height: 3, mime: 'image/png' as const, path: '/store/a.png', read: () => new Uint8Array(bytes) })
    // Four of Antumi's largest images come to about 22 MB in base64; seven pass 32 MiB.
    expect(driver.send('look', Array.from({ length: 4 }, () => image(4 * 1024 * 1024))).wire).toMatchObject({ method: 'session/prompt' })
    expect(() => driver.send('look', Array.from({ length: 7 }, () => image(4 * 1024 * 1024)))).toThrow(expect.objectContaining({ reason: 'chat-prompt-too-large', message: expect.stringContaining('最多接收 32 MB') }))
  })

  it('says to sign in when the CLI is signed out', () => {
    const driver = new AcpDriver(codebuddyDialect, 'stage', options)
    due(driver)
    receive(driver, { id: 'codebuddy-init', result: init })
    due(driver)
    receive(driver, { id: 'codebuddy-session', error: { code: -32000, message: 'Authentication required', data: { category: 'auth' } } })
    expect(driver.ready()).toBe(false)
    expect(driver.failure()).toBe('CodeBuddy 未登录，请先在终端里登录后重试')
  })
})
