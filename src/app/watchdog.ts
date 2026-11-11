/**
 * Independent periodic Watchdog Control Loop and Watchdog Session (Super-agent §6):
 * heals deterministic infrastructure/reply gaps and asks a dedicated OMP Watchdog Session
 * to judge semantic worker progress on long-running or stranded tickets.
 */
import z from 'zod'
import { canRetry, key, latestAssignment, latestReport, liveTicket, runningAssignment, ticketStage, waitsForPerson,
  type EngineForWatchdog, type Ticket } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import type { Health } from '../sources/host.ts'
import type { HealthEntry } from '../infra/health.ts'
import { assignmentLine, inputLine, newestPage, ticketCard } from './cards.ts'
import type { Effects } from './effects.ts'
import { reportRelay, resultRelay } from './notices.ts'
import type { OMPSessions } from './sessions.ts'
import type { Store } from './store.ts'
import { tool, type Tool } from './tools/tool.ts'
import { workerSessionId, type OMPExecutor, type WorkerJobInfo } from '../executor/omp.ts'

export interface WatchdogTimings {
  /** Periodic control-loop interval (default 3 minutes). */
  intervalMs?: number
  /** Working duration before Watchdog checks semantic progress (default 10 minutes). */
  longTaskMs?: number
  /** Grace period before an idle (`waiting`) ticket without open followed threads is checked (default 60 seconds). */
  idleGraceMs?: number
  /** Recheck interval while an idle (`waiting`) ticket stays unresolved (default 3 minutes). */
  idleRecheckMs?: number
  /** Grace period after a handoff/answer report before nudging a missing Outbox reply (default 60 seconds). */
  unrepliedGraceMs?: number
  /** Maximum duration of one Watchdog Session turn (default 2 minutes). */
  turnTimeoutMs?: number
}

export interface WatchdogHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'receipts' | 'replyStatus' | 'atomic'>
  readonly engine: EngineForWatchdog
  readonly executor: Pick<OMPExecutor, 'start' | 'deliver' | 'runningJobs' | 'cancelJob'>
  readonly effects: Pick<Effects, 'pending'>
  readonly sessions: Pick<OMPSessions, 'ensure' | 'get' | 'prompt' | 'relay' | 'transcript'>
  readonly machine: Pick<Machine, 'stateDir'>
  readonly masterId: string
  readonly watchdogId: string
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  board(): Readonly<Record<string, Health>>
  configured(): boolean
  closing(): boolean
  paused(): boolean
  requestPass(): void
  now?(): number
}

export interface SuspectTicket {
  kind: 'long_running_worker' | 'idle_without_followup' | 'delivery_or_transient_failure' | 'unreplied_ticket'
  ticket_id: string
  title: string
  state: string
  directory?: string
  elapsed_seconds?: number
  running_jobs: WorkerJobInfo[]
  latest_report?: { state: string; at: string; preview: string }
  delivery_error?: string
}

const MAX_AUTO_RETRIES = 2
const MAX_RELAY_NUDGES = 2
const RECENT_WINDOW_MS = 24 * 60 * 60_000

function excerpt(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return ''
  const content = message.content
  if (typeof content === 'string') return content.slice(0, 600)
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return []
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') return [block.text]
    if (block.type === 'toolCall' && 'name' in block && typeof block.name === 'string') {
      const args = 'arguments' in block ? JSON.stringify(block.arguments).slice(0, 300) : ''
      return [`[tool:${block.name}] ${args}`]
    }
    return []
  }).join('\n').slice(0, 600)
}

