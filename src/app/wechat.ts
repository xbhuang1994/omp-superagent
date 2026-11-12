/** Binds one WeChat user to the persistent orchestrator Session. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { toDataURL } from 'qrcode'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import type { ChatAttachment } from './sessions.ts'
import type { ChatSource } from '../sources/chat.ts'
import { WeChatProtocol, weChatMime, type WeChatAccount, type WeChatMessage, type WeChatQr } from './wechat-protocol.ts'

export type WeChatState = 'disconnected' | 'waiting' | 'scaned' | 'verify' | 'connected' | 'error'
export interface WeChatStatus { state: WeChatState; message: string; qrCode?: string; senderId?: string }
interface WeChatHost {
  store: Pick<Store, 'get' | 'set' | 'delete'>
  chat: Pick<ChatSource, 'receiveWeChat'>
}
interface ActiveLogin { qr: WeChatQr; baseUrl: string; verifyCode?: string; controller: AbortController }
interface ActiveMonitor { controller: AbortController; task: Promise<void> }
const textOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
async function paused(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
  signal.addEventListener('abort', abort, { once: true })
  await promise
}

/** Owns QR binding, authorized inbound delivery, ordered replies, and durable reconnect state. */
export class WeChatBridge {
  private state: WeChatStatus
  private login?: ActiveLogin
  private loginTask?: Promise<void>
  private connecting?: Promise<WeChatStatus>
  private monitor?: ActiveMonitor
  constructor(private readonly host: WeChatHost, private readonly protocol = new WeChatProtocol()) {
    this.state = host.store.get(KV.wechat.account)
      ? { state: 'disconnected', message: '发现已保存的微信绑定，启动后自动恢复。' }
      : { state: 'disconnected', message: '尚未连接微信。' }
  }

  status(): WeChatStatus {
    const account = this.host.store.get(KV.wechat.account)
    return { ...this.state, ...account ? { senderId: `wechat:${account.userId}` } : {} }
  }
  async start(): Promise<void> {
    const account = this.host.store.get(KV.wechat.account)
    if (account) {
      this.state = { state: 'connected', message: '微信绑定已恢复。' }
      this.startMonitor(account)
    }
  }
  async stop(): Promise<void> {
    this.login?.controller.abort()
    this.monitor?.controller.abort()
    await Promise.allSettled([...this.loginTask ? [this.loginTask] : [], ...this.monitor ? [this.monitor.task] : []])
  }

