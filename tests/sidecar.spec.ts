import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { WEB_SENDER } from '../src/sources/chat.ts'
import type { ChatReceipt } from '../src/sources/chat.ts'
import { incomingText, jsonText, startOmpOpenAIServer, writeFixtureModels, type FixtureRequest } from './fixtures/omp-openai-server.ts'

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
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : ''
const requestText = (request: FixtureRequest): string => request.messages.map(message => textOf(message.content)).join('\n')
const candidateOf = (incoming: string): Record<string, unknown> | undefined =>
  jsonText(incoming.split('\n').filter(line => line.includes('"kind":"candidate"')).at(-1) ?? incoming)
const systemText = (request: FixtureRequest): string => {
  const sys = request.messages.find(message => message.role === 'system' || message.role === 'developer')
  return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '')
}

it('shares static worker prefixes, delivers single-hop direct_reply, and coalesces a 3-message burst into one read-only sidecar reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-sidecar-burst-'))
  const workerPrompts: string[] = []
  let firstTicketId = ''
  let workerCallsAfterComplete = 0
  let burstRoutingCalls = 0

  const provider = await startOmpOpenAIServer(request => {
    const tools = request.tools?.map(tool => tool.function?.name ?? '') ?? []
    const isSidecar = tools.includes('sidecar_reply')
    const isWorker = tools.includes('orchestrator_report')
    const incoming = incomingText(request)
    const full = requestText(request)

    if (isSidecar) {
      if (full.includes('"sent":true')) return { content: 'Done.' }
      if (full.includes('SHARPE_MONTHLY_PRUNED=1.68')) {
        return { toolCalls: [{ name: 'sidecar_reply', arguments: {
          text: '结论：月周期9维精简版更简洁高效（夏普1.68 vs 三周期融合1.67，调仓与运维成本低一半），实盘优先推荐月周期精简方案。',
        } }] }
      }
      return { toolCalls: [{ name: 'read', arguments: { path: 'RESULTS.md' } }] }
    }
    if (isWorker) {
      if (firstTicketId && runtime.store.tickets.get(firstTicketId)?.ended && full.includes(firstTicketId)) {
        workerCallsAfterComplete++
      }
      if (!request.messages.some(message => message.role === 'tool')) workerPrompts.push(systemText(request))
      if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
      return { toolCalls: [{ name: 'orchestrator_report', arguments: {
        state: 'ready',
        summary: 'Research completed; detailed table in RESULTS.md.',
        direct_reply: full.includes('运行多周期实验') ? '多周期实验已完成。' : '辅助对照实验已完成。',
      } }] }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
    const card = candidateOf(incoming)
    const triggerId = typeof card?.trigger_id === 'string' ? card.trigger_id : ''
    if (incoming.includes('可操作性好')) {
      burstRoutingCalls++
      return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{
        kind: 'sidecar', trigger_id: triggerId, ticket_id: firstTicketId, note: '对比总结与可操作性评估',
      }] } }] }
    }
    const isFirst = card?.text === '运行多周期实验'
    return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{
      kind: 'accept', trigger_id: triggerId,
      title: isFirst ? '多周期实验' : '辅助对照实验',
      worktree_name: isFirst ? 'multi-period-study' : 'control-study',
      acknowledgement: isFirst ? '开始多周期实验。' : '开始辅助对照实验。',
    }] } }] }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  let burstWindowMs = 0
  const runtime = new Runtime(machineOf(settings), settings, { get webBurstMs() { return burstWindowMs } })
  try {
    await runtime.ready
    await post(runtime, '运行多周期实验', 'web:sc-1')
    await post(runtime, '运行辅助对照实验', 'web:sc-2')
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '多周期实验已完成。')).toBe(true)
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '辅助对照实验已完成。')).toBe(true)
    }, { timeout: 15_000 })

    // Static prefix sharing: both workers received byte-identical system prompts despite different ticket IDs and directories.
    expect(workerPrompts.length).toBeGreaterThanOrEqual(2)
    expect(workerPrompts[0]).toBe(workerPrompts[1])

    const firstTicket = runtime.store.tickets.list().find(ticket => ticket.title === '多周期实验')!
    firstTicketId = firstTicket.id
    writeFileSync(join(firstTicket.execution!.directory, 'RESULTS.md'), 'SHARPE_MONTHLY_PRUNED=1.68\nSHARPE_FUSION=1.67\n')

    // Enable 120ms burst coalescing and fire 3 consecutive follow-up questions back-to-back.
    burstWindowMs = 120
    await post(runtime, '总结一下，说结论，哪个方案好？', 'web:burst-1')
    await post(runtime, '三周期融合感觉比不上月周期减法精简后的效果好呢？', 'web:burst-2')
    await post(runtime, '帮我仔细评估一下，哪个方案简洁高效可操作性好。', 'web:burst-3')

    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text.includes('月周期9维精简版更简洁高效'))).toBe(true)
    }, { timeout: 15_000 })

    // All 3 burst messages coalesced into 1 orchestrator routing call, and the heavy worker was never woken!
    expect(burstRoutingCalls).toBe(1)
    expect(workerCallsAfterComplete).toBe(0)
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('sends an immediate acknowledgement on attach and bundles all burst inputs into one resumed worker launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-attach-ack-'))
  let ticketId = ''
  let holdWorker = false
  const releaseWorker = Promise.withResolvers<void>()
  let resumedLaunchPrompt = ''

  const provider = await startOmpOpenAIServer(async request => {
    const tools = request.tools?.map(tool => tool.function?.name ?? '') ?? []
    const isWorker = tools.includes('orchestrator_report')
    const incoming = incomingText(request)
    const full = requestText(request)

    if (isWorker) {
      if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
      if (full.includes('"assignment":2')) {
        resumedLaunchPrompt = incoming
        if (holdWorker) await releaseWorker.promise
        return { toolCalls: [{ name: 'orchestrator_report', arguments: {
          state: 'ready', summary: 'Updated backtest with both constraints.', direct_reply: '两项新增约束已合并重跑完成。',
        } }] }
      }
      return { toolCalls: [{ name: 'orchestrator_report', arguments: {
        state: 'ready', summary: 'Initial run done.', direct_reply: '首轮回测已完成。',
      } }] }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done.' }
    const card = candidateOf(incoming)
    const triggerId = typeof card?.trigger_id === 'string' ? card.trigger_id : ''
    if (incoming.includes('换手上限')) {
      return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{
        kind: 'attach', trigger_id: triggerId, ticket_id: ticketId,
        acknowledgement: '收到，正在将单边千二成本与换手上限一并加入模型重跑，跑完立刻发你。',
      }] } }] }
    }
    return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{
      kind: 'accept', trigger_id: triggerId, title: '初始回测', worktree_name: 'initial-backtest', acknowledgement: '开始首轮回测。',
    }] } }] }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  let burstWindowMs = 0
  const runtime = new Runtime(machineOf(settings), settings, { get webBurstMs() { return burstWindowMs } })
  try {
    await runtime.ready
    await post(runtime, '跑一版初始回测', 'web:init-1')
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.text === '首轮回测已完成。')).toBe(true)
    }, { timeout: 15_000 })
    ticketId = runtime.store.tickets.list()[0]!.id

    // Hold the worker while verifying that attach's acknowledgement reaches the user immediately!
    holdWorker = true
    burstWindowMs = 80
    const firstFollow = await post(runtime, '加上单边千二成本压测', 'web:att-1')
    const secondFollow = await post(runtime, '再加上单次调仓换手上限 30%', 'web:att-2')
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.text === '收到，正在将单边千二成本与换手上限一并加入模型重跑，跑完立刻发你。')).toBe(true)
    }, { timeout: 15_000 })

    // Also attach firstFollow if only primary was attached by the single route item — or verify resumed launch carries waiting inputs.
    releaseWorker.resolve()
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.text === '两项新增约束已合并重跑完成。')).toBe(true)
    }, { timeout: 15_000 })
    expect(resumedLaunchPrompt).toContain(firstFollow.triggerId)
    expect(resumedLaunchPrompt).toContain(secondFollow.triggerId)
  } finally {
    releaseWorker.resolve()
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