/** Builds the inspection and surgical intervention tools exposed exclusively to the Watchdog Session. */
export function watchdogTools(watchdog: Pick<Watchdog, 'inspect' | 'intervene'>): Tool[] {
  return [
    tool({
      name: 'watchdog_inspect',
      description: 'Inspect a suspect ticket\'s live session state, running OMP background jobs, recent inputs/assignments, and recent worker transcript.',
      schema: z.object({ ticket_id: z.string().min(1) }).strict(),
      execute: async ({ ticket_id }) => watchdog.inspect(ticket_id),
    }),
    tool({
      name: 'watchdog_intervene',
      description: 'Intervene on a verified anomaly: wake a stranded worker, cancel one hung/off-track background job and wake its worker, retry a transiently failed ticket, or re-relay an unreplied report to the orchestrator.',
      schema: z.object({
        action: z.enum(['wake_worker', 'cancel_job', 'retry_ticket', 'relay_report']),
        ticket_id: z.string().min(1),
        job_id: z.string().min(1).optional().describe('Required for cancel_job: the hung/runaway OMP background job ID.'),
        message: z.string().trim().min(1).max(1000).describe('Concise factual finding or recovery instruction.'),
      }).strict(),
      execute: async args => watchdog.intervene(args),
    }),
  ]
}

/**
 * Runs the external Watchdog Control Loop: deterministic self-healing on every tick (orphaned launches/deliveries and
 * missed Outbox replies) plus demand-driven semantic turns in the persistent Watchdog Session when long-running, idle,
 * or failing tickets need model judgment.
 */
export class Watchdog {
  private readonly intervalMs: number
  private readonly longTaskMs: number
  private readonly idleGraceMs: number
  private readonly idleRecheckMs: number
  private readonly unrepliedGraceMs: number
  private readonly turnTimeoutMs: number
  private readonly startedIso: string
  private readonly lastChecked = new Map<string, number>()
  private readonly lastFailureSeen = new Map<string, string>()
  private readonly lastHealthSeen = new Map<string, string>()
  private readonly relayNudges = new Map<string, number>()
  private readonly autoRetries = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private active?: Promise<void>
  private patrolSeq = 0

  constructor(private readonly host: WatchdogHost, timings: WatchdogTimings = {}) {
    this.intervalMs = timings.intervalMs ?? 3 * 60_000
    this.longTaskMs = timings.longTaskMs ?? 10 * 60_000
    this.idleGraceMs = timings.idleGraceMs ?? 60_000
    this.idleRecheckMs = timings.idleRecheckMs ?? 3 * 60_000
    this.unrepliedGraceMs = timings.unrepliedGraceMs ?? 60_000
    this.turnTimeoutMs = timings.turnTimeoutMs ?? 2 * 60_000
    this.startedIso = new Date(this.host.now?.() ?? Date.now()).toISOString()
    this.host.health.set({ state: 'ready', detail: 'Watchdog control loop is ready', at: this.startedIso })
  }
  start(): void {
    if (this.timer || this.host.closing()) return
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    await Promise.allSettled(this.active ? [this.active] : [])
  }

  /** Run one Watchdog pass; concurrent callers share the in-flight pass. */
  async tick(): Promise<void> {
    if (this.host.closing() || this.host.paused() || !this.host.configured()) return
    if (this.active) return this.active
    const run = this.patrol().finally(() => { if (this.active === run) this.active = undefined })
    this.active = run
    return run
  }

  async inspect(ticketId: string): Promise<Record<string, unknown>> {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new Error(`Unknown ticket: ${ticketId}`)
    const session = this.host.sessions.get(workerSessionId(ticketId))
    const transcript = await this.host.sessions.transcript(ticketId)
    const recent = transcript.flatMap((entry, index) => {
      const text = excerpt(entry)
      if (!text) return []
      const role = entry && typeof entry === 'object' && 'role' in entry && typeof entry.role === 'string' ? entry.role : 'unknown'
      const at = entry && typeof entry === 'object' && 'timestamp' in entry && typeof entry.timestamp === 'number'
        ? new Date(entry.timestamp).toISOString() : undefined
      return [{ index, role, ...(at ? { at } : {}), text }]
    }).slice(-12)
    return {
      ticket: ticketCard(ticket),
      directory: ticket.execution?.directory,
      scope: ticket.mandate.scope,
      follows: ticket.follows ?? [],
      answers_pending: ticket.answers ?? [],
      delivery: ticket.delivery ?? null,
      session: { loaded: !!session, streaming: !!session && !session.isDisposed && session.isStreaming },
      running_jobs: this.host.executor.runningJobs(ticketId, this.host.now?.() ?? Date.now()),
      assignments: newestPage(ticket.assignments, 0, 3, item => assignmentLine(ticket, item), `ticket/${ticketId}/assignments`).items,
      inputs: newestPage(ticket.inputs, 0, 8, input => inputLine(ticket, input, false), `ticket/${ticketId}/inputs`).items,
      recent_transcript: recent,
    }
  }

