import { deliverChatMessage } from './chat-deliveries'
import { DECLINED, useCore, withProjectTrust } from './core-store'
import { t } from './i18n'

export function sendChatDelivery(id: string, ref: string, prepareSend: (stopped: boolean) => Promise<boolean>): Promise<void> {
  return deliverChatMessage(id, ref, async (message) => {
    const connected = useCore.getState().rpc
    if (!connected) throw new Error(t('coreStore.notConnectedToAntumiCore'))
    if (!connected.features.includes('deferred-conversation-start')) throw new Error(t('ChatDelivery.requiresNewerCore'))
    const stopped = !useCore.getState().conversations[id]?.sessionId
    if (!await prepareSend(stopped)) throw new Error(useCore.getState().error ?? t('ChatDelivery.notSent'))
    const { rpc, conversations } = useCore.getState()
    if (!rpc) throw new Error(t('coreStore.notConnectedToAntumiCore'))
    if (!rpc.features.includes('deferred-conversation-start')) throw new Error(t('ChatDelivery.requiresNewerCore'))
    const conversation = conversations[id]
    const working = conversation?.chat && !conversation.chat.betweenTurns && (conversation.chat.turn === 'running' || conversation.chat.turn === 'awaiting')
    await withProjectTrust(rpc, (connection) => connection.call('conversations.send', {
      id, ref, text: message.text,
      ...(message.images.length ? { images: message.images.map((image) => image.id) } : {}),
      ...(connection.features.includes('chat-references') ? { references: message.references } : {}),
      ...(message.steer ? { steer: true } : working && connection.features.includes('chat-options') ? { queue: true } : {})
    })).catch((error: unknown) => {
      if (error === DECLINED) throw new Error(t('ChatDelivery.notSent'))
      throw error
    })
  })
}
