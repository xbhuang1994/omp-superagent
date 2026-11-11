import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { WEB_SENDER } from '../src/sources/chat.ts'
import type { ChatReceipt } from '../src/sources/chat.ts'
import type { WatchdogTimings } from '../src/app/watchdog.ts'
import { incomingText, startOmpOpenAIServer, writeFixtureModels } from './fixtures/omp-openai-server.ts'

vi.setConfig({ testTimeout: 30_000 })
function config(dir: string) {
  return Config.parse({ stateDir: dir, agentDir: join(dir, 'omp'), web: { enabled: true, host: '127.0.0.1', port: 0 },
    sources: { chat: { enabled: true, config: {} } },
    policy: { sources: { chat: { allowed: [{ id: WEB_SENDER }] } } },
    eval: { model: { provider: 'fixture', model: 'fixture' } }, executor: { model: { provider: 'fixture', model: 'fixture' } } })
}
async function post(runtime: Runtime, text: string, messageId: string): Promise<ChatReceipt> {
  const response = await fetch(`${runtime.web.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, messageId }) })
  expect(response.status).toBe(202)
  return await response.json() as ChatReceipt
}
const FAST_WATCHDOG: WatchdogTimings = {
  intervalMs: 600_000,
  longTaskMs: 20,
  idleGraceMs: 20,
  idleRecheckMs: 20,
  unrepliedGraceMs: 20,
  turnTimeoutMs: 15_000,
}

it('makes zero LLM calls on a healthy idle system, leaves progressing long jobs alone, and cancels+wakes hung jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-watchdog-long-'))
  let triggerId = '', ticketId = '', jobHung = false
  let watchdogPatrols = 0
  const provider = await startOmpOpenAIServer(request => {
    const tools = request.tools?.map(tool => tool.function?.name ?? '') ?? []
    const isWatchdog = tools.includes('watchdog_intervene')
    const isWorker = tools.includes('orchestrator_report')
    const incoming = incomingText(request)
    const allText = JSON.stringify(request.messages)

    if (isWatchdog) {
      if (request.messages.at(-1)?.role !== 'tool') {
        watchdogPatrols++
        return { toolCalls: [{ name: 'watchdog_inspect', arguments: { ticket_id: ticketId } }] }
      }
      if (allText.includes('"intervened":true') || allText.includes('"cancelled":true')) return { content: 'Intervened on hung job.' }
      if (!jobHung) return { content: 'Backtest job is making steady progress; leaving it untouched.' }
      const match = /"id":"(bg_\d+)"/.exec(allText)
      return { toolCalls: [{ name: 'watchdog_intervene', arguments: {
        action: 'cancel_job', ticket_id: ticketId, job_id: match?.[1] ?? 'bg_1', message: 'Process deadlocked with zero progress',
      } }] }
    }
    if (isWorker) {
      if (allText.includes('"reported":true')) return { content: 'Done.' }
      if (allText.includes('Process deadlocked with zero progress')) {
        return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Recovered after Watchdog stopped hung job.' } }] }
      }
      if (request.messages.at(-1)?.role === 'tool') return { content: 'Waiting on background job.' }
      return { toolCalls: [{ name: 'bash', arguments: { command: 'until [ -f never.flag ]; do sleep 0.05; done', async: true } }] }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
    if (incoming.includes('worker_report')) {
      return { toolCalls: [{ name: 'orchestrator_reply', arguments: { ticket_id: ticketId, purpose: 'result', text: '任务已在看门狗介入恢复后完成。' } }] }
    }
    return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'accept', trigger_id: triggerId,
      title: 'Long job supervision', worktree_name: 'long-job-supervision', acknowledgement: '已开始执行。' }] } }] }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  const runtime = new Runtime(machineOf(settings), settings, FAST_WATCHDOG)
  try {
    await runtime.ready
    // Quiet system: deterministic fast path skips LLM completely.
    await runtime.watchdog.tick()
    expect(provider.requests).toHaveLength(0)

    triggerId = (await post(runtime, '运行回测', 'web:wd-long-1')).triggerId
    await vi.waitFor(() => { expect(runtime.store.tickets.list()).toHaveLength(1) })
    ticketId = runtime.store.tickets.list()[0]!.id
    await vi.waitFor(() => {
      const session = runtime.sessions.get(`worker-${ticketId}`)
      expect(session?.isStreaming).toBe(false)
      expect(session?.asyncJobManager?.getRunningJobs()).toHaveLength(1)
    })

    // First patrol: job is healthy -> Watchdog inspects and leaves bg_1 running!
    await sleep(30)
    await runtime.watchdog.tick()
    expect(watchdogPatrols).toBe(1)
    expect(runtime.executor.runningJobs(ticketId)).toHaveLength(1)
    expect(runtime.store.tickets.get(ticketId)?.ended).toBeUndefined()

    // Second patrol: job is now judged hung -> Watchdog cancels bg_1 and wakes worker -> ticket completes & replies!
    jobHung = true
    await sleep(30)
    await runtime.watchdog.tick()
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '任务已在看门狗介入恢复后完成。')).toBe(true)
    }, { timeout: 15_000 })
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('wakes a stranded idle worker whose detached task finished and heals missed Outbox replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-watchdog-idle-'))
  let triggerId = '', ticketId = '', dropFirstReply = true
  const provider = await startOmpOpenAIServer(request => {
    const tools = request.tools?.map(tool => tool.function?.name ?? '') ?? []
    const isWatchdog = tools.includes('watchdog_intervene')
    const isWorker = tools.includes('orchestrator_report')
    const incoming = incomingText(request)
    const allText = JSON.stringify(request.messages)

    if (isWatchdog) {
      if (request.messages.at(-1)?.role !== 'tool') {
        return { toolCalls: [{ name: 'watchdog_inspect', arguments: { ticket_id: ticketId } }] }
      }
      if (allText.includes('"woken":true')) return { content: 'Woke stranded worker.' }
      return { toolCalls: [{ name: 'watchdog_intervene', arguments: {
        action: 'wake_worker', ticket_id: ticketId, message: 'stage5.log shows EXIT 0 while worker is idle; verify output and call orchestrator_report ready.',
      } }] }
    }
    if (isWorker) {
      if (allText.includes('"reported":true')) return { content: 'Done.' }
      if (allText.includes('[Watchdog] stage5.log shows EXIT 0')) {
        return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Detached backtest verified and curve ready.' } }] }
      }
      // Simulate worker ending its turn without a running OMP job and without orchestrator_report.
      return { content: 'Started detached run; waiting.' }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
    if (incoming.includes('worker_report') && incoming.includes('"state":"ready"')) {
      // Simulate orchestrator missing the reply on the first relay, then succeeding when Watchdog re-relays.
      if (dropFirstReply) {
        dropFirstReply = false
        return { content: ' distracted turn without orchestrator_reply ' }
      }
      return { toolCalls: [{ name: 'orchestrator_reply', arguments: { ticket_id: ticketId, purpose: 'result', text: '净值曲线已生成并交付。' } }] }
    }
    if (incoming.includes('worker_report')) return { content: 'Noted waiting state.' }
    return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'accept', trigger_id: triggerId,
      title: 'Detached backtest', worktree_name: 'detached-backtest', acknowledgement: '开始执行回测。' }] } }] }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  const runtime = new Runtime(machineOf(settings), settings, FAST_WATCHDOG)
  try {
    await runtime.ready
    triggerId = (await post(runtime, '运行回测并发送净值曲线', 'web:wd-idle-1')).triggerId
    await vi.waitFor(() => {
      const ticket = runtime.store.tickets.list()[0]
      ticketId = ticket?.id ?? ''
      expect(ticket?.assignments[0]?.report?.state).toBe('waiting')
    })
    const workDir = runtime.store.tickets.get(ticketId)!.execution!.directory
    writeFileSync(join(workDir, 'stage5.log'), 'EXIT 0\n')

    // Patrol 1: Watchdog detects stranded idle worker, inspects it, and wakes it -> worker reports ready (first orchestrator turn misses reply).
    await sleep(30)
    await runtime.watchdog.tick()
    await vi.waitFor(() => {
      expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
      expect(runtime.sessions.get(runtime.masterId)?.isStreaming).toBe(false)
    })

    // Patrol 2: Watchdog deterministic fast-path detects completed ticket missing its Outbox reply and re-relays -> reply delivered!
    await sleep(30)
    await runtime.watchdog.tick()
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '净值曲线已生成并交付。')).toBe(true)
    }, { timeout: 15_000 })
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
