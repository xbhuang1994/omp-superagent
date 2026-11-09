import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import type { WorkerCard, WorkerDetail } from '../src/app/workers.ts'
import { startOmpOpenAIServer, writeFixtureModels } from './fixtures/omp-openai-server.ts'

vi.setConfig({ testTimeout: 30_000 })
it('reports live worker execution and persistent detailed progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-worker-panel-'))
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let began = false
  let ticketId = ''
  let triggerId = ''
  const provider = await startOmpOpenAIServer(async request => {
    const worker = request.tools?.some(tool => tool.function?.name === 'orchestrator_report')
      if (JSON.stringify(request.messages).includes('"reported":true')) return { content: 'Worker ready.' }
    if (worker) {
      if (!began) {
        began = true
        started.resolve()
        await gate.promise
        return { toolCalls: [{ name: 'write', arguments: { path: 'worker-result.txt', content: 'done\n' } }] }
      }
      if (request.messages.some(message => message.role === 'tool')) return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Worker verification ready.' } }] }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done' }
    const latest = JSON.stringify(request.messages.at(-1)?.content ?? '')
    if (latest.includes('worker_report')) return { toolCalls: [{ name: 'orchestrator_reply', arguments: { ticket_id: ticketId, purpose: 'result', text: 'Worker done.' } }] }
    return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'accept', trigger_id: triggerId, title: 'Verify worker panel', worktree_name: 'verify-worker-panel', acknowledgement: 'Starting worker.' }] } }] }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = Config.parse({ stateDir: dir, agentDir: join(dir, 'omp'), web: { enabled: true, host: '127.0.0.1', port: 0 },
    sources: { chat: { enabled: true, config: {} } }, policy: { sources: { chat: { allowed: [{ id: 'web:local' }] } } },
    eval: { model: { provider: 'fixture', model: 'fixture' } }, executor: { model: { provider: 'fixture', model: 'fixture' } } })
  const runtime = new Runtime(machineOf(settings), settings)
  try {
    await runtime.ready
    const response = await fetch(`${runtime.web.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: 'web:worker-trigger', text: '验证 worker 面板' }) })
    expect(response.status).toBe(202)
    triggerId = (await response.json() as { triggerId: string }).triggerId
    await started.promise
    let card = await (await fetch(`${runtime.web.url}api/workers`)).json().then((value: { workers: WorkerCard[] }) => value.workers[0]!)
    expect(card).toMatchObject({ title: 'Verify worker panel', stage: { stage: 'working' }, session: { streaming: true } })
    ticketId = card.ticketId
    gate.resolve()
    await vi.waitFor(() => { expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed') })
    card = await (await fetch(`${runtime.web.url}api/workers`)).json().then((value: { workers: WorkerCard[] }) => value.workers[0]!)
    expect(card).toMatchObject({ stage: { stage: 'ended' }, outcome: 'completed', progress: { state: 'ready', summary: 'Worker verification ready.' } })
    const detail = await (await fetch(`${runtime.web.url}api/workers/${ticketId}`)).json() as WorkerDetail
    expect(detail.recent.some(message => message.text.includes('[调用 write]'))).toBe(true)
    expect(detail.recent.some(message => message.text.includes('[调用 orchestrator_report]'))).toBe(true)
    expect(detail.directory).toContain('verify-worker-panel-')
    expect((await fetch(`${runtime.web.url}api/workers/missing`)).status).toBe(404)
  } finally {
    gate.resolve()
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
