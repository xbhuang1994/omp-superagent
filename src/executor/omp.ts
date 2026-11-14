/** OMP executor: one persistent worker Session and workspace directory per Ticket. */
import { MAIN_AGENT_ID } from '@oh-my-pi/pi-coding-agent'
import type { KernelSession } from '../kernel/types.ts'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { OMPSessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'

export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
const PREPARE_TIMEOUT_MS = 10 * 60_000
export interface WorkerJobInfo {
  id: string
  type: 'bash' | 'task' | 'eval'
  label: string
  startedAt: string
  elapsedSeconds: number
  progress?: string
  command?: string
  pids?: readonly number[]
}
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/** Workspace prepare failure, which must not be retried automatically. */
class PrepareFailed extends Error {}
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`

export interface ExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'turnEnded' | 'deliveryFailed' | 'report' | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings' | 'atomic' | 'afterCommit'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  readonly sessions: Pick<OMPSessions, 'ensure' | 'get' | 'prompt' | 'relay' | 'holds' | 'stop'>
  closing(): boolean
  paused(): boolean
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo(trigger: Trigger): Trigger | undefined
}

export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}

export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}` : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}

const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }

export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. First judge from the message and this ticket\'s topic alone whether it belongs here; if it does not, hand it back with orchestrator_trigger_handback at once, without inspecting the worktree. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped, with a summary that only says it was handed back and no topic, never the subject of that message. No new work does not mean no reply: '
  + 'for thanks, acknowledgements, or other human follow-ups needing no work, report dropped with reply_to_trigger_id set to that message '
  + 'and a short natural response in summary, so the orchestrator can answer. Report ready when follow-up work is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}

/** Whether the running Assignment's last word hands the ticket to a person: blocked or failed without a newer human message, or ready or a question with no Input since. */
function handedOff(ticket: Ticket): boolean {
  const assignment = runningAssignment(ticket)
  const report = assignment?.report
  if (!report || !assignment) return false
  if (report.state === 'blocked' || report.state === 'failed') return waitsForPerson(ticket)
  const quiet = !assignment.deliveredAt || assignment.deliveredAt < report.at
  return quiet && (report.state === 'ready' || !!ticket.attention)
}

