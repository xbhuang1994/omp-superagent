import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { key } from '../src/core/index.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { WEB_SENDER } from '../src/sources/chat.ts'
import type { ChatReceipt } from '../src/sources/chat.ts'
import { coreReply, incomingText, jsonText, startOmpOpenAIServer, writeFixtureModels } from './fixtures/omp-openai-server.ts'

vi.setConfig({ testTimeout: 30_000 })
function config(dir: string, allowed = true) {
  return Config.parse({ stateDir: dir, agentDir: join(dir, 'omp'), web: { enabled: true, host: '127.0.0.1', port: 0 },
    sources: { chat: { enabled: true, config: {} } },
    policy: { sources: { chat: { allowed: allowed ? [{ id: WEB_SENDER }] : [] } } },
    eval: { model: { provider: 'fixture', model: 'fixture' } }, executor: { model: { provider: 'fixture', model: 'fixture' } } })
}
async function post(runtime: Runtime, text: string, messageId: string): Promise<ChatReceipt> {
  const response = await fetch(`${runtime.web.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, messageId }) })
  expect(response.status).toBe(202)
  return await response.json() as ChatReceipt
}

it('runs chat requests through candidates, tickets and durable replies across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-chat-source-'))
  let ticketId = ''
  const provider = await startOmpOpenAIServer(request => {
    const incoming = incomingText(request)
    const worker = request.tools?.some(tool => tool.function?.name === 'orchestrator_report')
    // A chat message reaches no worker by itself: the main Session attaches the follow-up to the one ticket it continues.
    if (!worker && incoming.includes('补充：保留现有回测口径')) return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'attach',
      trigger_id: String(jsonText(incoming)?.trigger_id), ticket_id: ticketId, note: 'Follows the backtest check' }] } }] }
    return coreReply(request)
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  let runtime = new Runtime(machineOf(settings), settings)
  try {
    await runtime.ready
    expect(runtime.configured()).toBe(true)
    const receipt = await post(runtime, '检查 /data/crypto/research/bt20261005 的工程回测', 'web:acceptance-1')
    expect(receipt.result).toBe('stored')
    await vi.waitFor(() => { expect(runtime.store.tickets.list()).toHaveLength(1) })
    const ticket = runtime.store.tickets.list()[0]!
    ticketId = ticket.id
    expect(ticket).toMatchObject({ origin: { triggerId: receipt.triggerId }, mandate: { strength: 'explicit', actor: { source: 'chat', id: WEB_SENDER } } })
    expect(ticket.channels[0]).toMatchObject({ source: 'chat', thread: 'web:main', address: { surface: 'web', conversation: 'web:main', sender: WEB_SENDER } })
    const candidateMessage = runtime.sessions.get(runtime.masterId)?.messages.find(message => message.role === 'custom'
      && JSON.stringify(message.details).includes('"requestId":"candidate:'))
    const candidateText = candidateMessage && 'content' in candidateMessage && typeof candidateMessage.content === 'string' ? candidateMessage.content : ''
    expect(JSON.parse(candidateText)).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: receipt.triggerId })
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === 'I will fix the fixture typo.')).toBe(true)
      expect(view.messages.some(message => message.role === 'assistant' && message.text === 'Fixture work completed.')).toBe(true)
    }, { timeout: 15_000 })

    const duplicate = await post(runtime, '检查 /data/crypto/research/bt20261005 的工程回测', 'web:acceptance-1')
    expect(duplicate).toMatchObject({ triggerId: receipt.triggerId, result: 'duplicate' })
    expect(runtime.store.tickets.list()).toHaveLength(1)

    const followup = await post(runtime, '补充：保留现有回测口径', 'web:followup-1')
    expect(followup.triggerId).not.toBe(receipt.triggerId)
    await vi.waitFor(() => {
      expect(runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === followup.triggerId)).toBe(true)
    })
    expect(runtime.store.tickets.list()).toHaveLength(1)

    // An unrelated request is new work: it reaches no existing worker, so none has to hand it back.
    const independent = await post(runtime, '独立检查另一个工程', 'web:independent-1')
    expect(independent.triggerId).not.toBe(receipt.triggerId)
    await vi.waitFor(() => { expect(runtime.store.tickets.list()).toHaveLength(2) })
    expect(runtime.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === independent.triggerId)).toBe(false)
    const second = runtime.store.tickets.list().find(item => item.origin.triggerId === independent.triggerId)
    expect(second?.channels[0]?.thread).toBe('web:main')

    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    const afterRestart = await post(runtime, '检查 /data/crypto/research/bt20261005 的工程回测', 'web:acceptance-1')
    expect(afterRestart).toMatchObject({ triggerId: receipt.triggerId, result: 'duplicate' })
    expect(runtime.store.tickets.list()).toHaveLength(2)
    expect(runtime.store.receipts.get(key('reply', ticket.id, 'Fixture work completed.'))).toMatchObject({ status: 'sent', channel: { thread: 'web:main' } })
    expect(runtime.store.triggers.get(receipt.triggerId)?.channel?.thread).toBe('web:main')
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps unlisted chat senders out of candidates and ticket creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-chat-denied-'))
  const provider = await startOmpOpenAIServer()
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir, false)
  const runtime = new Runtime(machineOf(settings), settings)
  try {
    await runtime.ready
    const receipt = await post(runtime, '创建工单修改工程', 'web:denied-1')
    expect(receipt.result).toBe('stored')
    await runtime.pump()
    await runtime.idle()
    expect(runtime.store.tickets.list()).toEqual([])
    expect(runtime.store.decisions.byThread('chat:web:main').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: [receipt.triggerId] })
    expect(provider.requests).toEqual([])
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('answers chatter naturally without creating a ticket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-chat-chatter-'))
  let triggerId = ''
  const provider = await startOmpOpenAIServer(request => {
    if (!request.messages.some(message => message.role === 'tool')) return { toolCalls: [{ name: 'orchestrator_route', arguments: {
      decisions: [{ kind: 'ignore', trigger_id: triggerId, reason: 'ordinary chatter', answer: '哈哈，收到，我放松点，不整官方腔了。你想聊啥？' }],
    } }] }
    return { content: 'Done' }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  const runtime = new Runtime(machineOf(settings), settings)
  try {
    await runtime.ready
    const receipt = await post(runtime, '你好，今天怎么样？', 'web:chatter-1')
    triggerId = receipt.triggerId
    await vi.waitFor(() => {
      expect(runtime.store.decisions.byThread('chat:web:main').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: [receipt.triggerId] })
    })
    expect(runtime.store.tickets.list()).toEqual([])
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { text: string }[] }
      expect(view.messages.some(message => message.text === '哈哈，收到，我放松点，不整官方腔了。你想聊啥？')).toBe(true)
    })
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('answers a no-work voice follow-up through the existing answer pipeline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-voice-followup-'))
  let triggerId = '', followupId = '', ticketId = ''
  const provider = await startOmpOpenAIServer(request => {
    const latest = JSON.stringify(request.messages.at(-1)?.content ?? '')
    const worker = request.tools?.some(tool => tool.function?.name === 'orchestrator_report')
    if (worker) {
      if (followupId && latest.includes(followupId)) return { toolCalls: [{ name: 'orchestrator_report', arguments: {
        state: 'dropped', summary: '好的，知道了。', reply_to_trigger_id: followupId,
      } }] }
      if (request.messages.at(-1)?.role === 'tool') {
        if (latest.includes('worker-result.txt')) return { toolCalls: [{ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Initial work ready.' } }] }
        return { content: 'Worker ready.' }
      }
      return { toolCalls: [{ name: 'write', arguments: { path: 'worker-result.txt', content: 'done\n' } }] }
    }
    if (request.messages.at(-1)?.role === 'tool') return { content: 'Done' }
    const batch = JSON.stringify(request.messages.slice(request.messages.findLastIndex(message => message.role === 'tool') + 1).map(message => message.content))
    if (batch.includes('worker_report')) {
      if (followupId && batch.includes(followupId)) return { toolCalls: [{ name: 'orchestrator_reply', arguments: {
        trigger_id: followupId, purpose: 'answer', text: '好的，知道了。',
      } }] }
      return { toolCalls: [{ name: 'orchestrator_reply', arguments: { ticket_id: ticketId, purpose: 'result', text: 'Initial work completed.' } }] }
    }
    // Only the candidate itself: the system prompt also names speech transcripts.
    if (latest.includes('语音转写')) return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'attach',
      trigger_id: String(jsonText(incomingText(request))?.trigger_id), ticket_id: ticketId }] } }] }
    return { toolCalls: [{ name: 'orchestrator_route', arguments: { decisions: [{ kind: 'accept', trigger_id: triggerId,
      title: 'Voice follow-up fixture', worktree_name: 'voice-followup-fixture', acknowledgement: 'Starting fixture.' }] } }] }
  })
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const settings = config(dir)
  const runtime = new Runtime(machineOf(settings), settings)
  try {
    await runtime.ready
    triggerId = (await post(runtime, '完成初始工单', 'web:voice-origin')).triggerId
    await vi.waitFor(() => { expect(runtime.store.tickets.list()).toHaveLength(1) })
    ticketId = runtime.store.tickets.list()[0]!.id
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { text: string }[] }
      expect(view.messages.some(message => message.text === 'Initial work completed.')).toBe(true)
    })
    followupId = (await post(runtime, '[语音转写] 好的，知道了', 'web:voice-ack')).triggerId
    await vi.waitFor(async () => {
      const view = await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
      expect(view.messages.some(message => message.role === 'assistant' && message.text === '好的，知道了。')).toBe(true)
      expect(runtime.store.receipts.get(key('reply', followupId, '好的，知道了。'))?.status).toBe('sent')
    })
    expect(runtime.store.tickets.list()).toHaveLength(1)
    // The resumed worker's first turn carries the message that resumed it: on the bare restart it would judge the ticket done without it.
    const resumedTurn = provider.requests.find(request => request.tools?.some(tool => tool.function?.name === 'orchestrator_report')
      && JSON.stringify(request.messages).includes('assignment\\":2'))
    expect(resumedTurn).toBeDefined()
    expect(JSON.stringify(resumedTurn!.messages)).toContain('This ticket ended earlier')
    expect(JSON.stringify(resumedTurn!.messages)).toContain(followupId)
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
