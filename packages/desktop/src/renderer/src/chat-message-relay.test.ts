import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@antumi/protocol'
import { relayMessage } from './chat-message-relay'

const user = (id: string, text = '修复登录', stageId = 'pending'): Extract<ChatItem, { kind: 'user' }> => ({
  kind: 'user', id, stageId, revision: 1, at: 100, text, images: []
})

describe('relayMessage', () => {
  it('finds the local bubble before any send reply or notification', () => {
    const local = user('u:local')
    expect(relayMessage([local], 'local')).toBe(local)
  })

  it('does not animate another message with identical content', () => {
    expect(relayMessage([user('u:previous')], 'local')).toBeNull()
  })

  it('keeps identifying the message after core assigns its stage or adds context', () => {
    const confirmed = user('u:local', '项目分支已切换\n\n修复登录', 'stage-2')
    expect(relayMessage([confirmed], 'local')).toBe(confirmed)
  })
})
