/** Persistent OMP orchestrator and worker Sessions, with isolated tools and durable delivery. */
import { AgentRegistry, ModelRegistry, SessionManager, Settings, createAgentSession, discoverAuthStorage, loadSkillsFromDir,
  type AgentDefinition, type AgentSession, type AuthStorage, type CreateAgentSessionOptions, type CustomTool, type Skill } from '@oh-my-pi/pi-coding-agent'
import { getBundledAgent } from '@oh-my-pi/pi-coding-agent/task/agents'
import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery'
import type { ImageContent, TextContent } from '@oh-my-pi/pi-ai'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import { ClaudeSession, effortOf, listClaudeModels, rewriteToolNames, runClaudeOnce, type ClaudeOptions, type Effort } from '../kernel/claude.ts'
import { isClaudeJournal, Journal } from '../kernel/journal.ts'
import type { KernelKind, KernelSession } from '../kernel/types.ts'
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
const WORK_TOOLS_CLAUDE = ['Read', 'Bash', 'Edit', 'Write', 'Agent', 'TaskStop']
const MAX_SUBAGENTS = 8
/** Whether the repository defines a Claude Code agent that would replace the ticket subagent. */
function overridesSubagent(cwd: string): boolean {
  const dir = join(cwd, '.claude', 'agents')
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).some(name => name.endsWith('.md')
      && new RegExp(`^name:\\s*["']?${SUBAGENT}["']?\\s*$`, 'm').test(readFileSync(join(dir, name), 'utf8').slice(0, 2000)))
  } catch { return false }
}
const SUBAGENT_PROMPT = 'You are a helper for one independent slice of a larger ticket, working in the ticket directory. Do exactly the slice you were given with your tools, '
  + 'verify it, and finish with a concise report of what you changed or found. You cannot report to or message anyone; your final answer goes back to the worker that spawned you.'
const CLAUDE_MAIN_NOTE = 'Runtime note: you run in Claude Code. Tool names above map to `Read` and `Bash`; application tools are exposed as `mcp__omp__<name>`.'
const CLAUDE_WORKER_NOTE = 'Runtime note: you run in Claude Code. Tool names above map to `Read`, `Bash`, `Edit` and `Write`; application tools are exposed as `mcp__omp__<name>`. '
  + 'Spawn subagents (the `task` tool above) with `Agent` and `subagent_type: "ticket-task"`, setting `run_in_background: true` for long work; at most 8 run at once. '
  + 'There is no `timeout: 0`: run any command that may take longer than a minute with `Bash` and `run_in_background: true`, and stop one you no longer need with `TaskStop`. '
  + 'A finished background command or subagent wakes you in this Session with its result; there is no `wait` tool, so end your turn to wait for it.'
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
  readonly machine: Pick<Machine, 'stateDir' | 'agentDir'> & { kernel?: KernelKind }
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  environment(ticket: Ticket): Variable[]
  watchdogEnvironment?(): Variable[] | undefined
  tools(sessionId: string, ticket?: Ticket): Tool[]
}

/** Owns shared OMP authentication/models and one private AgentRegistry per Session. */
export class OMPSessions {
  private readonly prepared = new Map<KernelKind, Promise<void>>()
  private current: KernelKind
  private switching: Promise<void> = Promise.resolve()
  private readonly loaded = new Map<string, KernelSession>()
  private readonly loading = new Map<string, Promise<KernelSession>>()
  private readonly delivery = new AgentDelivery()
  private authStorage!: AuthStorage
  private modelRegistry!: ModelRegistry
  private githubSkill!: Skill
  private subagent!: AgentDefinition
  private githubSkillText = ''

  constructor(private readonly host: OMPSessionsHost) {
    this.current = host.machine.kernel ?? 'omp'
    void this.ready.catch(() => {})
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }

  /** The kernel new Sessions open on; a loaded Session stays on the kernel it was opened with. */
  get kernel(): KernelKind { return this.current }
  /** Settles once the current kernel is initialized. */
  get ready(): Promise<void> { return this.prepare(this.current) }
  private prepare(kind: KernelKind): Promise<void> {
    let ready = this.prepared.get(kind)
    if (!ready) {
      ready = this.initialize(kind)
      this.prepared.set(kind, ready)
      // A failed start is retried on the next use, such as a later switch after the configuration is fixed.
      ready.catch(() => { if (this.prepared.get(kind) === ready) this.prepared.delete(kind) })
    }
    return ready
  }

