import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebPanel } from '../src/app/web.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { OMPSessions } from '../src/app/sessions.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { Prompts } from '../src/app/prompts.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { startOmpOpenAIServer, writeFixtureModels, type OmpFixture } from './fixtures/omp-openai-server.ts'
import { WeChatBridge } from '../src/app/wechat.ts'
import { ChatSource, WEB_SENDER, WEB_THREAD } from '../src/sources/chat.ts'
import { WorkerView } from '../src/app/workers.ts'
import { ModelSettings } from '../src/app/model-settings.ts'
import { noGithub } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
let dir: string
let server: OmpFixture
let store: Store
let sessions: OMPSessions
let panel: WebPanel
let wechat: WeChatBridge
let chat: ChatSource
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omp-web-panel-'))
  server = await startOmpOpenAIServer(() => ({ content: 'Panel reply' }))
  await writeFixtureModels(join(dir, 'omp'), server.baseUrl)
  store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { model: { provider: 'fixture', model: 'fixture' } } }))
  const prompts = new Prompts(store, () => 100000, () => [])
  sessions = new OMPSessions({ store, prompts, effects: new Effects(store, new HealthBoard()),
    machine: { stateDir: dir, agentDir: join(dir, 'omp') }, masterId: 'main', lifetime: new AbortController().signal,
    closing: () => false, environment: () => [], engine: { inputsDelivered: () => {}, inputsRead: () => {} }, tools: () => [] })
  await sessions.ready
  await sessions.ensure('main', dir, 'Main', 'orchestrator')
  chat = new ChatSource({ sessions, masterId: 'main', receive: async trigger => {
    await sessions.prompt('main', `candidate:${trigger.id}`, JSON.stringify({ kind: 'candidate', trigger_id: trigger.id, text: trigger.text }), 'steer')
    return 'stored' as const
  }, deliverWeChat: (id, text, userId) => wechat.deliver(id, text, userId) })
  wechat = new WeChatBridge({ store, chat })
  await wechat.start()
  panel = new WebPanel({ enabled: true, host: '127.0.0.1', port: 0 }, 'main', sessions, wechat, () => sessions.resetOrchestrator(), chat, new WorkerView(store, sessions), new ModelSettings(store, sessions), noGithub)
  await panel.start()
})
afterEach(async () => {
  await panel.stop()
  await wechat.stop()
  await sessions.stopAll()
  await server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

it('serves a secure static panel and persists a real OMP chat round trip', async () => {
  const page = await fetch(panel.url)
  expect(await page.text()).toContain('OMP 对话面板')
  expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
  expect((await fetch(`${panel.url}api/health`)).status).toBe(200)
  const response = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello panel' }) })
  expect(response.status).toBe(202)
  let messages: { role: string; text: string }[] = []
  await vi.waitFor(() => { expect(server.requests).not.toHaveLength(0) })
  await chat.send({ id: 'panel-reply', kind: 'reply', text: 'Panel reply',
    channel: { source: 'chat', thread: WEB_THREAD, address: { surface: 'web', conversation: WEB_THREAD, sender: WEB_SENDER } } })
  await vi.waitFor(async () => {
    const result = await fetch(`${panel.url}api/messages`)
    messages = (await result.json()).messages
    expect(messages.some(message => message.role === 'assistant' && message.text === 'Panel reply')).toBe(true)
  })
  expect(messages.some(message => message.role === 'user' && message.text === 'Hello panel')).toBe(true)
  expect(messages).toHaveLength(2)
})

it('rejects cross-origin posts and invalid input', async () => {
  const cross = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'bad' }) })
  expect(cross.status).toBe(403)
  const invalid = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }) })
  expect(invalid.status).toBe(400)
})
it('uploads image and text attachments into OMP content and persisted history', async () => {
  const response = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Inspect attachments', attachments: [
      { name: 'pixel.png', mediaType: '', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
      { name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('hello attachment').toString('base64') },
    ] }) })
  expect(response.status).toBe(202)
  await vi.waitFor(async () => {
    const result = await fetch(`${panel.url}api/messages`)
    const { messages }: { messages: { text: string; images?: { name: string }[] }[] } = await result.json()
    expect(messages.some(message => message.images?.some(image => image.name === 'pixel.png'))).toBe(true)
  })
  const { messages }: { messages: { text: string; images?: { name: string }[] }[] } = await (await fetch(`${panel.url}api/messages`)).json()
  expect(messages.some(message => message.text.includes('hello attachment') && message.text.includes('notes.txt'))).toBe(true)
  expect(JSON.stringify(server.requests)).toContain('"type":"image_url"')
})

