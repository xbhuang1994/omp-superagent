/**
 * Independent periodic Watchdog Control Loop (Super-agent §6):
 * filters healthy long-running tasks at zero token cost via `/proc` CPU + workspace file delta telemetry,
 * heals deterministic queue/reply gaps, and runs pre-sampled stateless in-memory inspection turns only when
 * tasks genuinely stall, finish detached work while idle, or hit transient failures.
 */
import { open, readdir, readFile, readlink, stat, type FileHandle } from 'node:fs/promises'
import { join, relative } from 'node:path'
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
  /** Minimum stall duration (zero file/pipe output AND zero CPU delta) before inspecting a working job (default 6 minutes). */
  stallMs?: number
  /** Maximum time a working job may burn CPU without any file/pipe output change before inspection (default 30 minutes). */
  cpuOnlySilenceMs?: number
  /** Minimum cooldown between repeated LLM inspections of the same working ticket (default 10 minutes). */
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
  readonly sessions: Pick<OMPSessions, 'get' | 'relay' | 'transcript' | 'runWatchdog'>
  readonly machine: Pick<Machine, 'stateDir'>
  readonly masterId: string
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  board(): Readonly<Record<RecordKey, Health>>
  configured(): boolean
  closing(): boolean
  paused(): boolean
  requestPass(): void
  now?(): number
}
type RecordKey = string

export interface ProcessSnapshot {
  pid: number
  ppid: number
  state: string
  cpu_ticks: number
  cmd: string
}

export interface WorkspaceFileInfo {
  path: string
  bytes: number
  age_seconds: number
}

export interface SuspectTicket {
  kind: 'long_running_worker' | 'idle_without_followup' | 'delivery_or_transient_failure' | 'unreplied_ticket'
  ticket_id: string
  title: string
  scope: string
  state: string
  directory?: string
  elapsed_seconds?: number
  running_jobs: WorkerJobInfo[]
  process_tree: ProcessSnapshot[]
  activity_delta: { output_changed: boolean; cpu_ticks_delta: number; output_silent_seconds: number }
  recent_files: WorkspaceFileInfo[]
  latest_log_tail?: { file: string; tail: string }
  recent_transcript: { index: number; role: string; at?: string; text: string }[]
  latest_report?: { state: string; at: string; preview: string }
  delivery_error?: string
  previous_patrol_note?: string
}

interface TelemetrySample {
  processes: ProcessSnapshot[]
  totalCpuTicks: number
  recentFiles: WorkspaceFileInfo[]
  latestMtimeMs: number
  outputSig: string
  logTail?: { file: string; tail: string }
}

interface ActivityState {
  outputSig: string
  lastOutputChangeAt: number
  cpuTicks: number
  lastPatrolledAt?: number
  lastPatrolledSig?: string
  lastNote?: string
}

const MAX_AUTO_RETRIES = 2
const MAX_RELAY_NUDGES = 2
const RECENT_WINDOW_MS = 24 * 60 * 60_000
const IGNORED_DIRS: Readonly<Record<string, true>> = {
  '.git': true, '.venv': true, venv: true, node_modules: true, __pycache__: true,
  '.pytest_cache': true, '.ruff_cache': true, '.mypy_cache': true,
}
const LOG_EXT = /\.(?:log|txt|out|err|md|csv|json)$/i

function excerpt(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return ''
  const content = message.content
  if (typeof content === 'string') return content.slice(0, 500)
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return []
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') return [block.text]
    if (block.type === 'toolCall' && 'name' in block && typeof block.name === 'string') {
      const args = 'arguments' in block ? JSON.stringify(block.arguments).slice(0, 240) : ''
      return [`[tool:${block.name}] ${args}`]
    }
    return []
  }).join('\n').slice(0, 500)
}

