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

vi.setConfig({ testTimeout: 30_000 })
let dir: string
let server: OmpFixture
let store: Store
let sessions: OMPSessions
let panel: WebPanel
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
  panel = new WebPanel({ enabled: true, host: '127.0.0.1', port: 0 }, 'main', sessions)
  await panel.start()
})
afterEach(async () => {
  await panel.stop()
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
  expect((await response.json()).requestId).toMatch(/^web:/)
  let messages: { role: string; text: string }[] = []
  await vi.waitFor(async () => {
    const result = await fetch(`${panel.url}api/messages`)
    messages = (await result.json()).messages
    expect(messages.some(message => message.role === 'assistant' && message.text === 'Panel reply')).toBe(true)
  })
  expect(messages.some(message => message.role === 'user' && message.text === 'Hello panel')).toBe(true)
  expect(server.requests).not.toHaveLength(0)
})

it('rejects cross-origin posts and invalid input', async () => {
  const cross = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'bad' }) })
  expect(cross.status).toBe(403)
  const invalid = await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }) })
  expect(invalid.status).toBe(400)
})
it('accepts same-origin browser requests on a wildcard LAN listener', async () => {
  const lan = new WebPanel({ enabled: true, host: '0.0.0.0', port: 0 }, 'main', sessions)
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
    expect(runtime.configured()).toBe(false)
    expect((await fetch(`${runtime.web.url}api/health`)).status).toBe(200)
    const response = await fetch(`${runtime.web.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Web only' }) })
    expect(response.status).toBe(202)
  } finally { await runtime.stop() }
})

