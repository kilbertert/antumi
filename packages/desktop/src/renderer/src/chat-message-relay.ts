import type { ChatItem } from '@antumi/protocol'

export function relayMessage(items: readonly ChatItem[], ref: string): Extract<ChatItem, { kind: 'user' }> | null {
  return items.findLast((item): item is Extract<ChatItem, { kind: 'user' }> => item.kind === 'user' && item.id === `u:${ref}`) ?? null
}