async function readProcessSnapshot(pid: number): Promise<ProcessSnapshot | undefined> {
  try {
    const rawStat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const endComm = rawStat.lastIndexOf(')')
    if (endComm < 0) return undefined
    const fields = rawStat.slice(endComm + 2).trim().split(/\s+/)
    const state = fields[0] ?? '?'
    const ppid = Number(fields[1] ?? 0)
    const cpuTicks = Number(fields[11] ?? 0) + Number(fields[12] ?? 0)
    const rawCmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
    const cmd = (rawCmd.replaceAll('\0', ' ').trim() || rawStat.slice(rawStat.indexOf('(') + 1, endComm)).slice(0, 180)
    return { pid, ppid, state, cpu_ticks: Number.isFinite(cpuTicks) ? cpuTicks : 0, cmd }
  } catch {
    return undefined
  }
}

async function collectDescendantPids(roots: readonly number[]): Promise<number[]> {
  const visited = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0 && visited.size < 128) {
    const pid = queue.shift()!
    if (pid <= 0 || visited.has(pid)) continue
    visited.add(pid)
    const tasks = await readdir(`/proc/${pid}/task`).catch(() => [])
    for (const tid of tasks) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '')
      for (const token of children.trim().split(/\s+/)) {
        const child = Number(token)
        if (Number.isInteger(child) && child > 0 && !visited.has(child)) queue.push(child)
      }
    }
  }
  return [...visited]
}

async function findDetachedWorkspacePids(directory: string): Promise<number[]> {
  const uid = process.getuid?.()
  const entries = await readdir('/proc').catch(() => [])
  const roots: number[] = []
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      if (uid !== undefined) {
        const info = await stat(`/proc/${pid}`)
        if (info.uid !== uid) continue
      }
      const cwd = await readlink(`/proc/${pid}/cwd`)
      if (cwd === directory || cwd.startsWith(prefix)) roots.push(pid)
    } catch { /* Process exited or belongs to another user. */ }
  }
  return roots
}

async function readTail(filePath: string, maxBytes = 4096, maxLines = 25): Promise<string | undefined> {
  let handle: FileHandle | undefined
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) return undefined
    const length = Math.min(info.size, maxBytes)
    const offset = Math.max(0, info.size - length)
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    return text.split('\n').slice(-maxLines).join('\n').trim() || undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function scanWorkspaceFiles(directory: string | undefined, now: number):
  Promise<{ recentFiles: WorkspaceFileInfo[]; latestMtimeMs: number; totalBytes: number; fileCount: number; logTail?: { file: string; tail: string } }> {
  if (!directory || !await stat(directory).then(info => info.isDirectory(), () => false)) {
    return { recentFiles: [], latestMtimeMs: 0, totalBytes: 0, fileCount: 0 }
  }
  const found: { rel: string; full: string; bytes: number; mtimeMs: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2 || found.length >= 200) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= 200) break
      if (entry.name.startsWith('.') || IGNORED_DIRS[entry.name]) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full).catch(() => undefined)
      if (info) found.push({ rel: relative(directory, full), full, bytes: info.size, mtimeMs: info.mtimeMs })
    }
  }
  await walk(directory, 0)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latestMtimeMs = found[0]?.mtimeMs ?? 0
  const totalBytes = found.reduce((sum, item) => sum + item.bytes, 0)
  const recentFiles = found.slice(0, 8).map(item => ({
    path: item.rel,
    bytes: item.bytes,
    age_seconds: Math.max(0, Math.floor((now - item.mtimeMs) / 1000)),
  }))
  const logCandidate = found.find(item => /\.(?:log|out|err|txt)$/i.test(item.rel)) ?? found.find(item => LOG_EXT.test(item.rel))
  const tail = logCandidate ? await readTail(logCandidate.full) : undefined
  return {
    recentFiles,
    latestMtimeMs,
    totalBytes,
    fileCount: found.length,
    ...(logCandidate && tail ? { logTail: { file: logCandidate.rel, tail } } : {}),
  }
}

