/**
 * Claude Code kernel: a persistent Session backed by one long-lived Agent SDK `query()` in streaming-input mode.
 * It exposes the same contract as an OMP AgentSession (events, durable custom-message journal, background jobs), so
 * delivery, executor and Watchdog code is kernel-agnostic.
 */
import { createSdkMcpServer, query as sdkQuery, tool as sdkTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from 'zod'
import type { Tool } from '../app/tools/tool.ts'
import { Journal } from './journal.ts'
import { type KernelContent, type KernelEvent, type KernelJob, type KernelJobs, type KernelMessage, type KernelSession } from './types.ts'

export const MCP_SERVER = 'omp'
/** The name Claude Code gives an application tool. */
export const mcpToolName = (name: string): string => `mcp__${MCP_SERVER}__${name}`
/** Prompts name application tools bare; Claude Code prefixes MCP tools, so rewrite whole-word mentions. */
export function rewriteToolNames(text: string, names: readonly string[]): string {
  if (!names.length) return text
  const pattern = new RegExp(`(?<![\\w:-])(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'g')
  return text.replace(pattern, (_, name: string) => mcpToolName(name))
}

export type Effort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** OMP thinking levels onto Claude Code's: undefined for `auto` (model default). */
export function effortOf(level: string | undefined): Effort | undefined {
  if (!level || level === 'auto') return undefined
  if (level === 'off') return 'off'
  return level === 'minimal' ? 'low' : level as Effort
}

export type GuardResult = { block: string } | { input: Record<string, unknown> } | undefined
export interface ClaudeOptions {
  cwd: string
  systemPrompt: string
  tools: Tool[]
  /** Claude Code built-in tools the model may use. */
  builtinTools: string[]
  model?: string | undefined
  effort?: Effort | undefined
  agents?: Record<string, { description: string; prompt: string; tools: string[] }>
  /** Project CLAUDE.md and settings load for workers only. */
  projectSettings?: boolean
  guard?: (toolName: string, input: Record<string, unknown>) => Promise<GuardResult> | GuardResult
  env?: Record<string, string | undefined>
  maxTurns?: number
  persist?: boolean
  /** Test seam. */
  query?: typeof sdkQuery
}

/** Application tool → in-process MCP server definition. */
export function toolServer(tools: Tool[]): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({ name: MCP_SERVER, tools: tools.map(item => {
    const shape = item.schema instanceof z.ZodObject ? item.schema.shape : {}
    return sdkTool(item.name, item.description, shape as Record<string, z.ZodType>, async (args: unknown, extra: unknown) => {
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal
      try {
        const result = await item.execute(item.schema.parse(args), signal)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    }, { alwaysLoad: true })
  }) })
}

/** Variables of an enclosing interactive Claude Code session; a kernel process must not inherit them. */
const SESSION_VARIABLES = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT']
let userEnvironment: Record<string, string> | undefined
/**
 * Gateway and model variables from the user's Claude Code settings, for a service started outside a Claude Code shell.
 * User settings themselves are not loaded (no user hooks, plugins or memory reach a Session); process variables win.
 */
export function userClaudeEnvironment(file = join(homedir(), '.claude', 'settings.json')): Record<string, string> {
  if (userEnvironment && file === join(homedir(), '.claude', 'settings.json')) return userEnvironment
  let found: Record<string, string> = {}
  try {
    const env = (JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> }).env ?? {}
    found = Object.fromEntries(Object.entries(env).flatMap(([name, value]) =>
      /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name) && typeof value === 'string' ? [[name, value]] : []))
  } catch { /* no user settings */ }
  if (file === join(homedir(), '.claude', 'settings.json')) userEnvironment = found
  return found
}

let listed: { at: number; key: string; models: { id: string; provider: string; name: string }[] } | undefined
/**
 * The models the backend serves, from its Models API (`ANTHROPIC_BASE_URL`, with the credentials a Session uses), so a
 * new model appears without a code change. Cached for a minute.
 * @throws when the backend cannot be reached or refuses the request.
 */
export async function listClaudeModels(env: Record<string, string | undefined> = { ...userClaudeEnvironment(), ...process.env },
  now = Date.now()): Promise<{ id: string; provider: string; name: string }[]> {
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '')
  const key = `${base}\n${env.ANTHROPIC_AUTH_TOKEN ?? ''}\n${env.ANTHROPIC_API_KEY ?? ''}`
  if (listed && listed.key === key && now - listed.at < 60_000) return listed.models
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01',
    ...env.ANTHROPIC_AUTH_TOKEN ? { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } : {}, ...env.ANTHROPIC_API_KEY ? { 'x-api-key': env.ANTHROPIC_API_KEY } : {} }
  const models: { id: string; provider: string; name: string }[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const response = await fetch(`${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Model list request failed: HTTP ${response.status}`)
    const body = await response.json() as { data?: { id?: unknown; display_name?: unknown }[]; has_more?: boolean; last_id?: string }
    for (const model of body.data ?? []) {
      if (typeof model.id !== 'string' || models.some(other => other.id === model.id)) continue
      models.push({ id: model.id, provider: 'anthropic', name: typeof model.display_name === 'string' && model.display_name ? model.display_name : model.id })
    }
    if (!body.has_more || !body.last_id || body.last_id === after) break
    after = body.last_id
  }
  listed = { at: now, key, models }
  return models
}

function baseOptions(options: ClaudeOptions, extra: Partial<Options>): Options {
  const effort = options.effort
  const env: Record<string, string | undefined> = { ...userClaudeEnvironment(), ...process.env, ...options.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
  for (const name of SESSION_VARIABLES) delete env[name]
  return {
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    tools: options.builtinTools,
    mcpServers: options.tools.length ? { [MCP_SERVER]: toolServer(options.tools) } : {},
    strictMcpConfig: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: options.projectSettings ? ['project'] : [],
    ...options.model ? { model: options.model } : {},
    ...effort === 'off' ? { thinking: { type: 'disabled' as const } } : effort ? { effort } : {},
    ...options.agents ? { agents: options.agents } : {},
    ...options.maxTurns ? { maxTurns: options.maxTurns } : {},
    ...options.guard ? { hooks: { PreToolUse: [{ hooks: [async (input: { tool_name?: string; tool_input?: unknown }) => {
      const result = await options.guard!(input.tool_name ?? '', (input.tool_input ?? {}) as Record<string, unknown>)
      if (!result) return {}
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
        ...'block' in result ? { permissionDecision: 'deny' as const, permissionDecisionReason: result.block }
          : { permissionDecision: 'allow' as const, updatedInput: result.input } } }
    }] }] } } : {},
    env,
    ...extra,
  } as Options
}

/** One stateless, in-memory turn (Sidecar, Watchdog): the final result text. */
export async function runClaudeOnce(options: ClaudeOptions, prompt: string, timeoutMs: number, lifetime: AbortSignal, abortResolves = false): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error(`Claude Code turn timed out after ${timeoutMs}ms`)) }, timeoutMs)
  const onAbort = () => { controller.abort(new Error('neo-agent stopped')) }
  lifetime.addEventListener('abort', onAbort, { once: true })
  const run = (options.query ?? sdkQuery)({ prompt, options: baseOptions(options, { persistSession: false, abortController: controller }) })
  let text = '', error: string | undefined
  try {
    for await (const message of run) {
      if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        const parts = message.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
        if (parts.length) text = parts.join('\n')
      } else if (message.type === 'result') {
        if (message.subtype === 'success' && !message.is_error) text = message.result || text
        else error = ('errors' in message ? message.errors?.join('; ') : undefined) || message.subtype
      }
    }
  } catch (cause) {
    if (controller.signal.aborted) {
      if (abortResolves && lifetime.aborted) return text.trim()
      throw controller.signal.reason instanceof Error ? controller.signal.reason : cause
    }
    throw cause
  } finally {
    clearTimeout(timer)
    lifetime.removeEventListener('abort', onAbort)
    run.close()
  }
  if (controller.signal.aborted) {
    if (abortResolves && lifetime.aborted) return text.trim()
    throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Claude Code turn was aborted')
  }
  if (error) throw new Error(`Claude Code turn failed: ${error}`)
  return text.trim()
}

/** All descendants of `root`, from /proc. */
export function descendantPids(root: number): number[] {
  const parent = new Map<number, number[]>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(fields[1])
      const list = parent.get(ppid) ?? []
      list.push(Number(entry))
      parent.set(ppid, list)
    } catch { /* process exited */ }
  }
  const found: number[] = []
  const queue = [root]
  while (queue.length) for (const child of parent.get(queue.shift()!) ?? []) { found.push(child); queue.push(child) }
  return found
}

type Block = KernelContent
function userContent(content: Block): SDKUserMessage['message']['content'] {
  if (typeof content === 'string') return content
  return (content as Record<string, unknown>[]).map(part => part.type === 'image' && typeof part.data === 'string'
    ? { type: 'image' as const, source: { type: 'base64' as const, media_type: String(part.mimeType) as 'image/png', data: part.data } }
    : { type: 'text' as const, text: typeof part.text === 'string' ? part.text : '' })
}

interface Task { id: string; type: KernelJob['type']; label: string; startTime: number; progress?: string; ambient: boolean; nested: boolean }

/** One persistent Claude Code Session: owns the SDK query, its journal, background tasks and turn lifecycle. */
export class ClaudeSession implements KernelSession {
  readonly asyncJobManager: KernelJobs
  readonly agent = {
    /** Hooks run before a submitted message reaches Claude Code, so a delivery is durable and accepted before the model acts on it. */
    addBeforeModelCallHook: (hook: () => Promise<void>): (() => void) => { this.hooks.add(hook); return () => { this.hooks.delete(hook) } },
    /** The model is shown this content on its next turn; its transcript entry is the custom entry appended right after. */
    appendMessage: (message: KernelMessage): void => { this.shown.add(message.content) },
  }
  private readonly hooks = new Set<() => Promise<void>>()
  private readonly shown = new Set<unknown>()
  private sending: Promise<void> = Promise.resolve()
  private unsent = 0
  private generation = 0
  /** Submitted messages Claude Code has not taken into a turn yet. */
  private readonly outstanding = new Set<string>()
  /** Task notifications since the last turn began: a wake caused only by acknowledged ones is swallowed. */
  private wake = { acknowledged: 0, real: 0 }
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private readonly queue: SDKUserMessage[] = []
  private notify: (() => void) | undefined
  private inputClosed = false
  private run: Query | undefined
  private pump: Promise<void> = Promise.resolve()
  private pid: number | undefined
  private disposed = false
  private inTurn = false
  private submitted = 0
  private suppressing = false
  private waiters: ((ran: boolean) => void)[] = []
  private readonly tasks = new Map<string, Task>()
  private readonly acknowledged = new Set<string>()

  constructor(readonly journal: Journal, private readonly options: ClaudeOptions) {
    journal.contextFilter = entry => entry.type === 'custom_message' && this.shown.delete(entry.content)
    this.asyncJobManager = {
      getRunningJobs: filter => this.jobs(!!filter?.ownerId),
      acknowledgeDeliveries: ids => { for (const id of ids) this.acknowledged.add(id) },
      cancel: id => {
        if (!this.tasks.has(id) || !this.run) return false
        void this.run.stopTask(id).catch(() => {})
        return true
      },
    }
  }

  get sessionManager(): Journal { return this.journal }
  get sessionFile(): string { return this.journal.file }
  get isDisposed(): boolean { return this.disposed }
  get isStreaming(): boolean { return this.inTurn }
  get hasAdmittedSubmission(): boolean { return this.submitted > 0 }
  get messages(): KernelMessage[] { return this.journal.messages() }
  subscribe(listener: (event: KernelEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(event: KernelEvent): void { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* listener faults never break the kernel */ } } }

  getLastAssistantText(): string | undefined {
    const last = this.messages.filter(message => message.role === 'assistant').at(-1)
    if (!last || !Array.isArray(last.content)) return undefined
    const text = (last.content as { type?: string; text?: string }[]).flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n')
    return text || undefined
  }

  async flushToDisk(): Promise<void> { await this.journal.flush() }

  /** Switch model for later turns. */
  async setModel(model: string, effort?: Effort): Promise<void> {
    this.options.model = model
    this.options.effort = effort
    await this.run?.setModel(model).catch(() => {})
    if (effort && effort !== 'off') await this.run?.applyFlagSettings({ effortLevel: effort }).catch(() => {})
  }

  private iterable(generation: number): AsyncIterable<SDKUserMessage> {
    const self = this
    return { async *[Symbol.asyncIterator]() {
      for (;;) {
        if (self.inputClosed || self.generation !== generation) return
        const next = self.queue.shift()
        if (next) { yield next; continue }
        await new Promise<void>(resolve => { self.notify = resolve })
      }
    } }
  }

  private start(): Query {
    if (this.run) return this.run
    const resumed = this.journal.claudeSessionId
    const sessionId = resumed ?? randomUUID()
    const spawnClaudeCodeProcess: Options['spawnClaudeCodeProcess'] = spawnOptions => {
      const child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env as NodeJS.ProcessEnv,
        signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'inherit'] })
      this.pid = child.pid
      return child as never
    }
    const generation = ++this.generation
    const run = this.run = (this.options.query ?? sdkQuery)({ prompt: this.iterable(generation), options: baseOptions(this.options,
      { ...resumed ? { resume: resumed } : { sessionId }, persistSession: this.options.persist ?? true, spawnClaudeCodeProcess,
        extraArgs: { 'replay-user-messages': null } }) })
    this.journal.setClaudeSession(sessionId)
    this.pump = this.consume(run).then(() => { this.exited(generation) }, (error: unknown) => { this.exited(generation, error) })
    return run
  }

  private startTurn(): void {
    if (this.inTurn) return
    this.inTurn = true
    this.wake = { acknowledged: 0, real: 0 }
    this.emit({ type: 'agent_start' })
  }
  private endTurn(): void {
    if (!this.inTurn) return
    this.inTurn = false
    this.submitted = 0
    const live = [...this.tasks.values()].some(task => !task.ambient)
    this.emit(live ? { type: 'agent_end', isTerminal: false, awaitingAsyncWork: true } : { type: 'agent_end', isTerminal: true })
    for (const resolve of this.waiters.splice(0)) resolve(true)
  }
  /** The Claude Code process ended: its background tasks are gone, and the next message starts a new one that resumes the Session. */
  private exited(generation: number, error?: unknown): void {
    if (this.disposed || generation !== this.generation) return
    const awaited = [...this.tasks.values()].some(task => !task.ambient)
    this.run = undefined
    this.pid = undefined
    this.tasks.clear()
    this.acknowledged.clear()
    this.outstanding.clear()
    this.suppressing = false
    this.unsent = 0
    this.generation++
    this.notify?.()
    // Idle with nothing running: the next message simply resumes. Otherwise whoever waits for this turn or its jobs must hear.
    if (!this.inTurn && !this.submitted && !awaited) return
    this.record({ role: 'assistant', content: [{ type: 'text', text: error instanceof Error ? error.message : error ? String(error) : 'Claude Code ended unexpectedly' }],
      stopReason: 'error', timestamp: Date.now() })
    this.inTurn = true
    this.endTurn()
  }
  private record(message: KernelMessage): void {
    this.journal.appendMessage(message)
    this.emit({ type: 'message_end', message })
  }

  private jobs(own = false): KernelJob[] {
    return [...this.tasks.values()].filter(task => !task.ambient && !(own && task.nested)).map(task => ({ id: task.id, type: task.type, label: task.label, startTime: task.startTime,
      ...task.progress ? { progressText: task.progress } : {},
      ...task.type === 'bash' ? { process: { command: task.label, pids: () => this.pid ? descendantPids(this.pid) : [] } } : {} }))
  }

  private async consume(run: Query): Promise<void> {
    for await (const message of run) this.handle(message)
  }

  private handle(message: SDKMessage): void {
    if (message.type === 'assistant') {
      if (message.parent_tool_use_id !== null || this.suppressing) return
      const content = message.message.content.flatMap((block): Record<string, unknown>[] => block.type === 'text' ? [{ type: 'text', text: block.text }]
        : block.type === 'tool_use' ? [{ type: 'toolCall', id: block.id, name: block.name, arguments: block.input }] : [])
      if (!content.length) return
      this.startTurn()
      this.record({ role: 'assistant', content, timestamp: Date.now(),
        stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : message.message.stop_reason === 'max_tokens' ? 'length' : 'stop' })
      return
    }
    if (message.type === 'user') {
      if ('isReplay' in message && message.isReplay) {
        // Claude Code took a submitted message into a turn.
        if (typeof message.message.content === 'string' || !message.message.content.some(block => block.type === 'tool_result')) {
          const id = message.uuid && this.outstanding.has(message.uuid) ? message.uuid : [...this.outstanding][0]
          if (id) this.outstanding.delete(id)
        }
        return
      }
      if (message.parent_tool_use_id !== null || this.suppressing || !Array.isArray(message.message.content)) return
      const results = message.message.content.flatMap(block => block.type === 'tool_result'
        ? [{ type: 'text', text: (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).slice(0, 2000) }] : [])
      if (results.length) this.record({ role: 'toolResult', content: results, timestamp: Date.now() })
      return
    }
    if (message.type === 'result') {
      if (this.suppressing) return
      if (message.is_error) {
        const errors = 'errors' in message ? message.errors?.join('; ') : undefined
        this.startTurn()
        this.record({ role: 'assistant', stopReason: 'error', timestamp: Date.now(),
          content: [{ type: 'text', text: errors || ('result' in message ? message.result : '') || message.subtype }] })
      }
      return
    }
    if (message.type !== 'system') return
    switch (message.subtype) {
      case 'init': this.journal.setClaudeSession(message.session_id); return
      case 'api_retry': this.emit({ type: 'auto_retry_start' }); return
      case 'session_state_changed':
        if (message.state === 'running') {
          if (this.inTurn) return
          if (this.wake.acknowledged && !this.wake.real) { this.suppressing = true; void this.run?.interrupt().catch(() => {}) }
          else this.startTurn()
        } else if (message.state === 'idle') {
          if (this.suppressing) { this.suppressing = false; this.wake = { acknowledged: 0, real: 0 }; return }
          // A message submitted as this turn ended runs next without a terminal end in between.
          if (this.outstanding.size || this.unsent) return
          this.endTurn()
        }
        return
      case 'background_tasks_changed': {
        const live = new Set(message.tasks.map(task => task.task_id))
        for (const id of [...this.tasks.keys()]) if (!live.has(id)) { this.tasks.delete(id); this.acknowledged.delete(id) }
        for (const task of message.tasks) {
          const known = this.tasks.get(task.task_id)
          this.tasks.set(task.task_id, { id: task.task_id, type: task.task_type === 'local_bash' ? 'bash' : task.task_type === 'local_agent' ? 'task' : 'eval',
            label: task.description, startTime: known?.startTime ?? Date.now(), ambient: !!task.ambient, nested: !!task.parent_task_id,
            ...known?.progress ? { progress: known.progress } : {} })
        }
        return
      }
      case 'task_progress': case 'task_updated': {
        const info = message as unknown as { task_id?: string; summary?: string; description?: string }
        const task = info.task_id ? this.tasks.get(info.task_id) : undefined
        if (task && (info.summary ?? info.description)) task.progress = String(info.summary ?? info.description)
        return
      }
      case 'task_notification':
        if (this.inTurn) return
        if (this.acknowledged.has(message.task_id)) this.wake.acknowledged++
        else this.wake.real++
        return
      default:
    }
  }

  async sendCustomMessage(message: { customType: string; content: Block; display: boolean; attribution?: string; details?: unknown },
    options: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' }): Promise<boolean> {
    if (this.disposed) throw new Error('Claude Code Session was disposed')
    const entry = this.journal.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution)
    this.emit({ type: 'message_end', message: { role: 'custom', customType: message.customType, content: message.content, display: message.display,
      details: message.details, ...message.attribution ? { attribution: message.attribution } : {}, timestamp: Date.now() } })
    if (!options.triggerTurn) { this.journal.markContext(entry); return false }
    const ran = new Promise<boolean>(resolve => { this.waiters.push(resolve) })
    this.submitted++
    this.unsent++
    this.startTurn()
    const sent = this.sending = this.sending.then(async () => {
      await Promise.all([...this.hooks].map(hook => hook().catch(() => {})))
      this.unsent--
      if (this.disposed) return
      const parts = [...this.journal.takeContext(), message.content]
      const content: Block = parts.every(part => typeof part === 'string') ? parts.join('\n\n')
        : parts.flatMap(part => typeof part === 'string' ? [{ type: 'text', text: part } as { type: string }] : part)
      this.start()
      const uuid = randomUUID()
      this.outstanding.add(uuid)
      // A steered message joins the running turn at its next tool boundary; a follow-up waits for the turn to finish.
      this.queue.push({ type: 'user', uuid, message: { role: 'user', content: userContent(content) }, parent_tool_use_id: null,
        ...options.deliverAs === 'followUp' ? { priority: 'later' as const } : {} } as SDKUserMessage)
      this.notify?.()
    })
    await sent
    return ran
  }

  /** Stop accepting work at once; asynchronous teardown follows in dispose(). */
  beginDispose(): void { this.disposed = true }

  async dispose(): Promise<void> {
    this.disposed = true
    this.inputClosed = true
    this.notify?.()
    this.run?.close()
    await this.pump.catch(() => {})
    for (const resolve of this.waiters.splice(0)) resolve(false)
    this.inTurn = false
    this.listeners.clear()
    await this.journal.flush().catch(() => {})
  }
}