  async intervene(args: { action: 'wake_worker' | 'cancel_job' | 'retry_ticket' | 'relay_report'; ticket_id: string; job_id?: string; message: string }):
    Promise<Record<string, unknown>> {
    const ticket = this.host.store.tickets.get(args.ticket_id)
    if (!ticket) throw new Error(`Unknown ticket: ${args.ticket_id}`)
    switch (args.action) {
      case 'wake_worker': {
        const woken = this.host.engine.wakeWorker(args.ticket_id, args.message)
        if (woken) this.host.requestPass()
        return { action: args.action, ticket_id: args.ticket_id, woken }
      }
      case 'cancel_job': {
        if (!args.job_id) throw new Error('cancel_job requires job_id')
        const cancelled = await this.host.executor.cancelJob(args.ticket_id, args.job_id, args.message)
        return { action: args.action, ticket_id: args.ticket_id, job_id: args.job_id, cancelled }
      }
      case 'retry_ticket': {
        const used = this.autoRetries.get(args.ticket_id) ?? 0
        if (used >= MAX_AUTO_RETRIES) return { action: args.action, ticket_id: args.ticket_id, retried: false, reason: 'Auto-retry limit reached' }
        if (!canRetry(ticket)) return { action: args.action, ticket_id: args.ticket_id, retried: false, reason: 'Ticket is not retryable' }
        this.autoRetries.set(args.ticket_id, used + 1)
        this.host.engine.retryTicket(args.ticket_id)
        this.host.requestPass()
        return { action: args.action, ticket_id: args.ticket_id, retried: true }
      }
      case 'relay_report': {
        const relayed = this.relayMissing(ticket, true)
        if (relayed) this.host.requestPass()
        return { action: args.action, ticket_id: args.ticket_id, relayed }
      }
    }
  }

  private async patrol(): Promise<void> {
    const now = this.host.now?.() ?? Date.now()
    try {
      this.healQueues()
      const stillUnreplied = this.healUnreplied(now)
      if (this.host.closing() || this.host.paused()) return
      const { suspects, healthErrors } = this.collectSuspects(now, stillUnreplied)
      if (!suspects.length && !healthErrors.length) {
        this.host.health.set({ state: 'ready', detail: 'All active tickets and queues are healthy', at: new Date(now).toISOString() })
        return
      }
      await this.runSessionPatrol(now, suspects, healthErrors)
      this.host.health.set({ state: 'ready', detail: `Inspected ${suspects.length} ticket(s)`, at: new Date(this.host.now?.() ?? Date.now()).toISOString() })
    } catch (error) {
      if (!this.host.closing()) {
        this.host.health.set({ state: 'error', detail: `Watchdog patrol failed: ${String(error)}`, at: new Date(this.host.now?.() ?? Date.now()).toISOString() })
      }
    }
  }