/** Builds the inspection and surgical intervention tools exposed exclusively to the Watchdog Session. */
export function watchdogTools(watchdog: Pick<Watchdog, 'inspect' | 'intervene'>): Tool[] {
  return [
    tool({
      name: 'watchdog_inspect',
      description: 'Inspect full ticket inputs, assignments, and extended transcript only when the pre-sampled inline bundle is insufficient.',
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
 * Runs the external Watchdog Control Loop: deterministic `/proc` + workspace delta filtering (zero LLM tokens while jobs
 * advance), deterministic queue/Outbox self-healing, and pre-sampled stateless in-memory Watchdog turns on genuine stalls.
 */
export class Watchdog {
  private readonly intervalMs: number
  private readonly stallMs: number
  private readonly cpuOnlySilenceMs: number
  private readonly longTaskMs: number
  private readonly idleGraceMs: number
  private readonly idleRecheckMs: number
  private readonly unrepliedGraceMs: number
  private readonly turnTimeoutMs: number
  private readonly startedIso: string
  private readonly activity = new Map<string, ActivityState>()
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
    this.stallMs = timings.stallMs ?? Math.min(6 * 60_000, this.longTaskMs)
    this.cpuOnlySilenceMs = timings.cpuOnlySilenceMs ?? Math.max(30 * 60_000, this.longTaskMs)
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
    const transcript = await this.recentTranscript(ticketId, 12)
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
      recent_transcript: transcript,
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
      const { suspects, healthErrors } = await this.collectSuspects(now, stillUnreplied)
      if (!suspects.length && !healthErrors.length) {
        this.host.health.set({ state: 'ready', detail: 'All active tickets and queues are healthy', at: new Date(now).toISOString() })
        return
      }
      const note = await this.runSessionPatrol(now, suspects, healthErrors)
      if (note) {
        for (const item of suspects) {
          const state = this.activity.get(item.ticket_id)
          if (state) state.lastNote = note.slice(0, 200)
        }
      }
      this.host.health.set({ state: 'ready', detail: `Inspected ${suspects.length} suspect ticket(s)`, at: new Date(this.host.now?.() ?? Date.now()).toISOString() })
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

  private async recentTranscript(ticketId: string, count: number): Promise<{ index: number; role: string; at?: string; text: string }[]> {
    const transcript = await this.host.sessions.transcript(ticketId)
    return transcript.flatMap((entry, index) => {
      const text = excerpt(entry)
      if (!text) return []
      const role = entry && typeof entry === 'object' && 'role' in entry && typeof entry.role === 'string' ? entry.role : 'unknown'
      const at = entry && typeof entry === 'object' && 'timestamp' in entry && typeof entry.timestamp === 'number'
        ? new Date(entry.timestamp).toISOString() : undefined
      return [{ index, role, ...(at ? { at } : {}), text }]
    }).slice(-count)
  }

  private async sampleTelemetry(ticket: Ticket, jobs: readonly WorkerJobInfo[], now: number): Promise<TelemetrySample> {
    const directory = ticket.execution?.directory
    const rootPids = jobs.length
      ? jobs.flatMap(job => job.pids ?? [])
      : directory ? await findDetachedWorkspacePids(directory) : []
    const treePids = rootPids.length ? await collectDescendantPids(rootPids) : []
    const snapshots = (await Promise.all(treePids.map(readProcessSnapshot))).flatMap(item => item ? [item] : [])
    const totalCpuTicks = snapshots.reduce((sum, proc) => sum + proc.cpu_ticks, 0)
    const files = await scanWorkspaceFiles(directory, now)
    const pipeSig = jobs.map(job => `${job.id}:${job.progress?.length ?? 0}:${job.progress?.slice(-64) ?? ''}`).join('|')
    const outputSig = `${ticket.updatedAt}|${files.fileCount}:${files.totalBytes}:${Math.floor(files.latestMtimeMs)}|${pipeSig}`
    return {
      processes: snapshots.slice(0, 16),
      totalCpuTicks,
      recentFiles: files.recentFiles,
      latestMtimeMs: files.latestMtimeMs,
      outputSig,
      ...(files.logTail ? { logTail: files.logTail } : {}),
    }
  }

  private async collectSuspects(now: number, lingeringUnreplied: readonly Ticket[]):
    Promise<{ suspects: SuspectTicket[]; healthErrors: { component: string; detail: string; at?: string }[] }> {
    const openTickets = this.host.store.tickets.open()
    const openIds = new Set(openTickets.map(ticket => ticket.id))
    for (const trackedId of this.activity.keys()) if (!openIds.has(trackedId)) this.activity.delete(trackedId)

    const suspects: SuspectTicket[] = []
    const seen = new Set<string>()
    const add = async (
      kind: SuspectTicket['kind'],
      ticket: Ticket,
      jobs: WorkerJobInfo[],
      sample: TelemetrySample,
      delta: { output_changed: boolean; cpu_ticks_delta: number; output_silent_seconds: number },
      elapsedSeconds?: number,
      previousNote?: string,
    ) => {
      if (seen.has(ticket.id)) return
      seen.add(ticket.id)
      const report = latestReport(ticket)
      suspects.push({
        kind,
        ticket_id: ticket.id,
        title: ticket.title,
        scope: ticket.mandate.scope,
        state: ticketCard(ticket).state,
        ...(ticket.execution?.directory ? { directory: ticket.execution.directory } : {}),
        ...(elapsedSeconds !== undefined ? { elapsed_seconds: elapsedSeconds } : {}),
        running_jobs: jobs,
        process_tree: sample.processes,
        activity_delta: delta,
        recent_files: sample.recentFiles,
        ...(sample.logTail ? { latest_log_tail: sample.logTail } : {}),
        recent_transcript: await this.recentTranscript(ticket.id, 6),
        ...(report ? { latest_report: { state: report.state, at: report.at, preview: report.summary.slice(0, 320) } } : {}),
        ...(ticket.delivery ? { delivery_error: ticket.delivery.error } : {}),
        ...(previousNote ? { previous_patrol_note: previousNote } : {}),
      })
    }

    for (const ticket of openTickets) {
      const stage = ticketStage(ticket)
      const running = runningAssignment(ticket)
      const jobs = this.host.executor.runningJobs(ticket.id, now)
      const sample = await this.sampleTelemetry(ticket, jobs, now)
      const prev = this.activity.get(ticket.id)

      if (stage.stage === 'idle' && !ticket.follows?.some(follow => !follow.closed)) {
        const since = Date.parse(running?.report?.at ?? ticket.updatedAt)
        const elapsedMs = Math.max(0, now - (Number.isFinite(since) ? since : now))
        const outputChanged = prev !== undefined && sample.outputSig !== prev.outputSig
        const cpuDelta = prev ? Math.max(0, sample.totalCpuTicks - prev.cpuTicks) : 0
        const lastOutputAt = outputChanged ? now : (prev?.lastOutputChangeAt ?? (sample.latestMtimeMs || since || now))
        const state: ActivityState = {
          outputSig: sample.outputSig,
          lastOutputChangeAt: lastOutputAt,
          cpuTicks: sample.totalCpuTicks,
          lastPatrolledAt: prev?.lastPatrolledAt,
          lastPatrolledSig: prev?.lastPatrolledSig,
          lastNote: prev?.lastNote,
        }
        this.activity.set(ticket.id, state)
        // Detached workspace process actively making file or CPU progress: zero LLM calls needed.
        if (sample.processes.length > 0 && (outputChanged || (cpuDelta > 0 && now - lastOutputAt < this.cpuOnlySilenceMs))) {
          continue
        }
        const unchangedSincePatrol = state.lastPatrolledSig === sample.outputSig && sample.processes.length === 0
        const cooldownMs = unchangedSincePatrol ? this.longTaskMs : this.idleRecheckMs
        if (elapsedMs >= this.idleGraceMs && now - (state.lastPatrolledAt ?? 0) >= cooldownMs) {
          state.lastPatrolledAt = now
          state.lastPatrolledSig = sample.outputSig
          await add('idle_without_followup', ticket, jobs, sample,
            { output_changed: outputChanged, cpu_ticks_delta: cpuDelta, output_silent_seconds: Math.max(0, Math.floor((now - lastOutputAt) / 1000)) },
            Math.floor(elapsedMs / 1000), state.lastNote)
        }
        continue
      }

      if (stage.stage === 'working' && stage.action !== 'queued' && running) {
        const started = Date.parse(running.startedAt ?? ticket.createdAt)
        const startedMs = Number.isFinite(started) ? started : now
        const elapsedMs = Math.max(0, now - startedMs)
        const outputChanged = prev !== undefined && sample.outputSig !== prev.outputSig
        const cpuDelta = prev ? Math.max(0, sample.totalCpuTicks - prev.cpuTicks) : 0
        const baselineOutputAt = Math.max(startedMs, sample.latestMtimeMs)
        const lastOutputAt = outputChanged ? now : (prev?.lastOutputChangeAt ?? baselineOutputAt)
        const silentMs = Math.max(0, now - lastOutputAt)
        const state: ActivityState = {
          outputSig: sample.outputSig,
          lastOutputChangeAt: lastOutputAt,
          cpuTicks: sample.totalCpuTicks,
          lastPatrolledAt: prev?.lastPatrolledAt,
          lastPatrolledSig: prev?.lastPatrolledSig,
          lastNote: prev?.lastNote,
        }
        this.activity.set(ticket.id, state)

        // 0-token fast pass: real file/pipe output changed, or child processes are burning CPU within the silence window.
        if (outputChanged) continue
        if (cpuDelta > 0 && silentMs < this.cpuOnlySilenceMs) continue
        if (silentMs < this.stallMs) continue
        if (now - (state.lastPatrolledAt ?? 0) < this.longTaskMs) continue

        state.lastPatrolledAt = now
        state.lastPatrolledSig = sample.outputSig
        await add('long_running_worker', ticket, jobs, sample,
          { output_changed: false, cpu_ticks_delta: cpuDelta, output_silent_seconds: Math.floor(silentMs / 1000) },
          Math.floor(elapsedMs / 1000), state.lastNote)
        continue
      }

      if (canRetry(ticket) && (ticket.delivery || latestAssignment(ticket)?.report?.state === 'failed')
        && (this.autoRetries.get(ticket.id) ?? 0) < MAX_AUTO_RETRIES
        && this.lastFailureSeen.get(ticket.id) !== ticket.updatedAt) {
        this.lastFailureSeen.set(ticket.id, ticket.updatedAt)
        await add('delivery_or_transient_failure', ticket, jobs, sample,
          { output_changed: false, cpu_ticks_delta: 0, output_silent_seconds: 0 })
      }
    }

    for (const ticket of lingeringUnreplied) {
      const prev = this.activity.get(ticket.id)
      if (now - (prev?.lastPatrolledAt ?? 0) >= this.unrepliedGraceMs) {
        const jobs = this.host.executor.runningJobs(ticket.id, now)
        const sample = await this.sampleTelemetry(ticket, jobs, now)
        this.activity.set(ticket.id, { outputSig: sample.outputSig, lastOutputChangeAt: now, cpuTicks: sample.totalCpuTicks, lastPatrolledAt: now })
        await add('unreplied_ticket', ticket, jobs, sample, { output_changed: false, cpu_ticks_delta: 0, output_silent_seconds: 0 })
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

  private async runSessionPatrol(now: number, suspects: SuspectTicket[], healthErrors: { component: string; detail: string; at?: string }[]): Promise<string> {
    const payload = JSON.stringify({
      kind: 'watchdog_patrol',
      at: new Date(now).toISOString(),
      suspects,
      ...(healthErrors.length ? { health_errors: healthErrors } : {}),
    })
    return this.host.sessions.runWatchdog(payload, watchdogTools(this), this.turnTimeoutMs)
  }
}