  /**
   * Switch the kernel for Sessions opened from now on, and reopen the main Session on it with its chat history. A loaded
   * worker finishes on its kernel; its next load uses the new one and is given its assignment anew.
   * @throws when the kernel cannot start, such as a configured model OMP does not know; the kernel is then unchanged.
   */
  async setKernel(kind: KernelKind): Promise<void> {
    const run = this.switching = this.switching.catch(() => {}).then(async () => {
      if (kind === this.current) return
      await this.prepare(kind)
      if (kind === 'omp') await this.checkOmpModels()
      const previous = this.current
      this.current = kind
      try { await this.reopenOrchestrator() }
      catch (error) {
        // The main Session could not open on the new kernel: stay on the old one.
        this.current = previous
        await this.reopenOrchestrator()
        throw error
      }
      this.host.store.set(KV.runtime.kernel, kind)
    })
    await run
  }
  private async checkOmpModels(): Promise<void> {
    await this.modelRegistry.refreshIfStale()
    const settings = this.host.store.settings()
    for (const model of [settings.eval.model, settings.executor.model, settings.executor.advisor]) {
      if (model && !this.modelRegistry.find(model.provider, model.model)) throw new Error(`Unknown OMP model: ${model.provider}/${model.model}`)
    }
  }

  private async initialize(kind: KernelKind): Promise<void> {
    const { agentDir, stateDir } = this.host.machine
    await mkdir(join(stateDir, 'sessions'), { recursive: true, mode: 0o700 })
    if (kind === 'claude') {
      const body = (await readFile(bundledSkills.github.path, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '').trim()
      this.githubSkillText = `# Skill: omp-superagent-github\n\n${body}`
      return
    }
    const baseSettings = Settings.isolated(SESSION_SETTINGS)
    this.authStorage = await discoverAuthStorage(agentDir, { settings: baseSettings, cwd: stateDir })
    this.modelRegistry = new ModelRegistry(this.authStorage, join(agentDir, 'models.yml'), { settings: baseSettings })
    await this.modelRegistry.refresh()
    await this.checkOmpModels()
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

  get(sessionId: string): KernelSession | undefined { return this.loaded.get(sessionId) }

  async modelOptions(): Promise<{ id: string; provider: string; name: string }[]> {
    await this.ready
    if (this.kernel === 'claude') {
      // The backend's own list, never a built-in one; the choices in use stay selectable when it does not name them or cannot be reached.
      const settings = this.host.store.settings()
      const used = [settings.eval.model, settings.executor.model].flatMap(model => model ? [{ id: model.model, provider: model.provider, name: model.model }] : [])
      const known = await listClaudeModels().catch(() => [])
      return [...used.filter((model, index) => used.findIndex(other => other.id === model.id) === index && !known.some(other => other.id === model.id)), ...known]
    }
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
    for (const [sessionId, loaded] of this.loaded) {
      if (loaded.isDisposed) continue
      const isMain = sessionId === this.host.masterId
      if (role === 'orchestrator' && !isMain) continue
      if ((role === 'worker' || role === 'advisor') && isMain) continue
      if (loaded instanceof ClaudeSession) {
        // Claude Code has no advisor model; model and effort apply to later turns.
        if (role !== 'advisor' && selection) await loaded.setModel(selection.model, effortOf(selection.thinkingLevel))
        continue
      }
      const session = loaded as unknown as AgentSession
      if (role === 'advisor') {
        if (selection) session.settings.overrideModelRoles({ advisor: roleSelector(selection) })
        session.setAdvisorEnabled(!!selection)
        continue
      }
      if (!selection) continue
      // A worker still loaded on OMP after a switch to Claude Code keeps its model when OMP does not know the new one.
      const known = this.modelRegistry.find(selection.provider, selection.model)
      if (!known) continue
      const thinkingLevel = selection.thinkingLevel as never
      await session.setModel(known, 'default', { ...(thinkingLevel === 'auto' ? {} : { thinkingLevel }), persist: false })
      session.setThinkingLevel(thinkingLevel, false)
    }
  }

  /** @throws for a selector naming a model OMP does not know. */
  async checkModel(selection: RoleModel | null): Promise<void> {
    await this.ready
    if (this.kernel === 'claude') return
    if (selection && !this.modelRegistry.find(selection.provider, selection.model)) throw new Error(`Unknown OMP model: ${selection.provider}/${selection.model}`)
  }

  async ensure(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Ticket): Promise<KernelSession> {
    await this.ready
    const current = this.loaded.get(sessionId)
    if (current) return current
    const existing = this.loading.get(sessionId)
    if (existing) return existing
    const opening = (this.kernel === 'claude' ? this.openClaude(sessionId, cwd, title, role, ticket) : this.open(sessionId, cwd, title, role, ticket)).finally(() => {
      this.loading.delete(sessionId)
    })
    this.loading.set(sessionId, opening)
    return opening
  }

  private async open(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Ticket): Promise<KernelSession> {
    if (this.host.closing()) throw new Error('omp-superagent is stopping')
    if (role === 'worker' && (!ticket || !liveTicket(ticket))) throw new Error('Worker Session needs a live Ticket')
    const sessionDir = join(this.host.machine.stateDir, 'sessions')
    const stored = this.host.store.get(KV.sessions.files(sessionId))
    // A Session last run on the Claude Code kernel starts a new OMP transcript.
    const file = stored && await isClaudeJournal(stored) ? undefined : stored
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
    // Keep every role's system prompt byte-identical across tickets so all workers share one provider prefix cache;
    // per-ticket directory, worktree name and mandate arrive in the initial assignment message instead.
    const customSystemPrompt = this.host.prompts.compose(version.config, role, this.host.watchdogEnvironment?.())
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
      // The main Session keeps its chat history when it comes back from the Claude Code kernel.
      const chat = stored && role === 'orchestrator' ? (await Journal.open(stored, cwd).catch(() => undefined))?.chat() ?? [] : []
      for (const entry of chat) {
        session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content as never, entry.display, entry.details, entry.attribution as never)
      }
      if (chat.length) await session.flushToDisk()
    }
    await session.setSessionName(title, 'user')
    if (file && configured && model) {
      await session.setModel(model, 'default', { ...(thinkingLevel === 'auto' ? {} : { thinkingLevel }), persist: false })
      session.setThinkingLevel(thinkingLevel, false)
    }
    const kernel = session as unknown as KernelSession
    this.loaded.set(sessionId, kernel)
    return kernel
  }

