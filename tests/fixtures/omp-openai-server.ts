/** Local OpenAI-completions SSE fixture for real OMP provider/model/tool loops. */
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

export interface FixtureToolCall { name: string; arguments: Record<string, unknown> }
export interface FixtureReply { content?: string; toolCalls?: FixtureToolCall[] }
export interface FixtureRequest {
  messages: { role: string; content?: unknown; tool_calls?: { function?: { name?: string; arguments?: string } }[] }[]
  tools?: { function?: { name?: string } }[]
}
export interface OmpFixture {
  baseUrl: string
  requests: FixtureRequest[]
  close(): Promise<void>
}

const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : ''
const requestText = (request: FixtureRequest): string => request.messages.map(message => textOf(message.content)).join('\n')
export const incomingText = (request: FixtureRequest): string => request.messages.slice(request.messages.findLastIndex(message => message.role === 'tool') + 1).map(message => textOf(message.content)).join('\n')
export const jsonText = (text: string): Record<string, unknown> | undefined => {
  for (const match of text.matchAll(/\{[\s\S]*\}/g)) {
    try { const value: unknown = JSON.parse(match[0]); if (value && typeof value === 'object') return value as Record<string, unknown> } catch { /* Try the next JSON object. */ }
  }
  return undefined
}
export function coreReply(request: FixtureRequest): FixtureReply {
  const text = requestText(request)
  const worker = request.tools?.some(tool => tool.function?.name === 'orchestrator_report')
  if (worker) {
    if (text.includes('"reported":true') || text.includes('"reported": true')) return { content: 'Worker ready.' }
    if (request.messages.some(message => message.role === 'tool')) {
      return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Fixture change is ready.' } }] }
    }
    return { toolCalls: [{ name: 'write', arguments: { path: 'fixture-result.txt', content: 'fixed\n' } }] }
  }
  if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
  if (incomingText(request).includes('worker_report')) {
    const ticketId = /"worker_report"\s*,\s*"ticket"\s*:\s*\{\s*"ticket_id"\s*:\s*"([^"]+)"/.exec(incomingText(request))?.[1] ?? ''
    return { toolCalls: [{ name: 'orchestrator_reply', arguments: { ticket_id: ticketId, purpose: 'result', text: 'Fixture work completed.' } }] }
  }
  const candidate = jsonText(incomingText(request))
  const triggerId = typeof candidate?.trigger_id === 'string' ? candidate.trigger_id : ''
  return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'accept', trigger_id: triggerId,
    title: 'Fix fixture typo', worktree_name: 'fix-fixture-typo', acknowledgement: 'I will fix the fixture typo.' }] } }] }
}

/** Start a loopback server; handler defaults to route → write → ready → result. */
export async function startOmpOpenAIServer(handler: (request: FixtureRequest, count: number) => FixtureReply | Promise<FixtureReply> = coreReply): Promise<OmpFixture> {
  const requests: FixtureRequest[] = []
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { void (async () => {
      const parsed = JSON.parse(body) as FixtureRequest
      requests.push(parsed)
      const reply = await handler(parsed, requests.length)
      const choice = reply.toolCalls?.length ? {
        role: 'assistant', content: reply.content ?? null,
        tool_calls: reply.toolCalls.map((call, index) => ({ index, id: `fixture-call-${requests.length}-${index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      } : { role: 'assistant', content: reply.content ?? '' }
      const chunk = { id: `chatcmpl-fixture-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: 'fixture',
        choices: [{ index: 0, delta: choice, finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop' }] }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
    })().catch(error => { response.writeHead(400).end(String(error)) }) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, close: async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

/** Write a static fixture provider; no provider discovery request is needed. */
export async function writeFixtureModels(agentDir: string, baseUrl: string, ids: string[] = ['fixture']): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  const models = ids.map(id => `      - id: ${id}\n        name: ${id}\n        api: openai-completions\n        reasoning: false\n        input: [text, image]\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 32768\n        maxTokens: 4096`).join('\n')
  await writeFile(join(agentDir, 'models.yml'), `providers:\n  fixture:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    apiKey: fixture-key\n    models:\n${models}\n`, { mode: 0o600 })
}