  /** Re-enqueue any pending launch or running delivery whose durable Effect row is absent. */
  private healQueues(): void {
    let changed = false
    for (const ticket of this.host.store.tickets.open()) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running && ticket.undelivered.length > 0 && !waitsForPerson(ticket) && !this.host.effects.pending('delivery', ticket.id)) {
        this.host.executor.deliver(ticket, running)
        changed = true
      } else if (!running && latest?.state === 'pending' && !waitsForPerson(ticket) && !this.host.effects.pending('launch', latest.id)) {
        this.host.executor.start(ticket, latest)
        changed = true
      }
    }
    if (changed) this.host.requestPass()
  }

  /**
   * Deterministic self-heal for tickets whose worker recorded a ready/completed result, open attention question, or human
   * answer, where the orchestrator is idle and no corresponding Outbox receipt exists past the grace window.
   * @returns Tickets that remain unreplied even after deterministic nudges.
   */
  private healUnreplied(now: number): Ticket[] {
    if (this.host.effects.pending('relay') || this.host.sessions.get(this.host.masterId)?.isStreaming) return []
    const lingering: Ticket[] = []
    let nudged = false
    for (const ticket of this.host.store.tickets.list().slice(0, 50)) {
      const missing = this.missingReplyKey(ticket, now)
      if (!missing) continue
      const count = this.relayNudges.get(missing) ?? 0
      if (count < MAX_RELAY_NUDGES) {
        this.relayNudges.set(missing, count + 1)
        if (this.relayMissing(ticket, false, count + 1)) nudged = true
      } else {
        lingering.push(ticket)
      }
    }
    if (nudged) this.host.requestPass()
    return lingering
  }

  private missingReplyKey(ticket: Ticket, now: number): string | undefined {
    if (liveTicket(ticket) && ticket.attention) {
      if (now - Date.parse(ticket.updatedAt) < this.unrepliedGraceMs) return undefined
      if (this.host.store.replyStatus(key('attention-reply', ticket.attention.id)) !== undefined) return undefined
      return `attention:${ticket.id}:${ticket.attention.id}`
    }
    const report = latestReport(ticket)
    if (!report) return undefined
    const age = now - Date.parse(report.at)
    if (age < this.unrepliedGraceMs || age > RECENT_WINDOW_MS) return undefined
    if (ticket.answers?.length && !this.host.store.receipts.repliedSince(ticket.id, report.at)) {
      return `answer:${ticket.id}:${report.at}:${ticket.answers[0]}`
    }
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    if (!origin?.human || !origin.channel) return undefined
    const ready = ticket.ended?.outcome === 'completed' || (liveTicket(ticket) && runningAssignment(ticket)?.report?.state === 'ready')
    if (!ready) return undefined
    if (report.at < this.startedIso && this.host.store.receipts.repliedSince(ticket.id, report.at)) return undefined
    if (this.host.store.receipts.repliedSince(ticket.id, report.at)) return undefined
    return `result:${ticket.id}:${report.at}`
  }

  private relayMissing(ticket: Ticket, manual: boolean, attempt = 1): boolean {
    const tag = manual ? `manual:${++this.patrolSeq}` : `auto:${attempt}`
    if (liveTicket(ticket) && ticket.attention) {
      const report = latestReport(ticket)
      const relay = reportRelay(ticket, { state: report?.state ?? 'progress', summary: report?.summary ?? '', question: ticket.attention.question })
      if (!relay) return false
      this.host.sessions.relay(`watchdog:${relay.id}:${tag}`, relay.text)
      return true
    }
    const report = latestReport(ticket)
    if (!report) return false
    const answerTo = !this.host.store.receipts.repliedSince(ticket.id, report.at) ? ticket.answers?.[0] : undefined
    const state = ticket.ended?.outcome === 'completed' ? 'ready' : report.state
    const relay = resultRelay(ticket, state, report.summary, answerTo)
    this.host.sessions.relay(`watchdog:${relay.id}:${tag}`, relay.text)
    return true
  }

  private collectSuspects(now: number, lingeringUnreplied: readonly Ticket[]):
    { suspects: SuspectTicket[]; healthErrors: { component: string; detail: string; at?: string }[] } {
    const suspects: SuspectTicket[] = []
    const seen = new Set<string>()
    const add = (kind: SuspectTicket['kind'], ticket: Ticket, elapsedSeconds?: number) => {
      if (seen.has(ticket.id)) return
      seen.add(ticket.id)
      const report = latestReport(ticket)
      suspects.push({
        kind,
        ticket_id: ticket.id,
        title: ticket.title,
        state: ticketCard(ticket).state,
        ...(ticket.execution?.directory ? { directory: ticket.execution.directory } : {}),
        ...(elapsedSeconds !== undefined ? { elapsed_seconds: elapsedSeconds } : {}),
        running_jobs: this.host.executor.runningJobs(ticket.id, now),
        ...(report ? { latest_report: { state: report.state, at: report.at, preview: report.summary.slice(0, 240) } } : {}),
        ...(ticket.delivery ? { delivery_error: ticket.delivery.error } : {}),
      })
    }

    for (const ticket of this.host.store.tickets.open()) {
      const stage = ticketStage(ticket)
      const running = runningAssignment(ticket)
      if (stage.stage === 'idle' && !ticket.follows?.some(follow => !follow.closed)) {
        const since = Date.parse(running?.report?.at ?? ticket.updatedAt)
        const elapsedMs = Math.max(0, now - (Number.isFinite(since) ? since : now))
        if (elapsedMs >= this.idleGraceMs && now - (this.lastChecked.get(ticket.id) ?? 0) >= this.idleRecheckMs) {
          this.lastChecked.set(ticket.id, now)
          add('idle_without_followup', ticket, Math.floor(elapsedMs / 1000))
        }
        continue
      }
      if (stage.stage === 'working' && stage.action !== 'queued' && running) {
        const started = Date.parse(running.startedAt ?? ticket.createdAt)
        const elapsedMs = Math.max(0, now - (Number.isFinite(started) ? started : now))
        if (elapsedMs >= this.longTaskMs && now - (this.lastChecked.get(ticket.id) ?? 0) >= this.longTaskMs) {
          this.lastChecked.set(ticket.id, now)
          add('long_running_worker', ticket, Math.floor(elapsedMs / 1000))
        }
        continue
      }
      if (canRetry(ticket) && (ticket.delivery || latestAssignment(ticket)?.report?.state === 'failed')
        && (this.autoRetries.get(ticket.id) ?? 0) < MAX_AUTO_RETRIES
        && this.lastFailureSeen.get(ticket.id) !== ticket.updatedAt) {
        this.lastFailureSeen.set(ticket.id, ticket.updatedAt)
        add('delivery_or_transient_failure', ticket)
      }
    }

    for (const ticket of lingeringUnreplied) {
      if (now - (this.lastChecked.get(ticket.id) ?? 0) >= this.unrepliedGraceMs) {
        this.lastChecked.set(ticket.id, now)
        add('unreplied_ticket', ticket)
      }
    }

    const healthErrors = Object.entries(this.host.board()).flatMap(([component, entry]) => {
      if (component === 'watchdog' || entry.state !== 'error') return []
      const marker = `${entry.at ?? ''}:${entry.detail}`
      if (this.lastHealthSeen.get(component) === marker) return []
      this.lastHealthSeen.set(component, marker)
      return [{ component, detail: entry.detail, ...(entry.at ? { at: entry.at } : {}) }]
    })

    return { suspects, healthErrors }
  }

  private async runSessionPatrol(now: number, suspects: SuspectTicket[], healthErrors: { component: string; detail: string; at?: string }[]): Promise<void> {
    const session = await this.host.sessions.ensure(this.host.watchdogId, this.host.machine.stateDir, 'omp-superagent watchdog', 'watchdog')
    if (this.host.closing() || session.isDisposed) return
    const { promise: ended, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => { reject(new Error(`Watchdog turn timed out after ${this.turnTimeoutMs}ms`)) }, this.turnTimeoutMs)
    const onAbort = () => { resolve() }
    this.host.lifetime.addEventListener('abort', onAbort, { once: true })
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_end' && event.isTerminal !== false) resolve()
    })
    try {
      const requestId = key('watchdog-patrol', String(++this.patrolSeq), String(now))
      const payload = JSON.stringify({ kind: 'watchdog_patrol', at: new Date(now).toISOString(), suspects,
        ...(healthErrors.length ? { health_errors: healthErrors } : {}) })
      await this.host.sessions.prompt(this.host.watchdogId, requestId, payload, 'queue')
      await ended
    } finally {
      clearTimeout(timer)
      this.host.lifetime.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }
}