  async connect(): Promise<WeChatStatus> {
    const account = this.host.store.get(KV.wechat.account)
    if (account) {
      if (!this.monitor) this.startMonitor(account)
      this.state = { state: 'connected', message: '微信已连接，可直接与 orchestrator 对话。' }
      return this.status()
    }
    if (this.connecting) return this.connecting
    this.connecting = this.beginLogin().finally(() => { this.connecting = undefined })
    return this.connecting
  }
  private async beginLogin(): Promise<WeChatStatus> {
    this.login?.controller.abort()
    const controller = new AbortController()
    try {
      const qr = await this.protocol.createQr(controller.signal)
      const qrCode = await toDataURL(qr.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
      const login: ActiveLogin = { qr, baseUrl: this.protocol.apiBaseUrl, controller }
      this.login = login
      this.state = { state: 'waiting', message: '使用微信扫码并确认授权。', qrCode }
      this.loginTask = this.waitForLogin(login).finally(() => {
        if (this.login === login) this.login = undefined
      })
      return this.status()
    } catch (error) {
      if (controller.signal.aborted) return this.status()
      this.state = { state: 'error', message: `获取微信二维码失败：${textOf(error)}` }
      return this.status()
    }
  }
  private async waitForLogin(login: ActiveLogin): Promise<void> {
    const deadline = Date.now() + 5 * 60_000
    try {
      while (Date.now() < deadline && this.login === login) {
        const result = await this.protocol.qrStatus(login.qr.id, login.baseUrl, login.verifyCode, login.controller.signal)
        if (this.login !== login) return
        switch (result.status) {
          case 'wait': break
          case 'scaned':
            login.verifyCode = undefined
            this.state = { state: 'scaned', message: '已扫码，请在手机微信确认。', qrCode: this.state.qrCode }
            break
          case 'need_verifycode':
            this.state = { state: 'verify', message: login.verifyCode ? '验证码不正确，请重新输入。' : '输入手机微信显示的验证码。', qrCode: this.state.qrCode }
            break
          case 'scaned_but_redirect':
            if (result.redirect_host) login.baseUrl = `https://${result.redirect_host}`
            break
          case 'confirmed': {
            if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new Error('扫码确认响应缺少账号凭据或绑定用户')
            const account: WeChatAccount = { token: result.bot_token, accountId: result.ilink_bot_id,
              userId: result.ilink_user_id, baseUrl: result.baseurl || this.protocol.apiBaseUrl }
            this.host.store.set(KV.wechat.account, account)
            this.host.store.delete(KV.wechat.cursor)
            this.state = { state: 'connected', message: '微信连接成功。' }
            this.startMonitor(account)
            return
          }
          case 'binded_redirect': {
            const account = this.host.store.get(KV.wechat.account)
            if (!account) throw new Error('微信已绑定其他实例；请先解除原绑定')
            this.state = { state: 'connected', message: '微信已连接。' }
            this.startMonitor(account)
            return
          }
          case 'expired':
            this.state = { state: 'error', message: '二维码已过期，请重新连接。' }
            return
          case 'verify_code_blocked':
            this.state = { state: 'error', message: '验证码错误次数过多，请重新扫码。' }
            return
        }
        await paused(1000, login.controller.signal)
      }
      if (this.login === login) this.state = { state: 'error', message: '连接超时，请重新获取二维码。' }
    } catch (error) {
      if (!login.controller.signal.aborted && this.login === login) this.state = { state: 'error', message: `微信连接失败：${textOf(error)}` }
    }
  }
  verify(code: string): WeChatStatus {
    if (!this.login || this.state.state !== 'verify') throw new Error('当前不需要微信验证码')
    const normalized = code.trim()
    if (!/^\d{1,16}$/.test(normalized)) throw new Error('验证码必须为数字')
    this.login.verifyCode = normalized
    this.state = { state: 'waiting', message: '验证码已提交，等待微信确认。', qrCode: this.state.qrCode }
    return this.status()
  }

  async disconnect(): Promise<WeChatStatus> {
    const tasks = [...this.loginTask ? [this.loginTask] : [], ...this.monitor ? [this.monitor.task] : []]
    this.login?.controller.abort()
    this.monitor?.controller.abort()
    this.login = undefined
    this.monitor = undefined
    await Promise.allSettled(tasks)
    this.host.store.delete(KV.wechat.account)
    this.host.store.delete(KV.wechat.cursor)
    this.state = { state: 'disconnected', message: '微信已断开，orchestrator 对话记录保留。' }
    return this.status()
  }

  private startMonitor(account: WeChatAccount): void {
    if (this.monitor) return
    const controller = new AbortController()
    const monitor: ActiveMonitor = { controller, task: Promise.resolve() }
    monitor.task = this.poll(account, controller.signal).finally(() => {
      if (this.monitor === monitor) this.monitor = undefined
    })
    this.monitor = monitor
  }
  private async poll(account: WeChatAccount, signal: AbortSignal): Promise<void> {
    let cursor = this.host.store.get(KV.wechat.cursor) ?? ''
    let timeout = 35_000
    let failures = 0
    while (!signal.aborted) {
      try {
        const update = await this.protocol.updates(account, cursor, timeout, signal)
        if (signal.aborted) return
        if (update.ret === -14 || update.errcode === -14) {
          this.state = { state: 'error', message: '微信登录已失效，请断开后重新扫码。' }
          return
        }
        if ((update.ret !== undefined && update.ret !== 0) || (update.errcode !== undefined && update.errcode !== 0)) {
          throw new Error(update.errmsg || `微信长轮询 ret=${update.ret ?? update.errcode}`)
        }
        if (update.longpolling_timeout_ms && update.longpolling_timeout_ms > 0) timeout = update.longpolling_timeout_ms
        for (const message of update.msgs ?? []) await this.receive(account, message)
        if (update.get_updates_buf) {
          cursor = update.get_updates_buf
          this.host.store.set(KV.wechat.cursor, cursor)
        }
        failures = 0
        if (this.state.state !== 'connected' || this.state.message.startsWith('微信接收暂时失败')) {
          this.state = { state: 'connected', message: '微信已连接。' }
        }
      } catch (error) {
        if (signal.aborted) return
        failures++
        this.state = { state: 'connected', message: `微信接收暂时失败，正在重试：${textOf(error)}` }
        await paused(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal).catch(() => {})
      }
    }
  }
  private async receive(account: WeChatAccount, message: WeChatMessage): Promise<void> {
    if (message.message_type !== 1 || message.group_id || message.from_user_id !== account.userId) return
    const id = message.message_id || message.client_id || createHash('sha256').update(JSON.stringify(message)).digest('hex')
    if (message.context_token && message.context_token !== account.contextToken) {
      account.contextToken = message.context_token
      this.host.store.set(KV.wechat.account, account)
    }
    const text: string[] = []
    const attachments: ChatAttachment[] = []
    for (const item of message.item_list ?? []) {
      if (item.type === 1 && item.text_item?.text) text.push(item.text_item.text)
      if (item.type === 3 && item.voice_item?.text) text.push(`[语音转写] ${item.voice_item.text}`)
      const attachment = await this.protocol.downloadAttachment(item, id)
      if (attachment) attachments.push(attachment)
    }
    if (!text.length && !attachments.length) return
    const at = typeof message.create_time_ms === 'number' ? new Date(message.create_time_ms).toISOString() : undefined
    await this.host.chat.receiveWeChat(account.userId, `wechat:${id}`, text.join('\n'), attachments, at)
  }

  /** Deliver one Outbox message only to its original bound user; stable ID makes retries idempotent. */
  async deliver(id: string, text: string, userId: string): Promise<'sent' | 'gone'> {
    const account = this.host.store.get(KV.wechat.account)
    if (!account || account.userId !== userId) return 'gone'
    await this.protocol.sendText(account, text, id)
    return 'sent'
  }
  async sendFile(path: string, caption = ''): Promise<{ sent: true; name: string }> {
    const account = this.host.store.get(KV.wechat.account)
    if (!account) throw new Error('请先在 WebUI 连接微信')
    const info = await stat(path)
    if (!info.isFile()) throw new Error('微信附件路径必须是文件')
    if (info.size > 100 * 1024 * 1024) throw new Error('微信附件不能超过 100 MiB')
    const name = basename(path)
    await this.protocol.sendMedia(account, await readFile(path), name, weChatMime(name), caption)
    return { sent: true, name }
  }
}
