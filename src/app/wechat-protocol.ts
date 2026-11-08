/** Minimal iLink Bot client for QR login, messages and AES-encrypted CDN media. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

export const WECHAT_API_URL = 'https://ilinkai.weixin.qq.com'
export const WECHAT_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CHANNEL_VERSION = '2.4.10'
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

export interface WeChatAccount {
  token: string
  accountId: string
  userId: string
  baseUrl: string
  contextToken?: string
}
export interface WeChatQr { id: string; url: string }
export interface WeChatQrStatus {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect'
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
}
interface CdnMedia { encrypt_query_param?: string; aes_key?: string; full_url?: string }
export interface WeChatMessageItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { media?: CdnMedia; aeskey?: string }
  voice_item?: { text?: string }
  file_item?: { media?: CdnMedia; file_name?: string }
  video_item?: { media?: CdnMedia }
}
export interface WeChatMessage {
  message_id?: string
  client_id?: string
  from_user_id?: string
  context_token?: string
  message_type?: number
  group_id?: string
  item_list?: WeChatMessageItem[]
}
export interface WeChatUpdate {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeChatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}
export interface WeChatAttachment { name: string; mediaType: string; data: string }

interface WeChatProtocolOptions {
  fetch?: typeof fetch
  apiBaseUrl?: string
  cdnBaseUrl?: string
}
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.zip': 'application/zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
export function weChatMime(name: string): string {
  const base = name.toLowerCase()
  const dot = base.lastIndexOf('.')
  return MIME[dot < 0 ? '' : base.slice(dot)] ?? 'application/octet-stream'
}
function safeName(name: string | undefined, fallback: string): string {
  const cleaned = name?.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 200)
  return cleaned || fallback
}
function parseJson<T>(text: string): T {
  // uint64 IDs must not pass through JSON.parse as numbers.
  return JSON.parse(text.replace(/("(?:message_id|msg_id|svr_id)"\s*:\s*)(-?\d+)/g, '$1"$2"')) as T
}
function aesKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex')
  throw new Error('微信媒体 AES 密钥格式无效')
}
function imageMime(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}
async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, milliseconds)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  await promise
}

/** Implements the documented Tencent iLink Bot HTTP and encrypted CDN contracts. */
export class WeChatProtocol {
  private readonly fetchImpl: typeof fetch
  readonly apiBaseUrl: string
  readonly cdnBaseUrl: string
  constructor(options: WeChatProtocolOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.apiBaseUrl = options.apiBaseUrl ?? WECHAT_API_URL
    this.cdnBaseUrl = options.cdnBaseUrl ?? WECHAT_CDN_URL
  }

