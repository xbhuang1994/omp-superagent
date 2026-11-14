/** Claude Code kernel: event mapping, background jobs, wake suppression, durable journal and prompt/tool adaptation. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import z from 'zod'
import { createServer } from 'node:http'
import { ClaudeSession, descendantPids, effortOf, listClaudeModels, mcpToolName, rewriteToolNames, toolServer, userClaudeEnvironment, type ClaudeOptions } from '../src/kernel/claude.ts'
import { isClaudeJournal, Journal } from '../src/kernel/journal.ts'
import type { KernelEvent } from '../src/kernel/types.ts'

type Frame = Record<string, unknown>
let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'claude-kernel-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A scripted Agent SDK query: frames are pushed by the test and drained by the session's consumer. */
function fake() {
  const frames: Frame[] = []
  let wake: (() => void) | undefined
  let closed = false
  const prompts: unknown[] = []
  const calls = { interrupt: vi.fn(async () => undefined), stopTask: vi.fn(async () => {}), setModel: vi.fn(async () => {}), close: vi.fn(() => { closed = true; wake?.() }) }
  const query = ((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    // Like Claude Code with --replay-user-messages: each message is echoed when it is taken into a turn.
    void (async () => { for await (const message of params.prompt) { prompts.push(message); push({ type: 'user', isReplay: true, uuid: (message as { uuid?: string }).uuid, parent_tool_use_id: null, message: { role: 'user', content: 'echo' } }) } })()
    const iterator = (async function* () {
      for (;;) {
        const next = frames.shift()
        if (next) { yield next; continue }
        if (closed) return
        await new Promise<void>(resolve => { wake = resolve })
      }
    })()
    return Object.assign(iterator, calls, { options: params.options })
  }) as unknown as NonNullable<ClaudeOptions['query']>
  function push(...items: Frame[]): void { frames.push(...items); wake?.() }
  return { query, push, calls, prompts }
}
const state = (value: 'running' | 'idle'): Frame => ({ type: 'system', subtype: 'session_state_changed', state: value })
const text = (value: string, parent: string | null = null): Frame => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: value }], stop_reason: 'end_turn' } })
const tasks = (...ids: string[]): Frame => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map(id => ({ task_id: id, task_type: 'local_bash', description: `job ${id}` })) })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function session(overrides: Partial<ClaudeOptions> = {}) {
  const sdk = fake()
  const journal = await Journal.create(join(dir, 'sessions'), dir)
  const claude = new ClaudeSession(journal, { cwd: dir, systemPrompt: 's', tools: [], builtinTools: ['Bash'], query: sdk.query, ...overrides })
  const events: KernelEvent[] = []
  claude.subscribe(event => events.push(event))
  const send = (content: string, requestId = 'r1') => claude.sendCustomMessage({ customType: 'omp-superagent', content, display: false, details: { requestId } },
    { triggerTurn: true, deliverAs: 'steer' })
  /** Submit and wait until Claude Code has the message, as frames pushed earlier would belong to no turn of it. */
  const submit = async (content: string, requestId = 'r1') => {
    const before = sdk.prompts.length
    const run = send(content, requestId)
    await vi.waitFor(() => { if (sdk.prompts.length <= before) throw new Error('not submitted yet') })
    return { run }
  }
  return { sdk, journal, claude, events, send, submit }
}
const ends = (events: KernelEvent[]) => events.flatMap(event => event.type === 'agent_end' ? [event] : [])

