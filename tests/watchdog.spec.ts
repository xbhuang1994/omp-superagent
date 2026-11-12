import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  stallMs: 40,
  cpuOnlySilenceMs: 120,
  longTaskMs: 40,
  idleGraceMs: 20,
  idleRecheckMs: 20,
  unrepliedGraceMs: 20,
  turnTimeoutMs: 15_000,
}

it('makes zero LLM calls while long jobs produce delta, then pre-samples and cancels hung jobs in one stateless turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-watchdog-long-'))
  let triggerId = '', ticketId = ''
  let watchdogPatrols = 0, lastPatrolPayload = ''
  const provider = await startOmpOpenAIServer(request => {
    const tools = request.tools?.map(tool => tool.function?.name ?? '') ?? []
    const isWatchdog = tools.includes('watchdog_intervene')
    const isWorker = tools.includes('orchestrator_report')
    const incoming = incomingText(request)
    const allText = JSON.stringify(request.messages)

    if (isWatchdog) {
      if (request.messages.at(-1)?.role !== 'tool') {
        watchdogPatrols++
        lastPatrolPayload = incoming
        const match = /"id":"(bg_\d+)"/.exec(allText)
        return { toolCalls: [{ name: 'watchdog_intervene', arguments: {
          action: 'cancel_job', ticket_id: ticketId, job_id: match?.[1] ?? 'bg_1', message: 'Process deadlocked with zero progress',
        } }] }
      }
      return { content: 'Done.' }
    }
    if (isWorker) {
      if (allText.includes('"reported":true')) return { content: 'Done.' }
      if (allText.includes('Process deadlocked with zero progress')) {
        return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Recovered after Watchdog stopped hung job.',
          direct_reply: '任务已在看门狗介入恢复后完成。' } }] }
      }
      if (request.messages.at(-1)?.role === 'tool') return { content: 'Waiting on background job.' }
      return { toolCalls: [{ name: 'bash', arguments: {
        command: 'i=0; until [ -f never.flag ]; do if [ ! -f freeze.flag ]; then i=$((i+1)); echo "step $i" >> progress.log; fi; sleep 0.015; done',
        async: true,
      } }] }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
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

    // Progressing job: progress.log keeps growing -> multiple Watchdog ticks make ZERO LLM calls!
    await sleep(35)
    await runtime.watchdog.tick()
    await sleep(35)
    await runtime.watchdog.tick()
    expect(watchdogPatrols).toBe(0)
    expect(runtime.executor.runningJobs(ticketId)).toHaveLength(1)

    // Freeze output and wait past stallMs -> Watchdog wakes once with pre-sampled log tail and cancels bg_1 directly!
    const workDir = runtime.store.tickets.get(ticketId)!.execution!.directory
    writeFileSync(join(workDir, 'freeze.flag'), '1')
    await sleep(30)
    await runtime.watchdog.tick() // Captures frozen baseline
    await sleep(55)
    await runtime.watchdog.tick() // Detects zero file + zero CPU delta past stallMs -> stateless LLM turn!

    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '任务已在看门狗介入恢复后完成。')).toBe(true)
    }, { timeout: 15_000 })
    expect(watchdogPatrols).toBe(1)
    expect(lastPatrolPayload).toContain('progress.log')
    expect(lastPatrolPayload).toContain('step ')
    expect(lastPatrolPayload).toContain('"process_tree"')
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')

    // Stateless Watchdog leaves zero Watchdog .jsonl files on disk (only orchestrator + 1 worker).
    const jsonls = readdirSync(join(dir, 'sessions')).filter(name => name.endsWith('.jsonl'))
    expect(jsonls).toHaveLength(2)
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('pre-samples finished log tail to wake a stranded idle worker in one hop and heals missed Outbox replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-watchdog-idle-'))
  let triggerId = '', ticketId = '', dropFirstReply = true, watchdogCalls = 0
  const provider = await startOmpOpenAIServer(request => {
    const tools = request.tools?.map(tool => tool.function?.name ?? '') ?? []
    const isWatchdog = tools.includes('watchdog_intervene')
    const isWorker = tools.includes('orchestrator_report')
    const incoming = incomingText(request)
    const allText = JSON.stringify(request.messages)

    if (isWatchdog) {
      watchdogCalls++
      if (request.messages.at(-1)?.role !== 'tool') {
        expect(incoming).toContain('stage5.log')
        expect(incoming).toContain('EXIT 0')
        return { toolCalls: [{ name: 'watchdog_intervene', arguments: {
          action: 'wake_worker', ticket_id: ticketId, message: 'stage5.log shows EXIT 0 while worker is idle; verify output and call orchestrator_report ready.',
        } }] }
      }
      return { content: 'Done.' }
    }
    if (isWorker) {
      if (allText.includes('"reported":true')) return { content: 'Done.' }
      if (allText.includes('[Watchdog] stage5.log shows EXIT 0')) {
        return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Detached backtest verified and curve ready.' } }] }
      }
      return { content: 'Started detached run; waiting.' }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
    if (incoming.includes('worker_report') && incoming.includes('"state":"ready"')) {
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

    // Patrol 1: Watchdog sees stage5.log tail inline and wakes worker directly in 2 LLM requests (intervene + Done).
    await sleep(30)
    await runtime.watchdog.tick()
    await vi.waitFor(() => {
      expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
      expect(runtime.sessions.get(runtime.masterId)?.isStreaming).toBe(false)
    })
    expect(watchdogCalls).toBe(2)

    // Patrol 2: Watchdog deterministic fast-path heals missed Outbox reply with ZERO extra Watchdog LLM calls!
    await sleep(30)
    await runtime.watchdog.tick()
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '净值曲线已生成并交付。')).toBe(true)
    }, { timeout: 15_000 })
    expect(watchdogCalls).toBe(2)
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