  private headers(token?: string): Record<string, string> {
    return {
      'content-type': 'application/json', authorizationType: 'ilink_bot_token',
      'x-wechat-uin': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(CLIENT_VERSION),
      ...token ? { authorization: `Bearer ${token}` } : {},
    }
  }
  private async request(baseUrl: string, path: string, options: { method?: 'GET' | 'POST'; token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)]
    if (options.signal) signals.push(options.signal)
    const response = await this.fetchImpl(new URL(path, `${baseUrl.replace(/\/$/, '')}/`), {
      method: options.method ?? 'POST', headers: this.headers(options.token),
      ...options.body === undefined ? {} : { body: JSON.stringify({ ...options.body as object, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'omp-superagent/0.1.0' } }) },
      signal: AbortSignal.any(signals),
    })
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`)
    return response
  }
  private async json<T>(...args: Parameters<WeChatProtocol['request']>): Promise<T> {
    return parseJson<T>(await (await this.request(...args)).text())
  }

  async createQr(signal?: AbortSignal): Promise<WeChatQr> {
    const result = await this.json<{ qrcode?: string; qrcode_img_content?: string }>(this.apiBaseUrl, 'ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, signal })
    if (!result.qrcode || !result.qrcode_img_content) throw new Error('微信未返回有效二维码')
    return { id: result.qrcode, url: result.qrcode_img_content }
  }
  async qrStatus(id: string, baseUrl: string, verifyCode?: string, signal?: AbortSignal): Promise<WeChatQrStatus> {
    const code = verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''
    return this.json<WeChatQrStatus>(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(id)}${code}`, { method: 'GET', timeoutMs: 35_000, signal })
  }
  async updates(account: WeChatAccount, cursor: string, timeoutMs: number, signal: AbortSignal): Promise<WeChatUpdate> {
    try {
      return await this.json<WeChatUpdate>(account.baseUrl, 'ilink/bot/getupdates', {
        token: account.token, body: { get_updates_buf: cursor }, timeoutMs, signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError' && !signal.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor }
      throw error
    }
  }

  private async sendItem(account: WeChatAccount, item: Record<string, unknown>): Promise<void> {
    const response = await this.json<{ ret?: number; errmsg?: string }>(account.baseUrl, 'ilink/bot/sendmessage', {
      token: account.token,
      body: { msg: { from_user_id: '', to_user_id: account.userId, client_id: `omp-superagent:${randomUUID()}`, message_type: 2,
        message_state: 2, context_token: account.contextToken, item_list: [item] } },
    })
    if (response.ret) throw new Error(`微信发送失败：${response.errmsg ?? `ret=${response.ret}`}`)
  }
  async sendText(account: WeChatAccount, text: string): Promise<void> {
    if (text) await this.sendItem(account, { type: 1, text_item: { text } })
  }
  async sendMedia(account: WeChatAccount, plaintext: Buffer, name: string, mediaType: string, caption = ''): Promise<void> {
    if (plaintext.length > MAX_MEDIA_BYTES) throw new Error('微信媒体不能超过 100 MiB')
    const filekey = randomBytes(16).toString('hex')
    const key = randomBytes(16)
    const cipherSize = (Math.floor(plaintext.length / 16) + 1) * 16
    const type = mediaType.startsWith('image/') ? 1 : mediaType.startsWith('video/') ? 2 : 3
    const upload = await this.json<{ upload_full_url?: string; upload_param?: string }>(account.baseUrl, 'ilink/bot/getuploadurl', {
      token: account.token,
      body: { filekey, media_type: type, to_user_id: account.userId, rawsize: plaintext.length,
        rawfilemd5: createHash('md5').update(plaintext).digest('hex'), filesize: cipherSize, no_need_thumb: true, aeskey: key.toString('hex') },
    })
    const uploadUrl = upload.upload_full_url || (upload.upload_param
      ? `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : '')
    if (!uploadUrl) throw new Error('微信未返回媒体上传地址')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    let downloadParam = ''
    for (let attempt = 0; attempt < 3 && !downloadParam; attempt++) {
      try {
        const response = await this.fetchImpl(uploadUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(encrypted), signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`微信 CDN HTTP ${response.status}`)
        downloadParam = response.headers.get('x-encrypted-param') ?? ''
        if (!downloadParam) throw new Error('微信 CDN 未返回下载参数')
      } catch (error) {
        if (attempt === 2) throw error
        await sleep(500 * (attempt + 1))
      }
    }
    if (caption) await this.sendText(account, caption)
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }
    if (type === 1) await this.sendItem(account, { type: 2, image_item: { media, mid_size: cipherSize } })
    else if (type === 2) await this.sendItem(account, { type: 5, video_item: { media, video_size: cipherSize } })
    else await this.sendItem(account, { type: 4, file_item: { media, file_name: safeName(name, 'file.bin'), len: String(plaintext.length) } })
  }

  private async download(media: CdnMedia, hexKey?: string): Promise<Buffer> {
    const url = media.full_url || `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_MEDIA_BYTES + 16) throw new Error('微信媒体不能超过 100 MiB')
    const encrypted = Buffer.from(await response.arrayBuffer())
    if (encrypted.length > MAX_MEDIA_BYTES + 16) throw new Error('微信媒体不能超过 100 MiB')
    const encodedKey = hexKey ? Buffer.from(hexKey, 'hex').toString('base64') : media.aes_key
    if (!encodedKey) return encrypted
    const decipher = createDecipheriv('aes-128-ecb', aesKey(encodedKey), null)
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
    if (plaintext.length > MAX_MEDIA_BYTES) throw new Error('微信媒体不能超过 100 MiB')
    return plaintext
  }
  async downloadAttachment(item: WeChatMessageItem, messageId: string): Promise<WeChatAttachment | undefined> {
    try {
      if (item.type === 2 && item.image_item?.media) {
        const data = await this.download(item.image_item.media, item.image_item.aeskey)
        return { name: `wechat-${messageId}.jpg`, mediaType: imageMime(data), data: data.toString('base64') }
      }
      if (item.type === 4 && item.file_item?.media) {
        const name = safeName(item.file_item.file_name, 'file.bin')
        const data = await this.download(item.file_item.media)
        return { name, mediaType: weChatMime(name), data: data.toString('base64') }
      }
      if (item.type === 5 && item.video_item?.media) {
        const data = await this.download(item.video_item.media)
        return { name: `wechat-${messageId}.mp4`, mediaType: 'video/mp4', data: data.toString('base64') }
      }
      return undefined
    } catch (error) { throw new Error(`微信附件下载失败：${error instanceof Error ? error.message : String(error)}`) }
  }
}
