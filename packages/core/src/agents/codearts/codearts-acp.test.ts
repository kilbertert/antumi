import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatItem } from '@antumi/protocol'
import type { ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { codeartsDialect } from './codearts-dialect'

// Recordings of Antumi's AcpDriver speaking to the bridge over CodeArts 26.11.11's own server
// (fixtures/codearts-recordings.md).
const Frame = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
const Record = z.object({ dir: z.enum(['in', 'out']), at: z.number(), frame: Frame })
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim().split('\n').map((line) => Record.parse(JSON.parse(line)))
const options: ChatStageOptions = { cwd: '/work/project', extraDirs: [], resume: null }
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
const replayed = (name: string, extra: Partial<ChatStageOptions> = {}) => {
  const driver = new AcpDriver(codeartsDialect, 'stage', { ...options, ...extra })
  read(name).forEach((record) => driver.apply(record))
  return driver
}

describe('CodeArts through its bridge', () => {
  it('replays a session: a reply, a command run in its sandbox, and Antumi’s MCP tool under its own name', () => {
    const driver = replayed('codearts-session.jsonl')
    expect(driver.failure()).toBeNull()
    expect(items(driver, 'user').map((item) => item.text)).toEqual(['say hi', 'RUN-CMD printf antumi-codearts-smoke', 'RUN-MCP please'])
    expect(items(driver, 'assistant').map((item) => item.text)).toEqual(['CodeArts ACP smoke OK', 'done: antumi-codearts-smoke', 'done: echo:hi'])
    expect(items(driver, 'tool')).toMatchObject([
      { name: 'commandExecution', title: 'printf antumi-codearts-smoke', status: 'done', output: 'antumi-codearts-smoke' },
      // Called through its tool_call, which the bridge leaves out.
      { name: 'antumi.echo', status: 'done', output: 'echo:hi' }
    ])
    expect(items(driver, 'turn').map((turn) => turn.state)).toEqual(['completed', 'completed', 'completed'])
    expect(items(driver, 'state').at(-1)).toMatchObject({ model: 'huaweicloud-maas/glm-5.3', context: { used: 120, window: 128000 } })
  })

  it('offers Antumi’s agents as its modes; the automatic one leaves a reference project and risky commands alone without asking', () => {
    const driver = replayed('codearts-modes.jsonl', { allowBypass: true })
    expect(driver.failure()).toBeNull()
    expect(items(driver, 'state').at(-1)).toMatchObject({ permissionMode: 'readOnly', permissionModes: ['ask', 'acceptEdits', 'bypass', 'plan', 'readOnly'] })
    const write = items(driver, 'tool').find((item) => item.name === 'fileChange')
    expect(write).toMatchObject({ status: 'failed', output: expect.stringContaining('rule which prevents you') })
    // A command CodeArts flags as risky is refused there too, not asked.
    expect(items(driver, 'approval')).toEqual([])
    expect(items(driver, 'tool').find((item) => item.name === 'commandExecution')?.output).toContain('用户拒绝')
    // In read-only, the model is offered no edit, command or subagent tool.
    const tools = items(driver, 'assistant').at(-1)?.text ?? ''
    expect(tools).toMatch(/^TOOLS: /)
    for (const missing of ['bash', 'edit', 'write', 'task', 'deleteFile', 'skill_manage']) expect(tools.split(/[ ,]/)).not.toContain(missing)
  })

  it('asks before a command its blacklist flags, as the command with the reason, and runs it once allowed', () => {
    const driver = replayed('codearts-approve.jsonl')
    expect(items(driver, 'approval')).toMatchObject([{ tool: 'commandExecution', resolution: 'allowed', detail: expect.stringContaining('删除目录') }])
    const [approval] = items(driver, 'approval')
    const [tool] = items(driver, 'tool')
    expect(approval?.toolItemId).toBe(tool?.id)
    expect(tool).toMatchObject({ title: 'rmdir /work/junk', status: 'done' })
  })

  it('goes on after a refused command without running it', () => {
    const driver = replayed('codearts-deny.jsonl')
    // Antumi refuses by cancelling the request, which the bridge answers CodeArts as a rejection.
    expect(items(driver, 'approval')).toMatchObject([{ resolution: 'cancelled' }])
    expect(items(driver, 'tool')[0]?.output).toContain('用户拒绝')
    expect(items(driver, 'turn').map((turn) => turn.state)).toEqual(['completed', 'completed'])
  })

  it('loads a session to go on with it, and forks one whole', () => {
    const resumed = replayed('codearts-resume.jsonl', { resume: 'ses_codearts1' })
    expect(resumed.failure()).toBeNull()
    expect(resumed.providerSessionId()).toBe('ses_codearts1')
    // Its history comes back with the session but does not enter the chat again.
    expect(items(resumed, 'user').map((item) => item.text)).toEqual(['say hi again'])
    const forked = replayed('codearts-fork.jsonl', { resume: 'ses_codearts1', fork: 'whole-session' })
    expect(forked.failure()).toBeNull()
    expect(forked.providerSessionId()).not.toBe('ses_codearts1')
    expect(items(forked, 'turn').at(-1)?.state).toBe('completed')
  })

  it('stops a turn when told, and takes the next message', () => {
    const driver = replayed('codearts-cancel.jsonl')
    expect(items(driver, 'turn').map((turn) => turn.state)).toEqual(['interrupted', 'completed'])
  })

  it('says why it cannot start without an access key', () => {
    expect(replayed('codearts-no-access-key.jsonl').failure()).toMatch(/^initialize: 认证失败，没有设置环境变量CODEARTS_CLI_AK\/CODEARTS_CLI_SK/)
  })

  it('names the conversation’s other projects in its first prompt, as it takes no additional directories', () => {
    const driver = new AcpDriver(codeartsDialect, 'stage', { ...options, extraDirs: ['/other'] })
    read('codearts-session.jsonl').slice(0, 4).forEach((record) => driver.apply(record))
    expect(driver.ready()).toBe(true)
    const sent = JSON.stringify(driver.send('hello').wire)
    expect(sent).toContain('- /other')
  })
})