it('journals the custom message before any turn, then runs one terminal turn', async () => {
  const { sdk, journal, claude, events, send } = await session()
  const appended: string[] = []
  journal.onEntryAppended = entry => { appended.push(entry.type) }
  const run = send('hello')
  expect(appended).toEqual(['custom_message'])
  expect(claude.isStreaming).toBe(true)
  expect(claude.hasAdmittedSubmission).toBe(true)
  await vi.waitFor(() => { expect(sdk.prompts).toHaveLength(1) })
  sdk.push(state('running'), text('done'), state('idle'))
  expect(await run).toBe(true)
  expect(events.map(event => event.type)).toEqual(['message_end', 'agent_start', 'message_end', 'agent_end'])
  expect(ends(events)).toEqual([{ type: 'agent_end', isTerminal: true }])
  expect(claude.getLastAssistantText()).toBe('done')
  expect(claude.isStreaming).toBe(false)
  expect(sdk.prompts).toHaveLength(1)
  await claude.flushToDisk()
  expect(await isClaudeJournal(journal.file)).toBe(true)
  await claude.dispose()
})

it('ends non-terminally while background work runs, and a task wake starts the next turn', async () => {
  const { sdk, claude, events, submit } = await session()
  const { run } = await submit('start')
  sdk.push(state('running'), tasks('b1'), text('started'), state('idle'))
  await run
  expect(ends(events)).toEqual([{ type: 'agent_end', isTerminal: false, awaitingAsyncWork: true }])
  const [job] = claude.asyncJobManager.getRunningJobs({ ownerId: 'Main' })
  expect(job).toMatchObject({ id: 'b1', type: 'bash', label: 'job b1' })
  expect(job?.process?.pids()).toEqual(expect.any(Array))
  sdk.push({ type: 'system', subtype: 'task_progress', task_id: 'b1', summary: 'compiling' })
  await settle()
  expect(claude.asyncJobManager.getRunningJobs()[0]?.progressText).toBe('compiling')
  sdk.push(tasks(), state('running'), text('finished'), state('idle'))
  await settle()
  expect(events.filter(event => event.type === 'agent_start')).toHaveLength(2)
  expect(ends(events).at(-1)).toEqual({ type: 'agent_end', isTerminal: true })
  expect(claude.getLastAssistantText()).toBe('finished')
  await claude.dispose()
})

it('cancels a job through stopTask and swallows the wake an acknowledged job would cause', async () => {
  const { sdk, claude, events, submit } = await session()
  const { run } = await submit('start')
  sdk.push(state('running'), tasks('b1'), text('started'), state('idle'))
  await run
  claude.asyncJobManager.acknowledgeDeliveries(['b1'])
  expect(claude.asyncJobManager.cancel('b1')).toBe(true)
  expect(claude.asyncJobManager.cancel('missing')).toBe(false)
  expect(sdk.calls.stopTask).toHaveBeenCalledWith('b1')
  const before = events.length
  sdk.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped' }, tasks(), state('running'), text('ignored wake'), state('idle'))
  await settle()
  expect(sdk.calls.interrupt).toHaveBeenCalledTimes(1)
  expect(events.slice(before)).toEqual([])
  expect(claude.getLastAssistantText()).toBe('started')
  // The Session still accepts the next message afterwards.
  const { run: next } = await submit('again', 'r2')
  sdk.push(state('running'), text('alive'), state('idle'))
  await next
  expect(claude.getLastAssistantText()).toBe('alive')
  await claude.dispose()
})

it('records a failed result as a final error assistant message', async () => {
  const { sdk, claude, events, submit } = await session()
  const { run } = await submit('go')
  sdk.push(state('running'), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }, state('idle'))
  await run
  const last = claude.messages.filter(message => message.role === 'assistant').at(-1)
  expect(last).toMatchObject({ stopReason: 'error' })
  expect(claude.getLastAssistantText()).toBe('boom')
  expect(ends(events)).toEqual([{ type: 'agent_end', isTerminal: true }])
  await claude.dispose()
})