  /** Claude Code kernel: one persistent Agent SDK query per Session, resumed from its journal. */
  private async openClaude(sessionId: string, cwd: string, title: string, role: 'orchestrator' | 'worker', ticket?: Ticket): Promise<KernelSession> {
    if (this.host.closing()) throw new Error('omp-superagent is stopping')
    if (role === 'worker' && (!ticket || !liveTicket(ticket))) throw new Error('Worker Session needs a live Ticket')
    const stored = this.host.store.get(KV.sessions.files(sessionId))
    // A Session last run on OMP starts a new journal: the worker is given its assignment anew, and the main Session keeps its chat history.
    const file = stored && !await isClaudeJournal(stored) ? undefined : stored
    let journal: Journal
    if (file) {
      try { journal = await Journal.open(file, cwd) }
      catch (error) { throw new Error(`Cannot reopen Claude Code Session ${sessionId} at ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
    } else {
      journal = await Journal.create(join(this.host.machine.stateDir, 'sessions'), cwd)
      if (stored && role === 'orchestrator') await journal.importChat(stored)
    }
    const settings = this.host.store.settings()
    const configured = role === 'orchestrator' ? settings.eval.model : settings.executor.model
    const tools = this.host.tools(sessionId, ticket)
    let session: ClaudeSession | undefined
    const options = this.claudeOptions(cwd, tools, this.claudePrompt(role, tools), configured, role === 'worker' ? WORK_TOOLS_CLAUDE : ['Read', 'Bash'])
    // Mirror OMP's compaction thresholds and its 60 s move of a long command to the background.
    options.env = role === 'worker' ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', BASH_DEFAULT_TIMEOUT_MS: '60000' } : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '60000' }
    if (role === 'worker' && ticket) {
      options.projectSettings = true
      options.agents = { [SUBAGENT]: { description: 'Helper for one independent slice of this ticket, in its directory with read, bash, edit and write; it cannot report or message anyone, so its result comes back to you',
        prompt: SUBAGENT_PROMPT, tools: ['Read', 'Bash', 'Edit', 'Write'] } }
      // Hooks also fire for subagent tool calls, so the guard covers them.
      options.guard = (toolName, input) => {
        const current = this.host.store.tickets.get(ticket.id)
        if (!current || !liveTicket(current)) return { block: 'Ticket ended; new work needs a new authorized ticket' }
        if (toolName !== 'Agent') return undefined
        if (overridesSubagent(cwd)) return { block: `A repository agent definition named ${SUBAGENT} would replace the ticket subagent; subagents are unavailable for this ticket` }
        if ((session?.asyncJobManager.getRunningJobs().filter(job => job.type === 'task').length ?? 0) >= MAX_SUBAGENTS) {
          return { block: `At most ${MAX_SUBAGENTS} subagents run at once; wait for one to finish` }
        }
        return input.subagent_type === SUBAGENT ? undefined : { input: { ...input, subagent_type: SUBAGENT } }
      }
    }
    session = new ClaudeSession(journal, options)
    if (!file) this.host.store.set(KV.sessions.files(sessionId), journal.file)
    journal.setName(title)
    await journal.flush()
    this.loaded.set(sessionId, session)
    return session
  }

  private claudeOptions(cwd: string, tools: Tool[], systemPrompt: string, configured: RoleModel | null | undefined, builtinTools: string[]): ClaudeOptions {
    return { cwd, tools, builtinTools, systemPrompt: rewriteToolNames(systemPrompt, tools.map(item => item.name)),
      model: configured?.model, effort: effortOf(configured?.thinkingLevel) }
  }
  private claudePrompt(role: 'orchestrator' | 'worker', tools: Tool[]): string {
    const version = this.host.prompts.current()
    const prompt = this.host.prompts.compose(version.config, role, this.host.watchdogEnvironment?.())
    // Static per role, so every ticket's worker shares one provider prefix cache.
    return [prompt, role === 'worker' ? CLAUDE_WORKER_NOTE : CLAUDE_MAIN_NOTE, ...role === 'worker' ? [this.githubSkillText] : []].join('\n\n')
  }

  private bind(session: KernelSession, ticketId?: string): void {
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
    if (await isClaudeJournal(file)) return (await Journal.open(file, this.host.machine.stateDir)).messages()
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
    if (this.kernel === 'claude') {
      const options = this.claudeOptions(cwd, tools, sidecarPrompt, configured, ['Read'])
      options.maxTurns = 20
      return runClaudeOnce(options, promptText, timeoutMs, this.host.lifetime)
    }
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
  /** Run one stateless, in-memory Watchdog inspection turn with low thinking effort and a pinned static prefix cache key. */
  async runWatchdog(promptText: string, tools: Tool[], timeoutMs = 120_000): Promise<string> {
    await this.ready
    if (this.host.closing()) throw new Error('omp-superagent is stopping')
    const settings = this.host.store.settings()
    const configured = settings.eval.model ?? settings.executor.model
    const version = this.host.prompts.current()
    const customSystemPrompt = `${watchdogPrompt}\n\n${environmentSection(version.config, this.host.watchdogEnvironment?.())}`
    const cwd = this.host.machine.stateDir
    if (this.kernel === 'claude') {
      const options = this.claudeOptions(cwd, tools, customSystemPrompt, configured && { ...configured, thinkingLevel: 'low' }, ['Read', 'Bash'])
      options.effort = configured?.thinkingLevel === 'off' ? 'off' : 'low'
      options.maxTurns = 30
      return runClaudeOnce(options, promptText, timeoutMs, this.host.lifetime, true)
    }
    const model = configured ? this.modelRegistry.find(configured.provider, configured.model) : undefined
    if (configured && !model) throw new Error(`Unknown OMP model: ${configured.provider}/${configured.model}`)
    const thinkingLevel = 'low' as never
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.host.machine.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      agentRegistry: new AgentRegistry(),
      settings: Settings.isolated(ORCHESTRATOR_SETTINGS),
      sessionManager: SessionManager.inMemory(cwd),
      customSystemPrompt,
      noContextFiles: true,
      promptTemplates: [],
      slashCommands: [],
      rules: [],
      skills: [],
      customTools: tools.map(ompTool),
      toolNames: ['read', 'bash', ...tools.map(item => item.name)],
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
    session.agent.promptCacheKey = `watchdog-${key(this.host.machine.stateDir)}`
    const { promise: ended, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => { reject(new Error(`Watchdog turn timed out after ${timeoutMs}ms`)) }, timeoutMs)
    const onAbort = () => { resolve() }
    this.host.lifetime.addEventListener('abort', onAbort, { once: true })
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_end' && event.isTerminal !== false) resolve()
    })
    try {
      await session.sendCustomMessage({ customType: 'omp-superagent-watchdog', content: promptText, display: false, attribution: 'agent' },
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