it('accepts arbitrary binary files, persists bytes, and infers undeclared text', async () => {
  const bytes = Buffer.from([0, 255, 1, 2, 3, 4])
  const response = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Process this file', attachments: [
      { name: 'payload.bin', mediaType: 'application/octet-stream', data: bytes.toString('base64') },
      { name: 'extensionless', mediaType: '', data: Buffer.from('inferred plain text').toString('base64') },
    ] }) })
  expect(response.status).toBe(202)
  let path = ''
  await vi.waitFor(async () => {
    const { messages }: { messages: { text: string; files?: { name: string; kind: string }[] }[] } = await (await fetch(`${panel.url}api/messages`)).json()
    const message = messages.find(message => message.files?.some(file => file.name === 'payload.bin' && file.kind === 'file'))
    path = message?.text.match(/path="([^"]+)"/)?.[1] ?? ''
    expect(path).not.toBe('')
    expect(message?.text).toContain('inferred plain text')
  })
  expect(await readFile(path)).toEqual(bytes)
  await vi.waitFor(() => { expect(JSON.stringify(server.requests)).toContain(path) })
})

it('accepts zero-byte files', async () => {
  const response = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '', attachments: [{ name: 'empty.dat', mediaType: 'application/octet-stream', data: '' }] }) })
  expect(response.status).toBe(202)
  await vi.waitFor(async () => {
    const { messages }: { messages: { files?: { name: string }[] }[] } = await (await fetch(`${panel.url}api/messages`)).json()
    expect(messages.some(message => message.files?.some(file => file.name === 'empty.dat'))).toBe(true)
  })
})

it('rejects invalid base64 and too many attachments', async () => {
  const bad = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '', attachments: [{ name: 'bad.png', mediaType: 'image/png', data: 'not-base64' }] }) })
  expect(bad.status).toBe(400)
  const many = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '', attachments: Array.from({ length: 4 }, () => ({ name: 'note.txt', mediaType: 'text/plain', data: 'eA==' })) }) })
  expect(many.status).toBe(400)
})

it('accepts same-origin browser requests on a wildcard LAN listener', async () => {
  const lan = new WebPanel({ enabled: true, host: '0.0.0.0', port: 0 }, 'main', sessions, wechat, () => sessions.resetOrchestrator(), chat, new WorkerView(store, sessions), new ModelSettings(store, sessions), noGithub)
  await lan.start()
  try {
    const url = lan.url.replace('0.0.0.0', '127.0.0.1')
    const response = await fetch(`${url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url.slice(0, -1) },
      body: JSON.stringify({ text: 'LAN hello' }) })
    expect(response.status).toBe(202)
    expect((await fetch(url)).status).toBe(200)
  } finally { await lan.stop() }
})

it('starts Runtime and accepts chat with no GitHub configuration', async () => {
  const config = Config.parse({ stateDir: dir, agentDir: join(dir, 'omp'), web: { enabled: true, host: '127.0.0.1', port: 0 },
    eval: { model: { provider: 'fixture', model: 'fixture' } } })
  const runtime = new Runtime(machineOf(config), config)
  try {
    await runtime.ready
    expect((await fetch(`${runtime.web.url}api/health`)).status).toBe(200)
    const response = await fetch(`${runtime.web.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Web only' }) })
    expect(response.status).toBe(202)
  } finally { await runtime.stop() }
})

