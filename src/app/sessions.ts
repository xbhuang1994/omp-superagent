/** Persistent OMP orchestrator and worker Sessions, with isolated tools and durable delivery. */
import { AgentRegistry, ModelRegistry, SessionManager, Settings, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  type AgentSession, type AuthStorage, type CreateAgentSessionOptions, type CustomTool, type Skill } from '@oh-my-pi/pi-coding-agent'
import type { ImageContent, TextContent } from '@oh-my-pi/pi-ai'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
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
import type { RoleModel } from '../policy.ts'

const SESSION_SETTINGS = {
  'async.enabled': false,
  'bash.autoBackground.enabled': false,
  'launch.enabled': false,
  'retry.enabled': true,
  'compaction.enabled': true,
} as const
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

  async modelOptions(): Promise<{ id: string; provider: string; name: string }[]> {
    await this.ready
    await this.modelRegistry.refreshIfStale()
    return this.modelRegistry.getAvailable().map(model => ({ id: model.id, provider: model.provider, name: model.name }))
      .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
  }

  /** Apply one validated role selector to loaded, non-disposed Sessions; null affects only future Sessions. */
  async applyModel(role: 'orchestrator' | 'worker', selection: RoleModel | null): Promise<void> {
    await this.ready
    if (!selection) return
    const model = this.modelRegistry.find(selection.provider, selection.model)
    if (!model) throw new Error(`Unknown OMP model: ${selection.provider}/${selection.model}`)
    const thinkingLevel = selection.thinkingLevel as never
    for (const [sessionId, session] of this.loaded) {
      if (session.isDisposed || (role === 'orchestrator') !== (sessionId === this.host.masterId)) continue
      await session.setModel(model, 'default', { ...(thinkingLevel === 'auto' ? {} : { thinkingLevel }), persist: false })
      session.setThinkingLevel(thinkingLevel, false)
    }
  }

  async ensure(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Ticket): Promise<AgentSession> {
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
    const toolNames = [...role === 'worker' ? ['read', 'bash', 'edit', 'write'] : ['read', 'bash'], ...tools.map(tool => tool.name)]
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
      if (mediaType) {
        images.push({ type: 'image', data: attachment.data, mimeType: mediaType })
        metadata.push({ name: attachment.name, mediaType, kind: 'image' })
        continue
      }
      const decoded = textContent(attachment, data)
      if (decoded !== undefined) {
        rendered.push(`<attachment name="${attribute(attachment.name)}">\n${decoded}\n</attachment>`)
        metadata.push({ name: attachment.name, mediaType: attachment.mediaType || 'text/plain', kind: 'text' })
        continue
      }
      directory ??= join(this.host.machine.stateDir, 'attachments', requestId.replaceAll(':', '-'))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${index + 1}-${attachment.name}`)
      await writeFile(path, data, { mode: 0o600 })
      const storedType = attachment.mediaType || 'application/octet-stream'
      rendered.push(`<attachment name="${attribute(attachment.name)}" mediaType="${attribute(storedType)}" path="${attribute(path)}">\nFile saved at the path above. Use read or bash to inspect or transform it as needed; do not execute it implicitly.\n</attachment>`)
      metadata.push({ name: attachment.name, mediaType: storedType, kind: 'file', path })
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
