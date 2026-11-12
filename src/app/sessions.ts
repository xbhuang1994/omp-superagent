/** Persistent OMP orchestrator and worker Sessions, with isolated tools and durable delivery. */
import { AgentRegistry, ModelRegistry, SessionManager, Settings, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  type AgentDefinition, type AgentSession, type AuthStorage, type CreateAgentSessionOptions, type CustomTool, type Skill } from '@oh-my-pi/pi-coding-agent'
import { getBundledAgent } from '@oh-my-pi/pi-coding-agent/task/agents'
import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery'
import type { ImageContent, TextContent } from '@oh-my-pi/pi-ai'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import z from 'zod'
import { key, liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '../core/index.ts'
import { workerSessionId } from '../executor/omp.ts'
import { packagePath } from '../infra/paths.ts'
import { KV } from '../kv.ts'
import type { Machine } from '../deployment.ts'
import { sidecarPrompt, watchdogPrompt } from './context.ts'
import { AgentDelivery } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { environmentSection, type Prompts } from './prompts.ts'
import { bundledSkills } from './skill-files.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'
import type { RoleModel } from '../policy.ts'

const SESSION_SETTINGS = {
  'async.enabled': false,
  'bash.autoBackground.enabled': false,
  'launch.enabled': false,
  'retry.enabled': true,
  'compaction.enabled': true,
} as const
/**
 * The orchestrator's context window is far larger than routing needs, and every candidate resends its whole history: compact
 * it early. Routing facts come from the store in each card, so a summary loses nothing a decision needs.
 */
const ORCHESTRATOR_SETTINGS = { ...SESSION_SETTINGS, 'compaction.thresholdTokens': 60_000, 'compaction.keepRecentTokens': 8_000 } as const
/**
 * Workers run long commands and subagents as OMP background jobs: a command still running after 60 s, or when a message
 * arrives, moves to the background, and each job's end wakes the worker with its result. The Executor bounds and stops them.
 */
const WORKER_SETTINGS = {
  ...SESSION_SETTINGS,
  'async.enabled': true,
  'bash.autoBackground.enabled': true,
  'bash.autoBackground.thresholdMs': 60_000,
  'compaction.thresholdTokens': 100_000,
  'compaction.keepRecentTokens': 20_000,
  'providers.cacheWarming': 'streaming',
  'task.maxConcurrency': 8,
  'task.maxRecursionDepth': 2,
} as const
const WORK_TOOLS = ['read', 'bash', 'edit', 'write']
/**
 * The only agent a worker may spawn. OMP's bundled `task` agent declares no tools, so under the worker's restricted tool
 * list it would get none; this one keeps its prompt with the worker's work tools and no model of its own, so it runs on the
 * worker's current model. It is a session agent: a discovered definition of the same name would take precedence.
 */
export const SUBAGENT = 'ticket-task'

/**
 * Explicit subagent names get the ticket's prefix: OMP registers every subagent in one process-wide registry, so two
 * workers choosing the same name would collide. Generated names are already unique in the process.
 */
function ticketTaskNames(input: Record<string, unknown>, ticketId: string): Record<string, unknown> {
  if (!Array.isArray(input.tasks)) return input
  const prefix = `${ticketId.slice(0, 8)}-`
  return { ...input, tasks: input.tasks.map((item: unknown) => item && typeof item === 'object' && 'name' in item
    && typeof item.name === 'string' && !item.name.startsWith(prefix) ? { ...item, name: `${prefix}${item.name}` } : item) }
}
/** OMP's `modelRoles` selector for a role model: `provider/model`, with `:level` when a thinking level is set. */
const roleSelector = (model: RoleModel): string => `${model.provider}/${model.model}${model.thinkingLevel ? `:${model.thinkingLevel}` : ''}`
export interface ChatAttachment { name: string; mediaType: string; data: string }
type ChatContent = string | (TextContent | ImageContent)[]
interface AttachmentMetadata { name: string; mediaType: string; kind: 'image' | 'text' | 'file'; path?: string }
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/webp': 'image/webp', 'image/gif': 'image/gif' }
const IMAGE_EXTENSIONS: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|yaml|x-yaml|javascript|typescript|x-sh|x-python|csv|sql|x-httpd-php)(?:;|$)|image\/svg\+xml(?:;|$))/
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.log', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.htm', '.svg', '.py', '.sh', '.bash', '.zsh', '.sql', '.toml', '.ini', '.cfg', '.conf', '.env', '.rs', '.go', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.rb', '.lua', '.vue', '.svelte'])
const MAX_INLINE_TEXT_BYTES = 256 * 1024

