import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import z from 'zod'
import { OMPSessions, ompTool, type OMPSessionsHost } from '../src/app/sessions.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { Prompts } from '../src/app/prompts.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import type { Ticket } from '../src/core/index.ts'
import { startOmpOpenAIServer, writeFixtureModels, type FixtureReply, type OmpFixture } from './fixtures/omp-openai-server.ts'

vi.setConfig({ testTimeout: 30_000 })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function ticket(dir: string): Ticket {
  const at = '2026-01-01T00:00:00Z'
  return { id: 'ticket-1', title: 'Fixture ticket', decisionId: 'decision-1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'github', id: 'alice' }, scope: 'Fixture' },
    channels: [], assignments: [{ id: 'assignment-1', state: 'running', createdAt: at }], inputs: [], undelivered: [],
    createdAt: at, updatedAt: at, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    execution: { name: 'fixture', directory: dir, assignment: 'Run fixture' } }
}
function requestIds(session: NonNullable<OMPSessions['get'] extends (id: string) => infer S ? S : never>): string[] {
  return session.sessionManager.getBranch().flatMap(entry => {
    if (entry.type !== 'custom_message') return []
    const details: unknown = entry.details
    return details && typeof details === 'object' && 'requestId' in details && typeof details.requestId === 'string' ? [details.requestId] : []
  })
}
async function fixture(handler: (count: number) => FixtureReply | Promise<FixtureReply> = () => ({ content: 'ok' }), model = 'fixture') {
  const dir = mkdtempSync(join(tmpdir(), 'omp-sessions-'))
  const server = await startOmpOpenAIServer((_request, count) => handler(count))
  await writeFixtureModels(join(dir, 'omp'), server.baseUrl, ['fixture', 'fixture-two'])
  const store = new Store(join(dir, 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { model: { provider: 'fixture', model } }, executor: { model: { provider: 'fixture', model } } })
  store.saveSettings(settings)
  const prompts = new Prompts(store, () => 100000, () => [])
  const delivered: unknown[][] = [], read: unknown[][] = []
  const probe = vi.fn(async (args: unknown) => ({ echoed: z.object({ value: z.string().optional() }).parse(args).value ?? null }))
  const make = (): OMPSessions => {
    const effects = new Effects(store, new HealthBoard())
    const host: OMPSessionsHost = { store, prompts, effects, machine: { stateDir: dir, agentDir: join(dir, 'omp') }, masterId: 'orchestrator-test',
      lifetime: new AbortController().signal, closing: () => false, environment: () => [],
      engine: { inputsDelivered: (...args) => { delivered.push(args) }, inputsRead: (...args) => { read.push(args) } },
      tools: () => [{ name: 'fixture_probe', description: 'Fixture probe', schema: z.object({ value: z.string().optional() }).strict(), execute: probe }] }
    return new OMPSessions(host)
  }
  const sessions = make()
  await sessions.ready
  cleanups.push(async () => { await sessions.stopAll(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, server, store, sessions, make, probe, delivered, read }
}

it('runs a JSON Schema custom tool in restricted orchestrator and worker allowlists', async () => {
  const f = await fixture(count => count % 2 ? { toolCalls: [{ name: 'fixture_probe', arguments: { value: 'yes' } }] } : { content: 'done' })
  const main = await f.sessions.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  const mainEnd = Promise.withResolvers<void>(); main.subscribe(event => { if (event.type === 'agent_end' && event.isTerminal !== false) mainEnd.resolve() })
  await f.sessions.prompt('orchestrator-test', 'main-1', 'probe', 'queue')
  await mainEnd.promise
  const current = ticket(f.dir)
  f.store.tickets.save(current)
  const work = await f.sessions.ensure('worker-ticket-1', f.dir, 'Worker', 'worker', current)
  const workerEnd = Promise.withResolvers<void>(); work.subscribe(event => { if (event.type === 'agent_end' && event.isTerminal !== false) workerEnd.resolve() })
  await f.sessions.prompt('worker-ticket-1', 'worker-1', 'probe', 'queue')
  await workerEnd.promise
  expect(f.probe).toHaveBeenCalledTimes(2)
  expect(f.server.requests[0]?.tools?.map(tool => tool.function?.name)?.sort()).toEqual(['bash', 'fixture_probe', 'read'])
  expect(f.server.requests[2]?.tools?.map(tool => tool.function?.name)?.sort()).toEqual(['bash', 'edit', 'fixture_probe', 'read', 'write'])
})

it('blocks built-in and custom tools as soon as the Ticket ends', async () => {
  let store!: Store
  let current!: Ticket
  const f = await fixture(count => {
    if (count !== 1) return { content: 'done' }
    store.tickets.save({ ...current, ended: { at: new Date().toISOString(), by: 'human', outcome: 'stopped' } })
    return { toolCalls: [{ name: 'bash', arguments: { command: 'touch blocked.txt' } }, { name: 'fixture_probe', arguments: { value: 'blocked' } }] }
  })
  store = f.store
  current = ticket(f.dir)
  store.tickets.save(current)
  const work = await f.sessions.ensure('worker-ticket-1', f.dir, 'Worker', 'worker', current)
  const ended = Promise.withResolvers<void>(); work.subscribe(event => { if (event.type === 'agent_end' && event.isTerminal !== false) ended.resolve() })
  await f.sessions.prompt('worker-ticket-1', 'work-1', 'work', 'queue')
  await ended.promise
  expect(existsSync(join(f.dir, 'blocked.txt'))).toBe(false)
  expect(f.probe).not.toHaveBeenCalled()
  expect(work.messages.some(message => message.role === 'toolResult' && message.content.some(block => block.type === 'text' && block.text.includes('Ticket ended')))).toBe(true)
})

it('deduplicates requestId, persists holds across reopen, and injects without a turn', async () => {
  const f = await fixture()
  const main = await f.sessions.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  const ended = Promise.withResolvers<void>(); main.subscribe(event => { if (event.type === 'agent_end' && event.isTerminal !== false) ended.resolve() })
  await f.sessions.prompt('orchestrator-test', 'same-request', 'once', 'queue')
  await f.sessions.prompt('orchestrator-test', 'same-request', 'once', 'queue')
  await ended.promise
  expect(requestIds(main).filter(id => id === 'same-request')).toHaveLength(1)
  expect(f.server.requests).toHaveLength(1)
  await f.sessions.prompt('orchestrator-test', 'notice-1', 'notice', { inject: 'Notice' })
  expect(requestIds(main)).toContain('notice-1')
  expect(f.server.requests).toHaveLength(1)
  await f.sessions.stopAll()
  const reopened = f.make()
  await reopened.ready
  const restored = await reopened.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  expect(await reopened.holds('orchestrator-test', 'same-request')).toBe(true)
  expect(requestIds(restored).filter(id => id === 'same-request')).toHaveLength(1)
  await reopened.stopAll()
})

it('fails instead of recreating a missing transcript', async () => {
  const f = await fixture()
  await f.sessions.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  const file = f.store.get(KV.sessions.files('orchestrator-test'))!
  await f.sessions.stopAll()
  rmSync(file)
  const reopened = f.make(); await reopened.ready
  cleanups.push(async () => { await reopened.stopAll() })
  await expect(reopened.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')).rejects.toThrow(`orchestrator-test at ${file}`)
})

it('orders steering before follow-up delivery while a model call is running', async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture(async count => { if (count === 1) await gate.promise; return { content: `done ${count}` } })
  const main = await f.sessions.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  const ends: string[] = []
  main.subscribe(event => { if (event.type === 'agent_end' && event.isTerminal !== false) ends.push('end') })
  await f.sessions.prompt('orchestrator-test', 'first', 'first', 'queue')
  await vi.waitFor(() => { expect(f.server.requests).toHaveLength(1) })
  const follow = f.sessions.prompt('orchestrator-test', 'follow', 'follow', 'queue')
  const steer = f.sessions.prompt('orchestrator-test', 'steer', 'steer', 'steer')
  gate.resolve()
  await Promise.all([follow, steer])
  await vi.waitFor(() => { expect(f.server.requests.length).toBeGreaterThanOrEqual(3) })
  expect(requestIds(main)).toEqual(['first', 'steer', 'follow'])
})

it('overrides a restored model when configured and inherits it when null', async () => {
  const f = await fixture()
  await f.sessions.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  await f.sessions.stopAll()
  f.store.saveSettings({ ...f.store.settings(), eval: { ...f.store.settings().eval, model: { provider: 'fixture', model: 'fixture-two', thinkingLevel: 'low' } } })
  const changed = f.make(); await changed.ready
  const selected = await changed.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  expect(selected.model?.id).toBe('fixture-two')
  await changed.stopAll()
  f.store.saveSettings({ ...f.store.settings(), eval: { ...f.store.settings().eval, model: null } })
  const inherited = f.make(); await inherited.ready
  const restored = await inherited.ensure('orchestrator-test', f.dir, 'Main', 'orchestrator')
  expect(restored.model?.id).toBe('fixture-two')
  await inherited.stopAll()
})

it('adapts Zod parsing and JSON results without a model', async () => {
  const adapted = ompTool({ name: 'probe', description: 'probe', schema: z.object({ n: z.number() }),
    execute: async args => ({ doubled: args.n * 2 }) })
  const result = await adapted.execute('call', { n: 2 }, undefined, {} as never, new AbortController().signal)
  expect(result.content).toEqual([{ type: 'text', text: '{"doubled":4}' }])
  await expect(adapted.execute('call', { n: 'bad' }, undefined, {} as never, new AbortController().signal)).rejects.toThrow()
})