it('ignores subagent transcript frames and maps api retries', async () => {
  const { sdk, claude, events, submit } = await session()
  const { run } = await submit('go')
  sdk.push(state('running'), { type: 'system', subtype: 'api_retry' }, text('inner', 'toolu_1'), text('outer'), state('idle'))
  await run
  expect(events.some(event => event.type === 'auto_retry_start')).toBe(true)
  expect(claude.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  await claude.dispose()
})

it('injects non-turn messages as context for the next turn and rejects work after beginDispose', async () => {
  const { sdk, claude, send, submit } = await session()
  expect(await claude.sendCustomMessage({ customType: 'omp-superagent', content: 'note', display: false }, { triggerTurn: false })).toBe(false)
  expect(sdk.prompts).toHaveLength(0)
  const { run } = await submit('work')
  sdk.push(state('running'), text('ok'), state('idle'))
  await run
  expect(JSON.stringify(sdk.prompts[0])).toContain('note\\n\\nwork')
  claude.beginDispose()
  expect(claude.isDisposed).toBe(true)
  await expect(send('late', 'r9')).rejects.toThrow('disposed')
  await claude.dispose()
})

it('resumes the SDK session and transcript from the journal file', async () => {
  const first = await session()
  const { run } = await first.submit('hello')
  first.sdk.push(state('running'), text('hi'), state('idle'))
  await run
  const id = first.journal.claudeSessionId
  expect(id).toBeTruthy()
  await first.claude.dispose()
  const reopened = await Journal.open(first.journal.file, dir)
  expect(reopened.claudeSessionId).toBe(id)
  expect(reopened.messages().map(message => message.role)).toEqual(['custom', 'assistant'])
  const sdk = fake()
  const options: Record<string, unknown>[] = []
  const claude = new ClaudeSession(reopened, { cwd: dir, systemPrompt: 's', tools: [], builtinTools: [], query: ((params: { options: Record<string, unknown> }) => { options.push(params.options); return sdk.query(params as never) }) as never })
  const again = claude.sendCustomMessage({ customType: 'omp-superagent', content: 'more', display: false }, { triggerTurn: true })
  await vi.waitFor(() => { expect(sdk.prompts).toHaveLength(1) })
  sdk.push(state('running'), text('again'), state('idle'))
  await again
  expect(options[0]).toMatchObject({ resume: id, persistSession: true })
  expect(options[0]).not.toHaveProperty('sessionId')
  expect((await readFile(first.journal.file, 'utf8')).split('\n').filter(Boolean).length).toBeGreaterThan(4)
  await claude.dispose()
})

it('exposes application tools through an in-process MCP server and names them with the MCP prefix', async () => {
  const execute = vi.fn(async (args: { state: string }) => ({ accepted: args.state }))
  const server = toolServer([{ name: 'orchestrator_report', description: 'Report', schema: z.object({ state: z.string() }).strict(), execute } as never])
  expect(server).toMatchObject({ type: 'sdk', name: 'omp' })
  expect(mcpToolName('orchestrator_report')).toBe('mcp__omp__orchestrator_report')
  expect(rewriteToolNames('Call orchestrator_report, then orchestrator_read. Not my_orchestrator_report.', ['orchestrator_report', 'orchestrator_read']))
    .toBe('Call mcp__omp__orchestrator_report, then mcp__omp__orchestrator_read. Not my_orchestrator_report.')
  expect(rewriteToolNames('unchanged', [])).toBe('unchanged')
})

it('maps OMP thinking levels to Claude Code effort', () => {
  expect([undefined, 'auto', 'off', 'minimal', 'low', 'high', 'max'].map(effortOf)).toEqual([undefined, undefined, 'off', 'low', 'low', 'high', 'max'])
})

it('finds descendant processes from /proc', () => {
  expect(descendantPids(process.pid)).toEqual(expect.any(Array))
  expect(descendantPids(2 ** 22 + 7)).toEqual([])
})

it('holds a submitted message back until delivery hooks finish, and sends a follow-up after the turn', async () => {
  const { sdk, claude, send } = await session()
  const gate = Promise.withResolvers<void>()
  const unhook = claude.agent.addBeforeModelCallHook(() => gate.promise)
  const run = send('steered')
  await settle()
  expect(sdk.prompts).toHaveLength(0)
  // The turn that was running ends meanwhile: no terminal end while a message is still on its way.
  sdk.push(state('idle'))
  await settle()
  expect(claude.isStreaming).toBe(true)
  gate.resolve()
  await vi.waitFor(() => { expect(sdk.prompts).toHaveLength(1) })
  expect(sdk.prompts[0]).not.toHaveProperty('priority')
  unhook()
  void claude.sendCustomMessage({ customType: 'omp-superagent', content: 'later', display: false }, { triggerTurn: true, deliverAs: 'followUp' })
  await vi.waitFor(() => { expect(sdk.prompts).toHaveLength(2) })
  expect(sdk.prompts[1]).toMatchObject({ priority: 'later' })
  sdk.push(state('running'), text('ok'), state('idle'))
  expect(await run).toBe(true)
  await claude.dispose()
})

it('keeps unsent context across a restart and shows a chat image to the model once, without a duplicate entry', async () => {
  const first = await session()
  await first.claude.sendCustomMessage({ customType: 'omp-superagent', content: 'notice', display: false }, { triggerTurn: false })
  const image = [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]
  first.claude.agent.appendMessage({ role: 'custom', content: image })
  first.journal.appendCustomMessageEntry('omp-superagent', image, true, { requestId: 'chat-1', source: 'web-panel' }, 'user')
  first.journal.appendCustomMessageEntry('omp-superagent', 'reply text', true, { requestId: 'reply-1', source: 'chat-reply' }, 'agent')
  expect(first.journal.getBranch()).toHaveLength(3)
  await first.claude.dispose()
  const reopened = await Journal.open(first.journal.file, dir)
  const sdk = fake()
  const claude = new ClaudeSession(reopened, { cwd: dir, systemPrompt: 's', tools: [], builtinTools: [], query: sdk.query })
  void claude.sendCustomMessage({ customType: 'omp-superagent', content: 'go', display: false }, { triggerTurn: true })
  await vi.waitFor(() => { expect(sdk.prompts).toHaveLength(1) })
  const content = (sdk.prompts[0] as { message: { content: { type: string; text?: string }[] } }).message.content
  expect(content.map(part => part.type)).toEqual(['text', 'text', 'image', 'text'])
  expect(content.map(part => part.text)).toEqual(['notice', 'look', undefined, 'go'])
  void claude.sendCustomMessage({ customType: 'omp-superagent', content: 'next', display: false }, { triggerTurn: true })
  await vi.waitFor(() => { expect(sdk.prompts).toHaveLength(2) })
  expect((sdk.prompts[1] as { message: { content: unknown } }).message.content).toBe('next')
  await claude.dispose()
})

it('does not swallow a real wake after an acknowledged job that never woke the Session', async () => {
  const { sdk, claude, events, submit } = await session()
  const { run } = await submit('start')
  sdk.push(state('running'), tasks('b1', 'b2'), text('started'), state('idle'))
  await run
  claude.asyncJobManager.acknowledgeDeliveries(['b1'])
  sdk.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped' }, tasks('b2'))
  await settle()
  sdk.push({ type: 'system', subtype: 'task_notification', task_id: 'b2', status: 'completed' }, tasks(), state('running'), text('b2 done'), state('idle'))
  await settle()
  expect(sdk.calls.interrupt).not.toHaveBeenCalled()
  expect(claude.getLastAssistantText()).toBe('b2 done')
  expect(ends(events).at(-1)).toEqual({ type: 'agent_end', isTerminal: true })
  await claude.dispose()
})

it('lists only the Session\'s own jobs for an owner filter', async () => {
  const { sdk, claude, submit } = await session()
  const { run } = await submit('start')
  sdk.push(state('running'), { type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'a1', task_type: 'local_agent', description: 'helper' }, { task_id: 'b9', task_type: 'local_bash', description: 'inner', parent_task_id: 'a1' }] },
  text('started'), state('idle'))
  await run
  expect(claude.asyncJobManager.getRunningJobs({ ownerId: 'Main' }).map(job => [job.id, job.type])).toEqual([['a1', 'task']])
  expect(claude.asyncJobManager.getRunningJobs()).toHaveLength(2)
  await claude.dispose()
})

