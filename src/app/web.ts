/** Loopback-only static conversation panel and JSON API. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { packagePath } from '../infra/paths.ts'
import type { OMPSessions } from './sessions.ts'

interface PanelMessage { id: number; role: 'user' | 'assistant' | 'event'; text: string; at?: number }
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
    private readonly sessions: Pick<OMPSessions, 'get' | 'chat'>) {}

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
      if (request.method === 'POST' && path === '/api/chat') {
        if (request.headers['content-type'] !== 'application/json') return this.json(response, 415, { error: 'Expected application/json' })
        const body = await this.body(request)
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string') {
          return this.json(response, 400, { error: 'Expected { text: string }' })
        }
        const text = parsed.text.trim()
        if (!text || text.length > 8000) return this.json(response, 400, { error: 'Message must contain 1–8000 characters' })
        const requestId = await this.sessions.chat(this.masterId, text)
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
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'custom' && source !== 'web-panel' ? 'event' : 'user'
      const at = 'timestamp' in message && typeof message.timestamp === 'number' ? message.timestamp : undefined
      return [{ id: index, role, text, ...at === undefined ? {} : { at } }]
    })
  }

  private async body(request: IncomingMessage): Promise<string> {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 16_384) throw new Error('Request body too large')
    }
    return body
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
}
