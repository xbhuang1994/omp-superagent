/** Loopback-only static conversation panel and JSON API. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { packagePath } from '../infra/paths.ts'
import type { ChatAttachment, OMPSessions } from './sessions.ts'
import type { WeChatBridge } from './wechat.ts'

interface AttachmentInfo { name: string; mediaType: string; kind: 'image' | 'text' | 'file' }
interface PanelMessage { id: number; role: 'user' | 'assistant' | 'event'; text: string; at?: number; images?: { name: string; mediaType: string; data: string }[]; files?: AttachmentInfo[] }
const MAX_FILES = 3, MAX_FILE_BYTES = 5 * 1024 * 1024, MAX_BODY_BYTES = 24 * 1024 * 1024

function attachmentName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Attachment name must be a string')
  const name = value.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 200)
  return name || 'attachment'
}
function attachmentData(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('Attachment data must be base64')
  const data = Buffer.from(value, 'base64')
  if (data.toString('base64') !== value || data.length > MAX_FILE_BYTES) throw new Error('Attachment data is invalid or exceeds 5 MiB')
  return data
}
function attachment(value: unknown): ChatAttachment {
  if (!value || typeof value !== 'object') throw new Error('Invalid attachment')
  const name = attachmentName('name' in value ? value.name : undefined)
  const mediaType = 'mediaType' in value && typeof value.mediaType === 'string' ? value.mediaType.trim().toLowerCase().slice(0, 200) : ''
  const data = attachmentData('data' in value ? value.data : undefined)
  return { name, mediaType, data: data.toString('base64') }
}
function messageAttachments(message: unknown): AttachmentInfo[] {
  if (!message || typeof message !== 'object' || !('details' in message) || !message.details || typeof message.details !== 'object'
    || !('attachments' in message.details) || !Array.isArray(message.details.attachments)) return []
  return message.details.attachments.flatMap(info => {
    if (!info || typeof info !== 'object' || !('name' in info) || typeof info.name !== 'string') return []
    const mediaType = 'mediaType' in info && typeof info.mediaType === 'string' ? info.mediaType : 'application/octet-stream'
    const declared = 'kind' in info && typeof info.kind === 'string' ? info.kind : ''
    const kind = declared === 'image' || declared === 'text' || declared === 'file' ? declared : mediaType.startsWith('image/') ? 'image' : 'file'
    return [{ name: info.name, mediaType, kind }]
  })
}
function messageImages(message: unknown): { name: string; mediaType: string; data: string }[] {
  if (!message || typeof message !== 'object' || !('content' in message) || !Array.isArray(message.content)) return []
  const metadata = messageAttachments(message).filter(info => info.kind === 'image')
  let imageIndex = 0
  return message.content.flatMap((block, index) => {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image' || !('data' in block) || typeof block.data !== 'string' || !('mimeType' in block) || typeof block.mimeType !== 'string') return []
    const name = metadata[imageIndex++]?.name ?? `image-${index + 1}`
    return [{ name, mediaType: block.mimeType, data: block.data }]
  })
}
interface WebOptions { enabled: boolean; host: string; port: number }

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = 'content' in message ? message.content : undefined
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return ''
    return block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : ''
  }).filter(Boolean).join('\n')
}

/** Serve the panel without cookies, CORS, remote assets or non-loopback access. */
export class WebPanel {
  private server?: Server
  private actualPort = 0
  constructor(private readonly options: WebOptions, private readonly masterId: string,
    private readonly sessions: Pick<OMPSessions, 'get' | 'chat'>, private readonly wechat: Pick<WeChatBridge, 'status' | 'connect' | 'verify' | 'disconnect'>,
    private readonly resetSession: () => Promise<void>) {}

  get url(): string { return `http://${this.options.host}:${this.actualPort}/` }