it('fails the turn when Claude Code exits under it, and resumes in a new process on the next message', async () => {
  const { sdk, claude, events, submit } = await session()
  const { run } = await submit('start')
  sdk.push(state('running'), tasks('b1'), text('working'))
  await settle()
  sdk.calls.close()
  expect(await run).toBe(true)
  expect(claude.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'error' })
  expect(ends(events)).toEqual([{ type: 'agent_end', isTerminal: true }])
  expect(claude.asyncJobManager.getRunningJobs()).toEqual([])
  expect(claude.isDisposed).toBe(false)
  await claude.dispose()
})

it('carries the visible chat transcript of an OMP session file into a new journal', async () => {
  const omp = join(dir, 'omp.jsonl')
  await writeFile(omp, [
    { type: 'session', id: 'x' },
    { type: 'custom_message', id: 'a', parentId: null, timestamp: '2026-11-01T00:00:00.000Z', customType: 'omp-superagent', content: 'hi', display: true, details: { requestId: 'c1', source: 'web-panel' }, attribution: 'user' },
    { type: 'custom_message', id: 'b', parentId: 'a', timestamp: '2026-11-01T00:00:01.000Z', customType: 'omp-superagent', content: '{"card":1}', display: false, details: { requestId: 'relay-1' } },
    { type: 'message', id: 'c', message: { role: 'assistant', content: [] } },
    { type: 'custom_message', id: 'd', parentId: 'c', timestamp: '2026-11-01T00:00:02.000Z', customType: 'omp-superagent', content: 'hello', display: true, details: { requestId: 'r1', source: 'chat-reply' }, attribution: 'agent' },
  ].map(line => JSON.stringify(line)).join('\n'))
  expect(await isClaudeJournal(omp)).toBe(false)
  const journal = await Journal.create(join(dir, 'sessions'), dir)
  expect(await journal.importChat(omp)).toBe(2)
  await journal.flush()
  const reopened = await Journal.open(journal.file, dir)
  expect(reopened.getBranch().map(entry => entry.type === 'custom_message' ? entry.content : '')).toEqual(['hi', 'hello'])
  expect(reopened.takeContext()).toEqual([])
})

