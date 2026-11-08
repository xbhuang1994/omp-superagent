/** Persistent OMP orchestrator and worker Sessions, with isolated tools and durable delivery. */
import { AgentRegistry, ModelRegistry, SessionManager, Settings, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  type AgentSession, type AuthStorage, type CreateAgentSessionOptions, type CustomTool, type Skill } from '@oh-my-pi/pi-coding-agent'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import z from 'zod'
import { key, liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '../core/index.ts'
import { mandateInstructions, workerSessionId } from '../executor/omp.ts'
import { packagePath } from '../infra/paths.ts'
import { KV } from '../kv.ts'
import type { Machine } from '../deployment.ts'
import { AgentDelivery } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import type { Prompts } from './prompts.ts'
import { bundledSkills } from './skill-files.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'

const SESSION_SETTINGS = {
  'async.enabled': false,
  'bash.autoBackground.enabled': false,
  'launch.enabled': false,
  'retry.enabled': true,
  'compaction.enabled': true,
} as const

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
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set'>
  readonly prompts: Pick<Prompts, 'current' | 'compose'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly engine: Pick<EngineForExecutor, 'inputsDelivered' | 'inputsRead'>
  readonly machine: Pick<Machine, 'stateDir' | 'agentDir'>
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  environment(ticket: Ticket): Variable[]
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
    for (const model of [settings.eval.model, settings.executor.model]) {
      if (model && !this.modelRegistry.find(model.provider, model.model)) throw new Error(`Unknown OMP model: ${model.provider}/${model.model}`)
    }
    const skills = await loadSkillsFromDir({ dir: packagePath('skills'), source: 'omp-superagent' })
    const github = skills.skills.filter(skill => skill.filePath === bundledSkills.github.path)
    if (github.length !== 1) throw new Error(`Expected one bundled GitHub skill at ${bundledSkills.github.path}; found ${github.length}`)
    this.githubSkill = github[0]!
  }

  get(sessionId: string): AgentSession | undefined { return this.loaded.get(sessionId) }

  async ensure(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Ticket): Promise<AgentSession> {
    await this.ready
    const current = this.loaded.get(sessionId)
    if (current) return current
    const existing = this.loading.get(sessionId)
    if (existing) return existing
    const opening = this.open(sessionId, cwd, title, role, ticket).catch(error => {
      this.loading.delete(sessionId)
      throw error
    })
    this.loading.set(sessionId, opening)
    return opening
  }

  private async open(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Ticket): Promise<AgentSession> {
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
    const configured = role === 'orchestrator' ? settings.eval.model : settings.executor.model
    const model = configured ? this.modelRegistry.find(configured.provider, configured.model) : undefined
    if (configured && !model) throw new Error(`Unknown OMP model: ${configured.provider}/${configured.model}`)
    // RoleModelSchema admits exactly OMP's selector strings; its packages declare them through incompatible enum aliases.
    const thinkingLevel = configured?.thinkingLevel as never
    const version = this.host.prompts.current()
    const composed = this.host.prompts.compose(version.config, role, ticket ? this.host.environment(ticket) : undefined)
    const mandate = ticket ? mandateInstructions(ticket.mandate) : ''
    const customSystemPrompt = mandate ? `${composed}\n\n${mandate}` : composed
    const tools = this.host.tools(sessionId, ticket)
    const toolNames = [...role === 'worker' ? ['read', 'bash', 'edit', 'write'] : [], ...tools.map(tool => tool.name)]
    const extensions: CreateAgentSessionOptions['extensions'] = role === 'worker' && ticket ? [pi => {
      pi.on('tool_call', () => {
        const current = this.host.store.tickets.get(ticket.id)
        return !current || !liveTicket(current) ? { block: true, reason: 'Ticket ended; new work needs a new authorized ticket' } : undefined
      })
    }] : []
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.host.machine.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      agentRegistry: new AgentRegistry(),
      settings: Settings.isolated(SESSION_SETTINGS),
      sessionManager,
      customSystemPrompt,
      noContextFiles: role === 'orchestrator',
      promptTemplates: [],
      slashCommands: [],
      rules: [],
      skills: role === 'worker' ? [this.githubSkill] : [],
      customTools: tools.map(ompTool),
      toolNames,
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      extensions,
      preloadedPreparedExtensions: extensions.map((factory, index) => ({ path: `<omp-superagent-worker-${index}>`, resolvedPath: `<omp-superagent-worker-${index}>`, factory, error: null })),
      bindProcessState: false,
      hasUI: false,
      cacheWarming: false,
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
      await session.setModel(model, 'default', { thinkingLevel, persist: false })
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

  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string },
    authorize?: () => void, accepted?: () => void): Promise<void> {
    const session = this.loaded.get(sessionId)
    if (!session) throw new Error(`OMP Session is not loaded: ${sessionId}`)
    const ticketId = sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
    const ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    const inputIds = ticket?.inputs.some(input => input.id === requestId) ? [requestId] : undefined
    this.bind(session, ticketId)
    await this.delivery.send(session, requestId, text, mode, this.host.lifetime, inputIds, authorize, accepted)
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
    const loaded = this.loaded.get(workerSessionId(ticketId))
    if (loaded) return loaded.messages
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !this.host.store.get(KV.sessions.files(workerSessionId(ticketId)))) return []
    const session = await this.ensure(workerSessionId(ticketId), ticket.execution?.directory ?? '', ticket.title, 'worker', ticket)
    return session.messages
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
