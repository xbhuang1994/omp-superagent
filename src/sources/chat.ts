/** Web and bound-WeChat messages as first-class Triggers with durable Outbox replies. */
import { randomUUID } from 'node:crypto'
import z from 'zod'
import { key, type OutboundMessage, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { ChatAttachment, OMPSessions } from '../app/sessions.ts'
import type { SourceKind } from './kind.ts'

export const CHAT_SOURCE = 'chat'
export const WEB_SENDER = 'web:local'
const WEB_THREAD = 'web:main'
export interface ChatInput {
  surface: 'web' | 'wechat'
  messageId: string
  sender: string
  conversation: string
  text: string
  attachments?: ChatAttachment[]
  at?: string
}
export interface ChatReceipt { requestId: string; triggerId: string; result: ReceiveResult }
interface ChatHost {
  readonly sessions: Pick<OMPSessions, 'presentChat' | 'publish'>
  readonly masterId: string
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  deliverWeChat(id: string, text: string, userId: string): Promise<'sent' | 'gone'>
}

/** Converts local chat payloads to host-generated Trigger IDs and routes only to their originating conversation. */
export class ChatSource {
  constructor(private readonly host: ChatHost) {}

  receiveWeb(text: string, attachments: ChatAttachment[] = [], messageId = `web:${randomUUID()}`): Promise<ChatReceipt> {
    return this.receive({ surface: 'web', messageId, sender: WEB_SENDER, conversation: WEB_THREAD, text, attachments })
  }
  receiveWeChat(userId: string, messageId: string, text: string, attachments: ChatAttachment[] = [], at?: string): Promise<ChatReceipt> {
    return this.receive({ surface: 'wechat', messageId, sender: `wechat:${userId}`, conversation: `wechat:${userId}`, text, attachments, ...at ? { at } : {} })
  }
  async receive(input: ChatInput): Promise<ChatReceipt> {
    if (!/^[\w:.-]{3,200}$/i.test(input.messageId)) throw new Error('Invalid chat message ID')
    if (!input.sender || !input.conversation) throw new Error('Chat sender and conversation are required')
    const requestId = `chat:${input.messageId}`
    const presented = await this.host.sessions.presentChat(this.host.masterId, input.text, input.attachments ?? [],
      { requestId, source: input.surface === 'web' ? 'web-panel' : 'wechat' })
    const triggerId = key('trigger', CHAT_SOURCE, input.messageId)
    const thread = { source: CHAT_SOURCE, id: input.conversation }
    const trigger: Trigger = {
      id: triggerId, source: CHAT_SOURCE, threads: [thread], actor: { source: CHAT_SOURCE, id: input.sender }, human: true,
      addressed: 'direct', at: input.at ?? new Date().toISOString(), text: presented.text,
      channel: { source: CHAT_SOURCE, thread: input.conversation, address: { surface: input.surface, conversation: input.conversation, sender: input.sender } },
      meta: { kind: 'chat', messageId: input.messageId, originalText: input.text, surface: input.surface, conversation: input.conversation },
    }
    const result = await this.host.receive(trigger)
    return { requestId, triggerId, result }
  }

  /** SourceChannel implementation; stable OutboundMessage IDs become stable presentation or iLink client IDs. */
  async send(message: OutboundMessage): Promise<'sent' | 'gone'> {
    const { surface, conversation, sender } = message.channel.address
    if (surface === 'web' && conversation === WEB_THREAD && sender === WEB_SENDER) {
      await this.host.sessions.publish(this.host.masterId, `chat-reply:${message.id}`, message.text)
      return 'sent'
    }
    if (surface === 'wechat' && conversation === `wechat:${sender?.slice('wechat:'.length)}` && sender?.startsWith('wechat:')) {
      return this.host.deliverWeChat(message.id, message.text, sender.slice('wechat:'.length))
    }
    return 'gone'
  }


  kind(): SourceKind {
    return {
      kind: CHAT_SOURCE,
      title: { zh: '当前聊天', en: 'Current chat' },
      description: { zh: 'Web 面板与绑定的微信私聊；消息进入标准候选、建单和回复管线。', en: 'Web panel and bound WeChat direct messages use standard candidates, tickets, and replies.' },
      schema: z.object({}).strict(),
      fields: [], health: [],
      channel: { send: (_host, message) => this.send(message), link: () => ({ url: '', label: { zh: '当前聊天', en: 'Current chat' } }) },
      policy: {
        schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^(?:web:local|wechat:.+)$/) }).strict()).default([]) }).strict(),
        fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的聊天发送者', en: 'Chat senders who may originate work' },
          columns: [{ key: 'id', type: 'text', label: { zh: '发送者 ID', en: 'Sender ID' }, pattern: '(?:web:local|wechat:.+)' }] }],
        explicit: { zh: '名单里的发送者在当前私聊中直接提出请求。', en: 'A listed sender makes a direct request in the current conversation.' },
      },
    }
  }
}