/** Startup reservations plus actual agent_start events enforce worker concurrency. */
export class WorkerSlots {
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/** Executes assignments through OMP terminal events; model retries belong exclusively to OMP. */
export class OMPExecutor implements Executor {
  private readonly runningTickets = new Set<string>()
  private readonly subscriptions = new Map<string, { session: KernelSession; unsubscribe: () => void }>()
  private readonly unloadAfterEnd = new Set<string>()
  private readonly stopping = new Map<string, Promise<void>>()
  /** Shell jobs a worker left to a person at a handoff, by ticket: they run until the Assignment ends and wake no one. */
  private readonly left = new Map<string, Set<string>>()
  private wakeSeq = 0
  private readonly slots: WorkerSlots

  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => [...this.runningTickets], () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(), retry: [5000, 300_000] })
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }

  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }

  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(['sh', '-c', command], dirname(directory), signal, env).catch(async (error: unknown) => {
      await rmdir(directory).catch(() => {})
      throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.lifetime)
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }

  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment) }
    catch (error) {
      this.runningTickets.delete(ticketId)
      if (this.host.closing() || error instanceof Later) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }

  private async deliverQueued(ticketId: string): Promise<void> {
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.runningTickets.has(ticketId)) {
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          const session = this.host.sessions.get(sessionId)
            ?? await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker', ticket)
          this.observe(session, ticketId)
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }

  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      if (this.stopping.has(ticket.id)) throw new Later('The worker Session is stopping')
    }
    live()
    const text = await this.inputText(ticket, input)
    if (text === undefined) return
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }

  /** The message an Input reaches its worker as, a reference to its resource when long; undefined for one that is not sent. */
  private async inputText(ticket: Ticket, input: TicketInput): Promise<string | undefined> {
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return undefined
    return message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
  }

  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy && !ticket.undelivered.length
    this.host.store.afterCommit(() => {
      if (ownTurn && this.runningTickets.has(ticket.id)) {
        this.unloadAfterEnd.add(ticket.id)
        return
      }
      this.unloadAfterEnd.delete(ticket.id)
      this.runningTickets.delete(ticket.id)
      this.left.delete(ticket.id)
      this.stopSession(ticket.id, reason)
    })
  }

  private stopSession(ticketId: string, reason: string): void {
    this.subscriptions.get(ticketId)?.unsubscribe()
    this.subscriptions.delete(ticketId)
    const stopping = this.host.sessions.stop(workerSessionId(ticketId), reason)
    this.stopping.set(ticketId, stopping)
    void stopping.catch((error: unknown) => this.host.health.set({ state: 'error', detail: String(error), at: new Date().toISOString() }))
      .finally(() => { if (this.stopping.get(ticketId) === stopping) this.stopping.delete(ticketId) })
  }

  private async stopped(ticketId: string): Promise<void> { await this.stopping.get(ticketId) }
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.runningTickets.has(ticket.id)).length }

  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.host.sessions.relay(resultRelay(updated, 'failed', summary).id, resultRelay(updated, 'failed', summary).text)
    })
  }

  private observe(session: KernelSession, ticketId: string): void {
    const existing = this.subscriptions.get(ticketId)
    if (existing?.session === session) return
    existing?.unsubscribe()
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_start') {
        this.runningTickets.add(ticketId)
        return
      }
      if (event.type === 'auto_retry_start' && this.unloadAfterEnd.has(ticketId)) {
        this.turnOver(ticketId, session)
        return
      }
      if (event.type !== 'agent_end') return
      if (event.isTerminal !== false) this.turnOver(ticketId, session)
      else if (event.awaitingAsyncWork) this.backgrounded(ticketId, session)
    })
    this.subscriptions.set(ticketId, { session, unsubscribe })
  }

  /** Nothing the worker runs wakes it again: free its slot and report, or unload a ticket that stayed ended meanwhile. */
  private turnOver(ticketId: string, session: KernelSession, note?: string): void {
    this.runningTickets.delete(ticketId)
    if (this.unloadAfterEnd.delete(ticketId)) {
      const current = this.host.store.tickets.get(ticketId)
      if (!current || !liveTicket(current)) {
        this.left.delete(ticketId)
        this.stopSession(ticketId, 'Ticket ended')
        return
      }
    }
    void this.background(this.workerEnded(ticketId, session, note))
  }

  /**
   * The worker's turn ended while its jobs or subagents run; their ends wake it, so it keeps its slot without a blind kill
   * timer (Watchdog inspects long-running jobs semantically). A handoff to a person ends that at once: its subagents stop,
   * and its own shell jobs, such as a server offered for review, run on until the Assignment ends without waking it.
   */
  private backgrounded(ticketId: string, session: KernelSession): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (this.unloadAfterEnd.has(ticketId)) {
      this.turnOver(ticketId, session)
      return
    }
    if (ticket && handedOff(ticket)) {
      this.leaveToPerson(ticketId, session)
      this.turnOver(ticketId, session)
    }
  }
  /** Acknowledged jobs deliver nothing, so neither the jobs left running nor the cancelled ones wake the worker. */
  private leaveToPerson(ticketId: string, session: KernelSession): void {
    const jobs = session.asyncJobManager
    if (!jobs) return
    const running = jobs.getRunningJobs({ ownerId: MAIN_AGENT_ID })
    jobs.acknowledgeDeliveries(running.map(job => job.id))
    const left = this.left.get(ticketId) ?? new Set<string>()
    for (const job of running) {
      if (job.type === 'bash') left.add(job.id)
      else jobs.cancel(job.id)
    }
    this.left.set(ticketId, left)
  }

  /** Live OMP background jobs of `ticketId`'s worker, excluding shell jobs left to a person at a handoff. */
  runningJobs(ticketId: string, now = Date.now()): WorkerJobInfo[] {
    const session = this.host.sessions.get(workerSessionId(ticketId))
    const jobs = session && !session.isDisposed ? session.asyncJobManager : undefined
    if (!jobs) return []
    const left = this.left.get(ticketId)
    return jobs.getRunningJobs({ ownerId: MAIN_AGENT_ID }).filter(job => !left?.has(job.id)).map(job => ({
      id: job.id,
      type: job.type,
      label: job.label.split('\n')[0]!.slice(0, 200),
      startedAt: new Date(job.startTime).toISOString(),
      elapsedSeconds: Math.max(0, Math.floor((now - job.startTime) / 1000)),
      ...(job.progressText ? { progress: job.progressText.slice(-600) } : {}),
      ...(job.process ? { command: job.process.command.slice(0, 300), pids: job.process.pids() } : {}),
    }))
  }

  /** Cancel one hung/off-track background job of `ticketId` and wake its worker with the diagnostic reason. */
  async cancelJob(ticketId: string, jobId: string, reason: string): Promise<boolean> {
    const session = this.host.sessions.get(workerSessionId(ticketId))
    const jobs = session && !session.isDisposed ? session.asyncJobManager : undefined
    const left = this.left.get(ticketId)
    if (!session || !jobs || left?.has(jobId)) return false
    const running = jobs.getRunningJobs({ ownerId: MAIN_AGENT_ID }).filter(job => !left?.has(job.id))
    const target = running.find(job => job.id === jobId)
    if (!target) return false
    jobs.acknowledgeDeliveries([jobId])
    if (!jobs.cancel(jobId)) return false
    const remaining = running.filter(job => job.id !== jobId)
    const note = `[Watchdog] Stopped background job ${jobId} (${target.label.split('\n')[0]}): ${reason}`
      + (remaining.length ? ` Remaining background jobs: ${remaining.map(job => job.id).join(', ')}.` : '')
    await this.wakeAfterCancel(ticketId, session, note, remaining.length > 0)
    return true
  }

  private async wakeAfterCancel(ticketId: string, session: KernelSession, note: string, hasRemaining: boolean): Promise<void> {
    const live = () => {
      if (this.host.closing()) throw new Error('neo-agent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const current = this.host.store.tickets.get(ticketId)
      if (!current || !liveTicket(current) || !runningAssignment(current) || this.unloadAfterEnd.has(ticketId)) {
        throw new Error('The ticket ended before Watchdog wake')
      }
      if (this.stopping.has(ticketId) || session.isDisposed || this.host.sessions.get(workerSessionId(ticketId)) !== session) {
        throw new Error('The worker Session is stopping')
      }
    }
    const current = this.host.store.tickets.get(ticketId)
    const assignment = current && liveTicket(current) ? runningAssignment(current) : undefined
    if (!assignment || this.unloadAfterEnd.has(ticketId) || this.host.closing() || this.host.paused()) {
      if (!hasRemaining && !session.isStreaming) this.turnOver(ticketId, session, note)
      return
    }
    const requestId = key('watchdog-cancel', ticketId, assignment.id, String(++this.wakeSeq))
    const promptText = `${note} Inspect current workspace and logs: recover or continue the remaining work, or call orchestrator_report (ready, blocked, failed or dropped).`
    try {
      await this.host.sessions.prompt(workerSessionId(ticketId), requestId, promptText, 'steer', live)
    } catch (error) {
      if (!hasRemaining && !session.isStreaming) this.turnOver(ticketId, session, note)
      if (!this.host.closing() && !(error instanceof Later)) throw error
    }
  }


  /** `note` adds what the Executor did to the worker's background work to a waiting report. */
  private async workerEnded(ticketId: string, session: KernelSession, note?: string): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (!ticket || !assignment || this.host.closing()) return
    this.host.engine.turnEnded(ticketId, assignment.id)
    const assistant = session.messages.filter(message => message.role === 'assistant').at(-1)
    const text = session.getLastAssistantText()?.trim() ?? ''
    if (assistant?.stopReason === 'error') {
      this.failed(ticketId, text || 'The worker model request failed')
      return
    }
    if (handedOff(ticket)) return
    const report = assignment.report
    const summary = [text || report?.summary, note].filter(Boolean).join('\n\n')
    const reminder = 'Worker ended its turn with no background job running and without a terminal orchestrator_report. '
      + 'If it is not waiting on a bound PR or external event, call orchestrator_ticket_request_status so the worker records its report.'
    const relayText = [summary, reminder].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'waiting', summary })
      const relay = resultRelay(updated, 'waiting', relayText)
      this.host.sessions.relay(relay.id, relay.text)
    })
  }

  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('neo-agent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    await this.stopped(ticket.id)
    if (!current()) return
    this.unloadAfterEnd.delete(ticket.id)
    const sessionId = workerSessionId(ticket.id)
    const existing = this.host.sessions.get(sessionId)
    if (existing && !existing.isStreaming && existing.messages.filter(m => m.role === 'assistant').at(-1)?.stopReason === 'error') {
      await this.host.sessions.stop(sessionId, 'Reset errored worker turn before new Assignment')
      if (!current()) return
    }
    const session = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker', ticket)
    this.observe(session, ticket.id)
    if (!current()) return
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const mandate = mandateInstructions(ticket.mandate)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    const fresh = this.host.store.tickets.get(ticket.id) ?? ticket
    const waitingInputs = later || fresh.undelivered.length
      ? fresh.undelivered.flatMap(id => fresh.inputs.find(input => input.id === id) ?? []) : []
    const waitingText = waitingInputs.length
      ? (await Promise.all(waitingInputs.map(input => this.inputText(fresh, input)))).flatMap(part => part ?? []) : []
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, directory: workspace, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, directory: workspace,
        ...(ticket.execution?.name ? { worktree_name: ticket.execution.name } : {}),
        ...(mandate ? { mandate } : {}), ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, [text, ...waitingText].join('\n\n'), 'steer',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) },
      waitingInputs.length ? waitingInputs.map(item => item.id) : undefined)
  }

  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }

  dispose(): void {
    for (const { unsubscribe } of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
    this.runningTickets.clear()
    this.left.clear()
  }

  private async background(work: Promise<void>): Promise<void> {
    try { await work; this.host.health.set({ state: 'ready', detail: 'Worker events are handled', at: new Date().toISOString() }) }
    catch (error) { this.host.health.set({ state: 'error', detail: String(error), at: new Date().toISOString() }) }
  }
}