function imageType(attachment: ChatAttachment): string | undefined {
  const declared = IMAGE_TYPES[attachment.mediaType]
  if (declared) return declared
  return !attachment.mediaType || attachment.mediaType === 'application/octet-stream' ? IMAGE_EXTENSIONS[extname(attachment.name).toLowerCase()] : undefined
}
function textContent(attachment: ChatAttachment, data: Buffer): string | undefined {
  if (data.length > MAX_INLINE_TEXT_BYTES) return undefined
  const extension = extname(attachment.name).toLowerCase()
  const likelyText = TEXT_TYPES.test(attachment.mediaType) || TEXT_EXTENSIONS.has(extension)
  if (!likelyText && data.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return undefined }
}
function attribute(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') }

/** Adapt an application Zod tool to OMP's JSON-Schema CustomTool contract. */
export function ompTool<S extends z.ZodType>(tool: Tool<S>): CustomTool {
  const parameters = z.toJSONSchema(tool.schema) as CustomTool['parameters']
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    loadMode: 'essential',
    execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
      const result = await tool.execute(tool.schema.parse(params), signal ?? new AbortController().signal)
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], details: result ?? null }
    },
  }
}
export interface OMPSessionsHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'delete'>
  readonly prompts: Pick<Prompts, 'current' | 'compose'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly engine: Pick<EngineForExecutor, 'inputsDelivered' | 'inputsRead'>
  readonly machine: Pick<Machine, 'stateDir' | 'agentDir'>
  readonly masterId: string
  readonly watchdogId?: string
  readonly lifetime: AbortSignal
  closing(): boolean
  environment(ticket: Ticket): Variable[]
  watchdogEnvironment?(): Variable[] | undefined
  tools(sessionId: string, ticket?: Ticket): Tool[]
}

/** Owns shared OMP authentication/models and one private AgentRegistry per Session. */
export class OMPSessions {
  readonly ready: Promise<void>
  private readonly loaded = new Map<string, AgentSession>()
  private readonly loading = new Map<string, Promise<AgentSession>>()
  private readonly delivery = new AgentDelivery()
  private authStorage!: AuthStorage
  private modelRegistry!: ModelRegistry
  private githubSkill!: Skill
  private subagent!: AgentDefinition

  constructor(private readonly host: OMPSessionsHost) {
    this.ready = this.initialize()
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }

  private async initialize(): Promise<void> {
    const { agentDir, stateDir } = this.host.machine
    await mkdir(join(stateDir, 'sessions'), { recursive: true, mode: 0o700 })
    const baseSettings = Settings.isolated(SESSION_SETTINGS)
    this.authStorage = await discoverAuthStorage(agentDir, { settings: baseSettings, cwd: stateDir })
    this.modelRegistry = new ModelRegistry(this.authStorage, join(agentDir, 'models.yml'), { settings: baseSettings })
    await this.modelRegistry.refresh()
    const settings = this.host.store.settings()
    for (const model of [settings.eval.model, settings.executor.model, settings.executor.advisor]) {
      if (model && !this.modelRegistry.find(model.provider, model.model)) throw new Error(`Unknown OMP model: ${model.provider}/${model.model}`)
    }
    const skills = await loadSkillsFromDir({ dir: packagePath('skills'), source: 'omp-superagent' })
    const github = skills.skills.filter(skill => skill.filePath === bundledSkills.github.path)
    if (github.length !== 1) throw new Error(`Expected one bundled GitHub skill at ${bundledSkills.github.path}; found ${github.length}`)
    this.githubSkill = github[0]!
    const task = getBundledAgent('task')
    if (!task) throw new Error('OMP bundled task agent is unavailable')
    const { model: _model, ...inherited } = task
    this.subagent = { ...inherited, name: SUBAGENT, tools: WORK_TOOLS, spawns: [SUBAGENT], source: 'bundled',
      description: 'Helper for one independent slice of this ticket, in its directory with read, bash, edit and write; it cannot report or message anyone, so its result comes back to you' }
  }

