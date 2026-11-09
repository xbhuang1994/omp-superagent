/** Standalone OMP Super Agent composition root and lifecycle. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, type EngineForExecutor, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { policyEffects, policyVersion, SettingsSchema, settingsPolicy, type Settings as SettingsValue } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { githubKind, watch } from '../sources/github.ts'
import { Commands } from '../infra/commands.ts'
import { resolveDeployment, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import { OMPExecutor, sourceTrigger, workerSessionId } from '../executor/omp.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { OMPSessions } from './sessions.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { WebPanel } from './web.ts'
import { WeChatBridge } from './wechat.ts'
import { WorkerView } from './workers.ts'
import { ModelSettings } from './model-settings.ts'
import { ChatSource } from '../sources/chat.ts'

const now = (): string => new Date().toISOString()

/** Owns the standalone GitHub/OMP runtime and its durable lifecycle. */
export class Runtime implements SourceHost {
  readonly store: Store
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: OMPSessions
  readonly executor: OMPExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  readonly web: WebPanel
  readonly wechat: WeChatBridge
  readonly chat: ChatSource
  readonly masterId: string
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly watcherController = new AbortController()
  private watcher?: Promise<void>
  private releaseLock?: () => Promise<void>
  private restoreEnvironment?: () => void
  private resolved?: Deployment
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private quiet = 0
  private readonly commandEnvironment: Record<string, string | undefined>
  private readonly startup: SettingsValue

  constructor(readonly machine: Machine, startup: SettingsValue = SettingsSchema.parse({})) {
    this.startup = structuredClone(SettingsSchema.parse({ paused: startup.paused, sources: startup.sources, policy: startup.policy, eval: startup.eval, executor: startup.executor }))
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { console.warn(`omp-superagent: ${String(error)}`) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const configuredModels = { eval: this.startup.eval.model, executor: this.startup.executor.model }
      const baseline = store.get(KV.runtime.startupModels)
      if (baseline) {
        const saved = store.settings()
        for (const role of ['eval', 'executor'] as const) {
          if (JSON.stringify(configuredModels[role]) === JSON.stringify(baseline[role])) this.startup[role].model = saved[role].model
        }
      }
      store.set(KV.runtime.startupModels, configuredModels)
      const path = withoutDirectory(process.env.PATH ?? '', workerBin(machine.stateDir))
      this.commandEnvironment = { ...agentVariables(machine.stateDir), PATH: path }
      const sources = this.sources = new SourceRegistry(() => store.settings(), this.board)
      sources.register(githubKind)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => this.deployment, this.commandEnvironment, this.lifetime)
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars,
        () => this.resolved ? environmentOf({ deployment: this.resolved, sources, settings: store.settings() }) : undefined)
      const effects = this.effects = new Effects(store, this.board)
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const sessions = this.sessions = new OMPSessions({ store, prompts, effects, machine, masterId, lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        engine: {
          inputsDelivered: (ticketId, assignmentId, inputIds) => this.engine.inputsDelivered(ticketId, assignmentId, inputIds),
          inputsRead: (ticketId, inputIds) => this.engine.inputsRead(ticketId, inputIds),
        },
        tools: (sessionId, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, sessionId) })
      const workers = new WorkerView(store, sessions)
      const chat = this.chat = new ChatSource({ sessions, masterId, receive: trigger => this.receive(trigger),
        deliverWeChat: (id, text, userId) => this.wechat.deliver(id, text, userId) })
      sources.register(chat.kind())
      this.wechat = new WeChatBridge({ store, chat })
      const modelSettings = new ModelSettings(store, sessions)
      this.web = new WebPanel(machine.web, masterId, sessions, this.wechat, () => this.resetOrchestrator(), chat, workers, modelSettings)
      this.executor = new OMPExecutor({ get engine() { return runtime.engine }, store, effects, health: this.board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      const runtime = this
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, machine, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor: this.assessor, executor: this.executor,
        outbox, prepareTicket: (ticket, outcome) => this.executor.prepare(ticket, outcome), emit: event => {
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && this.resolved) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, this.resolved.repository)) outbox.send(message)
          }
        } })
      const evals = this.board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => this.configured(), closing: () => this.closing() })
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), commands, masterId, sessions, sourceLink: link }
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return runtime.deployment }, configured: () => this.configured(), receive: trigger => passes.receive(trigger) }
      this.toolHost = { logger: { warn: message => console.warn(message) }, engine, store, sessions, assessor: this.assessor, resources,
        get github() { return runtime.resolved ? runtime.context(githubKind) : undefined }, requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        get wechat() { return runtime.wechat },
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize().catch(async error => { await this.stop(); throw error })
    } catch (error) {
      try { opened?.close() } finally { release() }
      throw error
    }
  }

  get health(): Readonly<Record<string, Health>> { return this.board.all }
  get lifetime(): AbortSignal { return this.stopped.signal }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error('omp-superagent GitHub deployment is not ready')
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined || this.sources.instance('chat')?.enabled === true }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  links() { return (channel: Parameters<SourceRegistry['link']>[0]) => this.sources.link(channel, { repository: this.resolved?.repository }) }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    return ticketEnvironment({ deployment: this.resolved, sources: this.sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  async resetOrchestrator(): Promise<void> { await this.sessions.resetOrchestrator() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  private paused(): boolean { return !this.configured() || this.store.settings().paused }

  private async initialize(): Promise<void> {
    if (this.startup.sources.github?.enabled) {
      this.resolved = await resolveDeployment(this.machine, this.startup.sources.github.config,
        workerProbe(this.machine.stateDir, this.machine.stateDir, this.lifetime))
      try {
        await writeEnvironment(this.resolved, this.startup.executor.blockedCommands)
        this.restoreEnvironment = applyEnvironment(agentVariables(this.machine.stateDir), this.machine.stateDir, this.commandEnvironment.PATH ?? '')
        await verifyEnvironment(this.resolved, this.lifetime)
      } catch (error) {
        this.restoreEnvironment?.()
        this.restoreEnvironment = undefined
        throw error
      }
    }
    const previous = this.store.settings()
    if (JSON.stringify(previous) !== JSON.stringify(this.startup)) {
      const from = policyVersion(previous), to = policyVersion(this.startup)
      const effects = policyEffects(this.store.tickets.open(), previous, this.startup, () => this.sources)
      this.store.saveSettings(this.startup, { source: 'internal', policyVersion: to, policyChanged: from !== to, notified: [...effects.keys()] })
      if (from !== to) {
        const changed: EngineForSettings['policyChanged'] = (before, after, changes) => this.engine.policyChanged(before, after, changes)
        changed(from, to, effects)
      }
    }
    await this.sessions.ready
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'omp-superagent orchestrator', 'orchestrator')
    await this.wechat.start()
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    if (this.resolved) {
      const source = this.context(githubKind)
      this.watcher = watch(source, this.watcherController.signal)
        .catch((error: unknown) => { source.report('github', { state: 'error', detail: String(error) }) })
    }
    await this.web.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }

  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    this.watcherController.abort()
    const passes = this.passes.stop()
    try {
      this.assessor.stop()
      await Promise.allSettled([...(this.watcher ? [this.watcher] : []), passes])
      await this.web.stop()
      await this.wechat.stop()
      await this.sessions.stopAll()
      this.executor.dispose()
      await this.effects.drain()
    } finally {
      this.stopped.abort()
      this.restoreEnvironment?.()
      this.restoreEnvironment = undefined
      try { this.store.close() } finally {
        await this.releaseLock?.().catch((error: unknown) => { console.warn(`omp-superagent could not release its state directory lock: ${String(error)}`) })
      }
    }
  }
}
