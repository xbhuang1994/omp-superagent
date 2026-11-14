/** Standalone OMP Super Agent composition root and lifecycle. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, type EngineForExecutor, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { policyEffects, policyVersion, SettingsSchema, settingsPolicy, type RoleModel, type Settings as SettingsValue } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { githubKind } from '../sources/github.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { agentVariables, withoutDirectory, workerBin } from '../infra/environment.ts'
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
import type { Health, SourceContext, SourceHost } from '../sources/host.ts'
import { OMPSessions } from './sessions.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { WebPanel } from './web.ts'
import { WeChatBridge } from './wechat.ts'
import { WorkerView } from './workers.ts'
import { ModelSettings } from './model-settings.ts'
import { GithubConnection } from './github-connection.ts'
import { ChatSource } from '../sources/chat.ts'
import { Sidecar } from './sidecar.ts'
import { Watchdog, type WatchdogTimings } from './watchdog.ts'

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
  readonly watchdog: Watchdog
  readonly sidecar: Sidecar
  readonly ready: Promise<void>
  readonly web: WebPanel
  readonly wechat: WeChatBridge
  readonly chat: ChatSource
  readonly masterId: string
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly github: GithubConnection
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private quiet = 0
  private readonly commandEnvironment: Record<string, string | undefined>
  private readonly startup: SettingsValue
  /** The startup JSON's models and GitHub Source as written, before a panel choice replaces them. */
  private readonly written: { models: { eval: RoleModel | null; executor: RoleModel | null; advisor: RoleModel | null }; github: SettingsValue['sources'][string] | null }

  constructor(readonly machine: Machine, startup: SettingsValue = SettingsSchema.parse({}),
    options?: WatchdogTimings & { wechatBurstMs?: number; webBurstMs?: number }) {
    this.startup = structuredClone(SettingsSchema.parse({ paused: startup.paused, sources: startup.sources, policy: startup.policy, eval: startup.eval, executor: startup.executor }))
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { console.warn(`omp-superagent: ${String(error)}`) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // A panel choice holds while the startup JSON still says what it said when the choice was made; a JSON edit wins.
      const written = this.written = { models: { eval: this.startup.eval.model, executor: this.startup.executor.model, advisor: this.startup.executor.advisor },
        github: this.startup.sources.github ?? null }
      const saved = store.settings()
      // The panel's kernel choice holds likewise, until the startup JSON names another kernel than it did.
      const chosen = store.get(KV.runtime.kernel)
      const kernel = chosen && store.get(KV.runtime.startupKernel) === machine.kernel ? chosen : machine.kernel
      // Each kernel has its own model choices: when the startup JSON moves the service to the other kernel, the saved ones change places.
      let held = { eval: saved.eval.model, executor: saved.executor.model, advisor: saved.executor.advisor }
      if (chosen && chosen !== kernel) {
        store.set(KV.runtime.kernelModels(chosen), held)
        held = store.get(KV.runtime.kernelModels(kernel)) ?? { eval: null, executor: null, advisor: null }
      }
      store.set(KV.runtime.kernel, kernel)
      const models = store.get(KV.runtime.startupModels)
      if (models) {
        for (const role of ['eval', 'executor'] as const) {
          if (JSON.stringify(written.models[role]) === JSON.stringify(models[role])) this.startup[role].model = held[role]
        }
        if (JSON.stringify(written.models.advisor) === JSON.stringify(models.advisor ?? null)) this.startup.executor.advisor = held.advisor
      }
      const github = store.get(KV.runtime.startupGithub)
      if (github !== undefined && saved.sources.github && JSON.stringify(written.github) === JSON.stringify(github)) this.startup.sources.github = saved.sources.github
      const path = withoutDirectory(process.env.PATH ?? '', workerBin(machine.stateDir))
      this.commandEnvironment = { ...agentVariables(machine.stateDir), PATH: path }
      const sources = this.sources = new SourceRegistry(() => store.settings(), this.board)
      sources.register(githubKind)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => this.deployment, this.commandEnvironment, this.lifetime)
      const envVariables = () => this.github.deployment ? environmentOf({ deployment: this.github.deployment, sources, settings: store.settings() }) : undefined
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars, envVariables)
      const effects = this.effects = new Effects(store, this.board)
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const sessions = this.sessions = new OMPSessions({ store, prompts, effects, machine: { ...machine, kernel }, masterId, lifetime: this.lifetime,
        closing: () => this.closing(), environment, watchdogEnvironment: envVariables,
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
      this.github = new GithubConnection({ machine, store, lifetime: this.lifetime, path, context: () => this.context(githubKind),
        health: () => this.board.all.github, closing: () => this.closing(), changed: () => sessions.reopenOrchestrator() })
      this.web = new WebPanel(machine.web, masterId, sessions, this.wechat, () => this.resetOrchestrator(), chat, workers, modelSettings, this.github)
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
          if (ended && this.github.deployment) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, this.github.deployment.repository)) outbox.send(message)
          }
        } })
      const evals = this.board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({
        engine: { receive: trigger => engine.receive(trigger), evaluateDue },
        effects, health: this.runtimeHealth, lifetime: this.lifetime,
        configured: () => this.configured(), closing: () => this.closing(),
        burstDelayMs: trigger => trigger.source === 'chat'
          ? (trigger.meta.surface === 'wechat' ? (options?.wechatBurstMs ?? 1800) : (options?.webBurstMs ?? 0)) : 0,
      })
      this.sidecar = new Sidecar({ store, engine, executor: this.executor, effects, sessions, machine,
        paused: () => this.paused(), closing: () => this.closing(), sendReplies: () => outbox.sent() })
      this.watchdog = new Watchdog({ store, engine, executor: this.executor, effects, sessions, machine, masterId,
        health: this.board.claim('watchdog'), lifetime: this.lifetime, board: () => this.board.all,
        configured: () => this.configured(), closing: () => this.closing(), paused: () => this.paused(),
        requestPass: () => { passes.request() } }, options)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), commands, masterId, sessions, sourceLink: link }
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return runtime.deployment }, configured: () => this.configured(), receive: trigger => passes.receive(trigger) }
      this.toolHost = { logger: { warn: message => console.warn(message) }, engine, store, sessions, assessor: this.assessor, resources,
        get github() { return runtime.github.deployment ? runtime.context(githubKind) : undefined }, requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        get wechat() { return runtime.wechat }, enqueueSidecar: payload => { this.sidecar.enqueue(payload) },
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
    if (!this.github.deployment) throw new Error('omp-superagent GitHub deployment is not ready')
    return this.github.deployment
  }
  configured(): boolean { return this.github.deployment !== undefined || this.sources.instance('chat')?.enabled === true }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  links() { return (channel: Parameters<SourceRegistry['link']>[0]) => this.sources.link(channel, { repository: this.github.deployment?.repository }) }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    return ticketEnvironment({ deployment: this.github.deployment, sources: this.sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  async resetOrchestrator(): Promise<void> { await this.sessions.resetOrchestrator() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  private paused(): boolean { return !this.configured() || this.store.settings().paused }

  private async initialize(): Promise<void> {
    await this.github.start(this.startup.sources.github, this.startup.executor.blockedCommands)
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
    // Recorded once the settings they were compared with are saved, so a start that failed before here compares again.
    this.store.set(KV.runtime.startupModels, this.written.models)
    this.store.set(KV.runtime.startupKernel, this.machine.kernel)
    this.store.set(KV.runtime.startupGithub, this.written.github)
    await this.sessions.ready
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'omp-superagent orchestrator', 'orchestrator')
    await this.wechat.start()
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.watchdog.start()
    this.github.watch()
    await this.web.start()
  }

  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    const watcher = this.github.stop()
    const passes = this.passes.stop()
    const watchdog = this.watchdog.stop()
    try {
      this.assessor.stop()
      await Promise.allSettled([watcher, passes, watchdog])
      await this.web.stop()
      await this.wechat.stop()
      await this.sessions.stopAll()
      this.executor.dispose()
      await this.effects.drain()
    } finally {
      this.stopped.abort()
      this.github.restore()
      try { this.store.close() } finally {
        await this.releaseLock?.().catch((error: unknown) => { console.warn(`omp-superagent could not release its state directory lock: ${String(error)}`) })
      }
    }
  }
}