  get(sessionId: string): AgentSession | undefined { return this.loaded.get(sessionId) }

  async modelOptions(): Promise<{ id: string; provider: string; name: string }[]> {
    await this.ready
    await this.modelRegistry.refreshIfStale()
    return this.modelRegistry.getAvailable().map(model => ({ id: model.id, provider: model.provider, name: model.name }))
      .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
  }

  /**
   * Apply one validated role selector to loaded, non-disposed Sessions; a null model affects only future Sessions, while a
   * null advisor turns the workers' advisor off.
   */
  async applyModel(role: 'orchestrator' | 'worker' | 'advisor', selection: RoleModel | null): Promise<void> {
    await this.checkModel(selection)
    for (const [sessionId, session] of this.loaded) {
      if (session.isDisposed) continue
      const isMain = sessionId === this.host.masterId
      const isWatchdog = this.host.watchdogId !== undefined && sessionId === this.host.watchdogId
      if (role === 'orchestrator' && !isMain && !(isWatchdog && selection)) continue
      if ((role === 'worker' || role === 'advisor') && (isMain || isWatchdog)) continue
      if (role === 'advisor') {
        if (selection) session.settings.overrideModelRoles({ advisor: roleSelector(selection) })
        session.setAdvisorEnabled(!!selection)
        continue
      }
      if (!selection) continue
      const thinkingLevel = selection.thinkingLevel as never
      await session.setModel(this.modelRegistry.find(selection.provider, selection.model)!, 'default', { ...(thinkingLevel === 'auto' ? {} : { thinkingLevel }), persist: false })
      session.setThinkingLevel(thinkingLevel, false)
    }
  }

  /** @throws for a selector naming a model OMP does not know. */
  async checkModel(selection: RoleModel | null): Promise<void> {
    await this.ready
    if (selection && !this.modelRegistry.find(selection.provider, selection.model)) throw new Error(`Unknown OMP model: ${selection.provider}/${selection.model}`)
  }

  async ensure(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker' | 'watchdog', ticket?: Ticket): Promise<AgentSession> {
    await this.ready
    const current = this.loaded.get(sessionId)
    if (current) return current
    const existing = this.loading.get(sessionId)
    if (existing) return existing
    const opening = this.open(sessionId, cwd, title, role, ticket).finally(() => {
      this.loading.delete(sessionId)
    })
    this.loading.set(sessionId, opening)
    return opening
  }