it('reads only gateway and model variables from user Claude Code settings', async () => {
  const file = join(dir, 'settings.json')
  await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://gateway', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1', ENABLE_TOOL_SEARCH: '1', OTHER: 'x' }, hooks: {} }))
  expect(userClaudeEnvironment(file)).toEqual({ ANTHROPIC_BASE_URL: 'http://gateway', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1' })
  expect(userClaudeEnvironment(join(dir, 'missing.json'))).toEqual({})
})

it('lists the models the backend serves, with its credentials and across pages', async () => {
  const seen: { url?: string; auth?: string }[] = []
  const server = createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization })
    if (request.headers.authorization !== 'Bearer secret') { response.writeHead(401).end('{}'); return }
    const second = request.url?.includes('after_id=a')
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(second
      ? { data: [{ id: 'b', display_name: '' }], has_more: false, last_id: 'b' }
      : { data: [{ id: 'a', display_name: 'Model A' }, { id: 'a' }, { nope: 1 }], has_more: true, last_id: 'a' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const env = { ANTHROPIC_BASE_URL: `${base}/`, ANTHROPIC_AUTH_TOKEN: 'secret' }
    expect(await listClaudeModels(env)).toEqual([{ id: 'a', provider: 'anthropic', name: 'Model A' }, { id: 'b', provider: 'anthropic', name: 'b' }])
    expect(seen).toHaveLength(2)
    await listClaudeModels(env)
    expect(seen).toHaveLength(2)
    await expect(listClaudeModels({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'wrong' })).rejects.toThrow('HTTP 401')
  } finally { server.close() }
})