  async start(): Promise<void> {
    if (!this.options.enabled || this.server) return
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.options.port, this.options.host, resolve)
    })
    const address = this.server.address()
    if (address && typeof address === 'object') this.actualPort = address.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const origin = request.headers.origin
      const requestOrigin = `http://${request.headers.host}`
      if (origin && origin !== requestOrigin) return this.json(response, 403, { error: 'Forbidden origin' })
      const path = new URL(request.url ?? '/', this.url).pathname
      if (request.method === 'GET' && path === '/api/health') return this.json(response, 200, { ready: true })
      if (request.method === 'GET' && path === '/api/messages') return this.json(response, 200, { messages: this.messages() })
      if (request.method === 'POST' && path === '/api/session/reset') { await this.resetSession(); return this.json(response, 200, { reset: true }) }
      if (request.method === 'GET' && path === '/api/wechat') return this.json(response, 200, this.wechat.status())
      if (request.method === 'POST' && path === '/api/wechat/connect') return this.json(response, 200, await this.wechat.connect())
      if (request.method === 'POST' && path === '/api/wechat/disconnect') return this.json(response, 200, await this.wechat.disconnect())
      if (request.method === 'POST' && path === '/api/wechat/verify') {
        if (request.headers['content-type'] !== 'application/json') return this.json(response, 415, { error: 'Expected application/json' })
        const parsed: unknown = JSON.parse(await this.body(request))
        if (!parsed || typeof parsed !== 'object' || !('code' in parsed) || typeof parsed.code !== 'string') return this.json(response, 400, { error: 'Expected { code: string }' })
        return this.json(response, 200, this.wechat.verify(parsed.code))
      }
      if (request.method === 'POST' && path === '/api/chat') {
        if (request.headers['content-type'] !== 'application/json') return this.json(response, 415, { error: 'Expected application/json' })
        const body = await this.body(request)
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string') {
          return this.json(response, 400, { error: 'Expected { text: string }' })
        }
        const text = parsed.text.trim()
        const attachments = 'attachments' in parsed && parsed.attachments !== undefined
          ? (Array.isArray(parsed.attachments) ? parsed.attachments : []).slice(0, MAX_FILES + 1).map(attachment)
          : []
        if (attachments.length > MAX_FILES) return this.json(response, 400, { error: `At most ${MAX_FILES} attachments` })
        if ((!text && attachments.length === 0) || text.length > 8000) return this.json(response, 400, { error: 'Message or attachment required; text limit 8000 characters' })
        const requestId = await this.sessions.chat(this.masterId, text, attachments)
        return this.json(response, 202, { requestId })
      }
      if (request.method === 'GET' && (path === '/' || path === '/app.js' || path === '/style.css')) {
        const file = path === '/' ? 'index.html' : path.slice(1)
        const content = await readFile(packagePath('web', file))
        response.writeHead(200, { 'content-type': `${extname(file) === '.html' ? 'text/html' : extname(file) === '.js' ? 'text/javascript' : 'text/css'}; charset=utf-8`,
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'", 'cache-control': 'no-store' })
        response.end(content)
        return
      }
      this.json(response, 404, { error: 'Not found' })
    } catch (error) {
      this.json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private messages(): PanelMessage[] {
    const messages = this.sessions.get(this.masterId)?.messages ?? []
    return messages.flatMap((message, index) => {
      const text = messageText(message)
      if (!text) return []
      const source = message.role === 'custom' && message.details && typeof message.details === 'object' && 'source' in message.details ? message.details.source : undefined
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'custom' && source !== 'web-panel' && source !== 'wechat' ? 'event' : 'user'
      const at = 'timestamp' in message && typeof message.timestamp === 'number' ? message.timestamp : undefined
      const images = messageImages(message)
      const files = messageAttachments(message).filter(attachment => attachment.kind !== 'image')
      return [{ id: index, role, text, ...at === undefined ? {} : { at }, ...images.length ? { images } : {}, ...files.length ? { files } : {} }]
    })
  }

  private async body(request: IncomingMessage): Promise<string> {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > MAX_BODY_BYTES) throw new Error('Request body too large')
    }
    return body
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
}