  private async open(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker' | 'watchdog', ticket?: Ticket): Promise<AgentSession> {
    if (this.host.closing()) throw new Error('omp-superagent is stopping')
    if (role === 'worker' && (!ticket || !liveTicket(ticket))) throw new Error('Worker Session needs a live Ticket')
    const sessionDir = join(this.host.machine.stateDir, 'sessions')
    const file = this.host.store.get(KV.sessions.files(sessionId))
    let sessionManager: SessionManager
    if (file) {
      try { sessionManager = await SessionManager.open(file, sessionDir, undefined, { initialCwd: cwd, throwIfMissing: true }) }
      catch (error) { throw new Error(`Cannot reopen OMP Session ${sessionId} at ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
    } else sessionManager = SessionManager.create(cwd, sessionDir)

    const settings = this.host.store.settings()
    const configured = role === 'orchestrator' ? settings.eval.model
      : role === 'watchdog' ? (settings.eval.model ?? settings.executor.model) : settings.executor.model
    const model = configured ? this.modelRegistry.find(configured.provider, configured.model) : undefined
    if (configured && !model) throw new Error(`Unknown OMP model: ${configured.provider}/${configured.model}`)
    // RoleModelSchema admits exactly OMP's selector strings; its packages declare them through incompatible enum aliases.
    const thinkingLevel = configured?.thinkingLevel as never
    const version = this.host.prompts.current()
    // Keep every role's system prompt byte-identical across tickets so all workers share one provider prefix cache;
    // per-ticket directory, worktree name and mandate arrive in the initial assignment message instead.
    const customSystemPrompt = role === 'watchdog'
      ? `${watchdogPrompt}\n\n${environmentSection(version.config, this.host.watchdogEnvironment?.())}`
      : this.host.prompts.compose(version.config, role, this.host.watchdogEnvironment?.())
    const tools = this.host.tools(sessionId, ticket)
    const toolNames = [...role === 'worker' ? [...WORK_TOOLS, 'task', 'wait'] : ['read', 'bash'], ...tools.map(tool => tool.name)]
    // Subagents inherit these prepared extensions, so the guard covers their tool calls too.
    const extensions: CreateAgentSessionOptions['extensions'] = role === 'worker' && ticket ? [pi => {
      pi.on('tool_call', async event => {
        const current = this.host.store.tickets.get(ticket.id)
        if (!current || !liveTicket(current)) return { block: true, reason: 'Ticket ended; new work needs a new authorized ticket' }
        // Finished subagents stay in a process-wide lifecycle that another worker's disposal releases; spawn anew instead.
        if (event.toolName === 'write' && typeof event.input.path === 'string' && event.input.path.startsWith('agent://')) {
          return { block: true, reason: 'A finished subagent is not continued; spawn a new one with task' }
        }
        if (event.toolName !== 'task') return undefined
        if ((await discoverAgents(cwd)).agents.some(agent => agent.name === SUBAGENT)) {
          return { block: true, reason: `A repository or user agent definition named ${SUBAGENT} would replace the ticket subagent; subagents are unavailable for this ticket` }
        }
        return { input: ticketTaskNames(event.input, ticket.id) }
      })
    }] : []
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.host.machine.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      agentRegistry: new AgentRegistry(),
      // A worker advisor is a second model that reviews each worker turn and injects notes; subagents never get one.
      settings: Settings.isolated(role === 'worker' ? { ...WORKER_SETTINGS, 'advisor.enabled': !!settings.executor.advisor,
        ...settings.executor.advisor ? { modelRoles: { advisor: roleSelector(settings.executor.advisor) } } : {} } : ORCHESTRATOR_SETTINGS),
      sessionManager,
      customSystemPrompt,
      noContextFiles: role !== 'worker',
      promptTemplates: [],
      slashCommands: [],
      rules: [],
      skills: role === 'worker' ? [this.githubSkill] : [],
      customTools: tools.map(ompTool),
      toolNames,
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      extensions,
      ...role === 'worker' ? { spawns: SUBAGENT, inheritedSessionAgents: [this.subagent] } : {},
      preloadedPreparedExtensions: extensions.map((factory, index) => ({ path: `<omp-superagent-worker-${index}>`, resolvedPath: `<omp-superagent-worker-${index}>`, factory, error: null })),
      bindProcessState: false,
      hasUI: false,
      cacheWarming: role === 'worker',
      enableMCP: false,
      enableLsp: false,
      disableExtensionDiscovery: true,
      ...model ? { model, thinkingLevel } : {},
    })
    if (!file) {
      await session.sessionManager.ensureOnDisk()
      const sessionFile = session.sessionFile
      if (!sessionFile) throw new Error(`OMP did not create a session file for ${sessionId}`)
      this.host.store.set(KV.sessions.files(sessionId), sessionFile)
    }
    await session.setSessionName(title, 'user')
    if (file && configured && model) {
      await session.setModel(model, 'default', { ...(thinkingLevel === 'auto' ? {} : { thinkingLevel }), persist: false })
      session.setThinkingLevel(thinkingLevel, false)
    }
    this.loaded.set(sessionId, session)
    return session
  }

  private bind(session: AgentSession, ticketId?: string): void {
    this.delivery.bind(session, inputIds => {
      if (!ticketId) return
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (assignment) this.host.engine.inputsDelivered(ticketId, assignment.id, inputIds)
      this.host.engine.inputsRead(ticketId, inputIds)
    })
  }

  /** `inputs` names the Inputs the message carries when it is not the one Input whose id is `requestId`. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string },
    authorize?: () => void, accepted?: () => void, inputs?: string[]): Promise<void> {
    const session = this.loaded.get(sessionId)
    if (!session) throw new Error(`OMP Session is not loaded: ${sessionId}`)
    const ticketId = sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
    const ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    const inputIds = inputs ?? (ticket?.inputs.some(input => input.id === requestId) ? [requestId] : undefined)
    this.bind(session, ticketId)
    await this.delivery.send(session, requestId, text, mode, this.host.lifetime, inputIds, authorize, accepted)
  }
  /** Persist a visible chat message without starting a turn; ChatSource turns its rendered text into a Trigger. */
  async presentChat(sessionId: string, text: string, attachments: ChatAttachment[],
    options: { requestId: string; source: 'web-panel' | 'wechat' }): Promise<{ requestId: string; text: string }> {
    const session = this.loaded.get(sessionId)
    if (!session) throw new Error(`OMP Session is not loaded: ${sessionId}`)
    const { requestId } = options
    const images: ImageContent[] = []
    const rendered: string[] = []
    const metadata: AttachmentMetadata[] = []
    let directory: string | undefined
    for (const [index, attachment] of attachments.entries()) {
      const data = Buffer.from(attachment.data, 'base64')
      const mediaType = imageType(attachment)
      if (mediaType) images.push({ type: 'image', data: attachment.data, mimeType: mediaType })
      const decoded = mediaType ? undefined : textContent(attachment, data)
      if (decoded !== undefined) {
        rendered.push(`<attachment name="${attribute(attachment.name)}">\n${decoded}\n</attachment>`)
        metadata.push({ name: attachment.name, mediaType: attachment.mediaType || 'text/plain', kind: 'text' })
        continue
      }
      directory ??= join(this.host.machine.stateDir, 'attachments', requestId.replaceAll(':', '-'))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${index + 1}-${attachment.name}`)
      await writeFile(path, data, { mode: 0o600 })
      const storedType = mediaType || attachment.mediaType || 'application/octet-stream'
      rendered.push(`<attachment name="${attribute(attachment.name)}" mediaType="${attribute(storedType)}" path="${attribute(path)}">\nFile saved at the path above. Use read or bash to inspect or transform it as needed; do not execute it implicitly.\n</attachment>`)
      metadata.push({ name: attachment.name, mediaType: storedType, kind: mediaType ? 'image' : 'file', path })
    }
    const body = [text, ...rendered].filter(Boolean).join('\n\n') || '请查看附件。'
    const content: ChatContent = [{ type: 'text', text: body }, ...images]
    await this.delivery.append(session, requestId, content,
      { display: true, attribution: 'user', source: options.source, attachments: metadata })
    return { requestId, text: body }
  }

  /** Publish a durable Outbox reply to the Web transcript without triggering another model turn. */
  async publish(sessionId: string, requestId: string, text: string): Promise<void> {
    const session = this.loaded.get(sessionId)
    if (!session) throw new Error(`OMP Session is not loaded: ${sessionId}`)
    await this.delivery.append(session, requestId, text, { display: true, attribution: 'agent', source: 'chat-reply' })
  }


  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const session = this.loaded.get(sessionId)
    return session ? this.delivery.holds(session, requestId) : false
  }

  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }

  private async inject(name: string, value: Record<string, unknown>, _summary: string): Promise<void> {
    const session = this.loaded.get(this.host.masterId)
    if (!session) return
    const text = JSON.stringify(value)
    this.bind(session)
    await this.delivery.send(session, `notice:${name}:${key(text)}`, text, { inject: name }, this.host.lifetime, undefined)
  }

  async transcript(ticketId: string): Promise<unknown[]> {
    const alias = workerSessionId(ticketId)
    const loaded = this.loaded.get(alias)
    if (loaded) return loaded.messages
    const file = this.host.store.get(KV.sessions.files(alias))
    if (!file) return []
    const manager = await SessionManager.open(file, join(this.host.machine.stateDir, 'sessions'), undefined,
      { initialCwd: this.host.machine.stateDir, throwIfMissing: true })
    return manager.getBranch().flatMap<unknown>(entry => entry.type === 'message' ? [entry.message]
      : entry.type === 'custom_message' ? [{ ...entry, timestamp: Date.parse(entry.timestamp), role: 'custom' }] : [])
  }

  /** Replace only the main Session with an empty persistent transcript; channel bindings and domain state survive. */
  async resetOrchestrator(): Promise<void> {
    await this.stop(this.host.masterId, 'Orchestrator Session reset')
    this.host.store.delete(KV.sessions.files(this.host.masterId))
    await this.ensure(this.host.masterId, this.host.machine.stateDir, 'omp-superagent orchestrator', 'orchestrator')
  }

  /** Reopen the main Session from its transcript, so its system prompt is composed from the current execution environment. */
  async reopenOrchestrator(): Promise<void> {
    await this.stop(this.host.masterId, 'Orchestrator Session reopened')
    await this.ensure(this.host.masterId, this.host.machine.stateDir, 'omp-superagent orchestrator', 'orchestrator')
  }
  /** Run one stateless, in-memory read-only Sidecar turn sharing a single static prefix cache key across all queries. */
  async runSidecar(cwd: string, promptText: string, tools: Tool[], timeoutMs = 90_000): Promise<string> {
    await this.ready
    if (this.host.closing()) throw new Error('omp-superagent is stopping')
    const settings = this.host.store.settings()
    const configured = settings.eval.model ?? settings.executor.model
    const model = configured ? this.modelRegistry.find(configured.provider, configured.model) : undefined
    if (configured && !model) throw new Error(`Unknown OMP model: ${configured.provider}/${configured.model}`)
    const thinkingLevel = configured?.thinkingLevel as never
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.host.machine.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      agentRegistry: new AgentRegistry(),
      settings: Settings.isolated(ORCHESTRATOR_SETTINGS),
      sessionManager: SessionManager.inMemory(cwd),
      customSystemPrompt: sidecarPrompt,
      noContextFiles: true,
      promptTemplates: [],
      slashCommands: [],
      rules: [],
      skills: [],
      customTools: tools.map(ompTool),
      toolNames: ['read', ...tools.map(item => item.name)],
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      extensions: [],
      bindProcessState: false,
      hasUI: false,
      cacheWarming: false,
      enableMCP: false,
      enableLsp: false,
      disableExtensionDiscovery: true,
      ...model ? { model, thinkingLevel } : {},
    })
    session.agent.promptCacheKey = `sidecar-${key(this.host.machine.stateDir)}`
    const { promise: ended, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => { reject(new Error(`Sidecar query timed out after ${timeoutMs}ms`)) }, timeoutMs)
    const onAbort = () => { reject(new Error('omp-superagent stopped during sidecar query')) }
    this.host.lifetime.addEventListener('abort', onAbort, { once: true })
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_end' && event.isTerminal !== false) resolve()
    })
    try {
      await session.sendCustomMessage({ customType: 'omp-superagent-sidecar', content: promptText, display: false, attribution: 'agent' },
        { triggerTurn: true, deliverAs: 'steer' })
      await ended
      return session.getLastAssistantText()?.trim() ?? ''
    } finally {
      clearTimeout(timer)
      this.host.lifetime.removeEventListener('abort', onAbort)
      unsubscribe()
      session.beginDispose()
      await session.dispose()
    }
  }


  async stop(sessionId: string, reason: string): Promise<void> {
    const session = this.loaded.get(sessionId)
    if (!session) return
    this.loaded.delete(sessionId)
    await this.delivery.stop(session, reason)
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.loaded.values()]
    for (const session of sessions) this.delivery.beginDispose(session, 'omp-superagent stopped')
    await Promise.allSettled(sessions.map(session => this.delivery.stop(session, 'omp-superagent stopped')))
    this.loaded.clear()
  }

  dispose(): void {
    for (const session of this.loaded.values()) this.delivery.beginDispose(session, 'omp-superagent disposed')
    this.loaded.clear()
  }
}
